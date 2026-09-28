/**
 * 中文全文检索落库（S3-4；设计 §4.7 / §8 门槛 G7）。
 *
 * 选型与语义（依据 G7 探测结论，tools/report/g7-search-probe-device.md）：
 *  - ≥3 字符查询：FTS5 trigram 整串短语匹配 —— 按"串"匹配（含标点、emoji、中英混合），
 *    设备探测召回/精确 100%，无需应用层切词；
 *  - 1–2 字符查询：trigram 语义上无法回答，回退 LIKE 受限扫描（探测 s0 兜底路径），
 *    扫描规模由 maxScanDocs 约束（与内核 InvertedIndex 同一口径）；
 *  - 检索范围默认排除回收站（deleted_at IS NULL）；收件箱为独立表（clipboard_item），
 *    本就不进索引（设计 §4.1）。
 *
 * 契约（与内核 inverted-index.ts 的约定，不得破坏）：
 *  - 输出 SearchHit / Snippet / HighlightRange 同一组类型，高亮为**原文偏移**，
 *    片段构建直接复用内核导出的 buildSnippet（屏幕/朗读/导出三处同一份区间，设计 §4.3）；
 *  - 排序：score 降序，id 升序兜底（确定性）；
 *  - 与内存参考实现的差异（显式登记）：内存版对多词元查询是"词元 AND + 70% 降级"，
 *    落库版按 G7 探测口径取**整串子串语义**（真值 = LIKE 子串），多词查询不再按词拆开。
 *
 * 标题加权（S3-4 新增语义）：查询串在标题中出现时分数加 TITLE_MATCH_BONUS
 * （大于正文命中次数上限，保证标题命中稳定排在正文命中之前）。
 */

import { SearchHit, Snippet, buildSnippet } from '../search/inverted-index';
import { tokenize, tokenizeQuery } from '../search/tokenizer';
import { IRdbExecutor, SqlRow, reqString } from './rdb';

export interface NoteSearchOptions {
  /** 最大返回条数（默认 20） */
  readonly limit?: number;
  /** LIKE 受限扫描的文档数上限（默认 20000，与内核同口径） */
  readonly maxScanDocs?: number;
  /** 片段宽度（默认 40，与内核同口径） */
  readonly snippetRadius?: number;
  /** 仅返回绑定该标签的笔记（标签筛选） */
  readonly tagId?: string;
  /** 仅返回收藏（置顶，同一 pinned 字段）的笔记 */
  readonly favoritesOnly?: boolean;
}

/** 检索命中：内核 SearchHit 契约 + 标题/内容类型（UI 列表渲染与阅读页路由直接可用，免二次查询） */
export interface NoteSearchHit extends SearchHit {
  readonly title: string;
  readonly contentType: string;
}

export const DEFAULT_SEARCH_LIMIT: number = 20;
export const DEFAULT_MAX_SCAN_DOCS: number = 20000;
export const DEFAULT_SNIPPET_RADIUS: number = 40;

/** 标题命中加权分：必须大于正文命中次数上限（100），标题命中才稳定排前 */
export const TITLE_MATCH_BONUS: number = 400;

/** 标题与正文拼接待片段化的分隔符（换行是分词边界，两侧高亮区间互不渗透） */
const TITLE_CONTENT_SEPARATOR: string = '\n';

export interface SearchRepoDeps {
  readonly db: IRdbExecutor;
}

interface Candidate {
  readonly id: string;
  readonly title: string;
  readonly contentMd: string;
  readonly contentType: string;
}

export class SearchRepository {
  constructor(private readonly deps: SearchRepoDeps) {}

  /**
   * 检索。空查询返回空；候选由 SQL 取出后按内核打分口径排序、截断，
   * 仅对最终命中的条目构建高亮片段。
   */
  async search(query: string, options?: NoteSearchOptions): Promise<NoteSearchHit[]> {
    const trimmed: string = query.trim();
    const terms: string[] = tokenizeQuery(trimmed);
    if (terms.length === 0) {
      return [];
    }
    const limit: number = options !== undefined && options.limit !== undefined ? options.limit : DEFAULT_SEARCH_LIMIT;
    if (limit <= 0) {
      return [];
    }
    const maxScanDocs: number =
      options !== undefined && options.maxScanDocs !== undefined ? options.maxScanDocs : DEFAULT_MAX_SCAN_DOCS;
    const radius: number =
      options !== undefined && options.snippetRadius !== undefined ? options.snippetRadius : DEFAULT_SNIPPET_RADIUS;

    const candidates: Candidate[] = await this.fetchCandidates(trimmed, maxScanDocs, options);
    return this.rankAndSnippet(candidates, trimmed, terms, limit, radius);
  }

  /** 重建索引（整库替换等批量场景后调用）：清空 + 从 note 域整批回填 */
  async rebuildIndex(): Promise<void> {
    await this.deps.db.execute(`DELETE FROM note_fts`);
    await this.deps.db.execute(
      `INSERT INTO note_fts (rowid, title, content_md) SELECT rowid, title, content_md FROM note`,
    );
  }

  // ---------------------------------------------------------------------------

  private async fetchCandidates(
    trimmed: string,
    maxScanDocs: number,
    options?: NoteSearchOptions,
  ): Promise<Candidate[]> {
    const params: Array<string | number> = [];
    let sql: string;
    if (Array.from(trimmed).length >= 3) {
      // FTS5 trigram：整串短语（按"串"匹配）。双引号包裹并转义，防查询表达式注入。
      sql =
        `SELECT n.id, n.title, n.content_md, n.content_type FROM note_fts ` +
        `JOIN note n ON n.rowid = note_fts.rowid ` +
        `WHERE note_fts MATCH ? AND n.deleted_at IS NULL`;
      params.push(quotePhrase(trimmed));
    } else {
      // 1–2 字符：LIKE 受限扫描。转义 %/_ 通配符，保证"串"语义与真值口径一致。
      const literal: string = escapeLike(trimmed);
      sql =
        `SELECT n.id, n.title, n.content_md, n.content_type FROM note n ` +
        `WHERE n.deleted_at IS NULL ` +
        `AND (n.title LIKE '%' || ? || '%' ESCAPE '\\' OR n.content_md LIKE '%' || ? || '%' ESCAPE '\\')`;
      params.push(literal, literal);
    }
    if (options !== undefined && options.tagId !== undefined) {
      sql += ` AND n.id IN (SELECT note_id FROM note_tag WHERE tag_id = ?)`;
      params.push(options.tagId);
    }
    if (options !== undefined && options.favoritesOnly === true) {
      sql += ` AND n.pinned = 1`;
    }
    if (sql.indexOf('FROM note_fts') < 0) {
      sql += ` LIMIT ?`;
      params.push(maxScanDocs);
    }

    const rows: SqlRow[] = await this.deps.db.query(sql, params);
    const out: Candidate[] = [];
    for (let i: number = 0; i < rows.length; i++) {
      out.push({
        id: reqString(rows[i], 'id'),
        title: reqString(rows[i], 'title'),
        contentMd: reqString(rows[i], 'content_md'),
        contentType: reqString(rows[i], 'content_type'),
      });
    }
    return out;
  }

  private rankAndSnippet(
    candidates: readonly Candidate[],
    trimmed: string,
    terms: readonly string[],
    limit: number,
    radius: number,
  ): NoteSearchHit[] {
    const queryLower: string = trimmed.toLowerCase();
    const termSet: Set<string> = new Set(terms);

    const scored: NoteSearchHit[] = [];
    for (let i: number = 0; i < candidates.length; i++) {
      const c: Candidate = candidates[i];
      const text: string = c.title + TITLE_CONTENT_SEPARATOR + c.contentMd;
      const lower: string = text.toLowerCase();

      const matchedTerms: string[] = [];
      for (let t: number = 0; t < terms.length; t++) {
        if (lower.indexOf(terms[t]) >= 0) {
          matchedTerms.push(terms[t]);
        }
      }
      const coverage: number = matchedTerms.length / terms.length;

      // 命中词元的出现次数（打分用，上限 100）；同时收集高亮区间所需的词元集合
      let occurrence: number = 0;
      const matchedSpanTerms: Set<string> = new Set<string>();
      const spans = tokenize(text);
      for (let s: number = 0; s < spans.length; s++) {
        const term: string = spans[s].term.toLowerCase();
        if (termSet.has(term)) {
          occurrence++;
          matchedSpanTerms.add(spans[s].term);
        }
      }

      const titleHit: boolean = c.title.toLowerCase().indexOf(queryLower) >= 0;
      const score: number =
        Math.round(coverage * 1000) + Math.min(occurrence, 100) + (titleHit ? TITLE_MATCH_BONUS : 0);
      scored.push({
        id: c.id,
        title: c.title,
        contentType: c.contentType,
        score,
        coverage,
        matchedTerms: matchedTerms.slice().sort(),
        snippet: buildSnippet(text, matchedSpanTerms, radius),
      });
    }

    scored.sort((a: NoteSearchHit, b: NoteSearchHit) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return scored.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// 查询串处理
// ---------------------------------------------------------------------------

/** FTS5 短语引用：整串作为一个短语，内部双引号按 SQL 规则加倍转义 */
function quotePhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

/** LIKE 字面量化：转义 \ % _（配合 ESCAPE '\'），保持"串"语义 */
function escapeLike(query: string): string {
  return query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
