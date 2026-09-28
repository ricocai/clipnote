/**
 * 中文全文检索：内存倒排索引参考实现（设计 §4.7）。
 *
 * 定位（必须说清楚，避免被当成"生产级检索引擎"）：
 *  - 这是**降级方案的可执行参考实现**：RelationalStore 的 FTS5 不可用（G7 探测）时，
 *    首发采用「普通表倒排索引 + 小数据量受限扫描」。
 *  - 本实现的每个决策（分词、召回阈值、排序、高亮映射、单字降级）都与未来落库版本一一对应，
 *    因此它可以作为**契约**：SQL 版本必须复现同样的 `search()` 输入输出语义。
 *  - 内存占用受 `maxDocs` 约束，不做为长期权威存储；权威仍为 SQLite。
 */

import { needsScanFallback, TokenSpan, tokenize } from './tokenizer';

export interface SearchDoc {
  readonly id: string;
  /** 参与检索的纯文本（由 DocumentBlock 抽取，见 markdown.ts） */
  readonly text: string;
}

export interface SearchOptions {
  /** 最大返回条数 */
  readonly limit?: number;
  /** 受限扫描模式的文档数上限（防止单字查询退化为全表大扫描） */
  readonly maxScanDocs?: number;
  /** 片段宽度（原文高亮映射的上下文长度） */
  readonly snippetRadius?: number;
}

export interface HighlightRange {
  readonly start: number;
  readonly end: number;
}

export interface Snippet {
  /** 从原文截取的片段（未做任何转义，渲染层自行决定） */
  readonly text: string;
  /** 片段起始在原文中的偏移，便于整体定位 */
  readonly offset: number;
  /** 相对于 `text` 命中的区间 */
  readonly highlights: HighlightRange[];
}

export interface SearchHit {
  readonly id: string;
  readonly score: number;
  /** 命中的查询词元占比，便于向用户解释排序 */
  readonly coverage: number;
  readonly matchedTerms: readonly string[];
  readonly snippet: Snippet;
}

/** 单文档索引条目 */
interface DocEntry {
  readonly text: string;
  readonly spans: TokenSpan[];
}

const DEFAULT_LIMIT: number = 20;
const DEFAULT_MAX_SCAN_DOCS: number = 20000;
const DEFAULT_SNIPPET_RADIUS: number = 40;

export class InvertedIndex {
  private readonly postings: Map<string, Set<string>> = new Map<string, Set<string>>();
  private readonly docs: Map<string, DocEntry> = new Map<string, DocEntry>();

  get size(): number {
    return this.docs.size;
  }

  /** 索引中的不同词元数（用于观测索引膨胀） */
  get termCount(): number {
    return this.postings.size;
  }

  /** 词元→文档的倒排项总数（用于观测索引膨胀） */
  get postingCount(): number {
    let total: number = 0;
    this.postings.forEach((set: Set<string>) => {
      total += set.size;
    });
    return total;
  }

  put(doc: SearchDoc): void {
    this.remove(doc.id);
    const spans: TokenSpan[] = tokenize(doc.text);
    this.docs.set(doc.id, { text: doc.text, spans });
    for (let i: number = 0; i < spans.length; i++) {
      const term: string = spans[i].term;
      let bucket: Set<string> | undefined = this.postings.get(term);
      if (bucket === undefined) {
        bucket = new Set<string>();
        this.postings.set(term, bucket);
      }
      bucket.add(doc.id);
    }
  }

  remove(id: string): boolean {
    const entry: DocEntry | undefined = this.docs.get(id);
    if (entry === undefined) {
      return false;
    }
    const seen: Set<string> = new Set<string>();
    for (let i: number = 0; i < entry.spans.length; i++) {
      seen.add(entry.spans[i].term);
    }
    seen.forEach((term: string) => {
      const bucket: Set<string> | undefined = this.postings.get(term);
      if (bucket !== undefined) {
        bucket.delete(id);
        if (bucket.size === 0) {
          this.postings.delete(term);
        }
      }
    });
    this.docs.delete(id);
    return true;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  clear(): void {
    this.postings.clear();
    this.docs.clear();
  }

  /**
   * 查询。
   *
   * 召回阈值（明确定义，避免"AND 全中"在长查询下召回为零）：
   *   minMatch = max(1, ceil(termCount * 0.7))
   * 短查询（≤3 词元）等价于 AND；长查询按 70% 覆盖降级召回。
   */
  search(query: string, options?: SearchOptions): SearchHit[] {
    const limit: number = options !== undefined && options.limit !== undefined ? options.limit : DEFAULT_LIMIT;
    const maxScanDocs: number =
      options !== undefined && options.maxScanDocs !== undefined ? options.maxScanDocs : DEFAULT_MAX_SCAN_DOCS;
    const radius: number =
      options !== undefined && options.snippetRadius !== undefined ? options.snippetRadius : DEFAULT_SNIPPET_RADIUS;

    const terms: string[] = this.queryTerms(query);
    if (terms.length === 0 || limit <= 0) {
      return [];
    }
    const minMatch: number = Math.max(1, Math.ceil(terms.length * 0.7));

    // 命中表：docId → 命中的查询词元集合
    const hits: Map<string, Set<string>> = new Map<string, Set<string>>();

    const scanTerms: Set<string> = new Set<string>();
    for (let i: number = 0; i < terms.length; i++) {
      const t: string = terms[i];
      if (needsScanFallback([t])) {
        scanTerms.add(t);
      }
    }

    for (let i: number = 0; i < terms.length; i++) {
      const t: string = terms[i];
      if (scanTerms.has(t)) {
        continue; // 由受限扫描路径负责
      }
      const bucket: Set<string> | undefined = this.postings.get(t);
      if (bucket === undefined) {
        continue;
      }
      bucket.forEach((id: string) => {
        let s: Set<string> | undefined = hits.get(id);
        if (s === undefined) {
          s = new Set<string>();
          hits.set(id, s);
        }
        s.add(t);
      });
    }

    // 受限扫描：单字查询无法由 2-gram 倒排回答，退化为有界顺序扫描
    if (scanTerms.size > 0) {
      let scanned: number = 0;
      this.docs.forEach((entry: DocEntry, id: string) => {
        if (scanned >= maxScanDocs) {
          return;
        }
        scanned++;
        scanTerms.forEach((t: string) => {
          if (entry.text.indexOf(t) >= 0) {
            let s: Set<string> | undefined = hits.get(id);
            if (s === undefined) {
              s = new Set<string>();
              hits.set(id, s);
            }
            s.add(t);
          }
        });
      });
    }

    const results: SearchHit[] = [];
    hits.forEach((matched: Set<string>, id: string) => {
      if (matched.size < minMatch) {
        return;
      }
      const entry: DocEntry | undefined = this.docs.get(id);
      if (entry === undefined) {
        return;
      }
      const coverage: number = matched.size / terms.length;
      const matchedTerms: string[] = Array.from(matched).sort();
      // 排序：先看覆盖率，再看命中点数（出现次数），最后以 id 兜底保证确定性
      const occurrence: number = this.countOccurrences(entry, matched);
      const score: number = Math.round(coverage * 1000) + Math.min(occurrence, 100);
      results.push({
        id,
        score,
        coverage,
        matchedTerms,
        snippet: this.buildSnippet(entry, matched, radius),
      });
    });

    results.sort((a: SearchHit, b: SearchHit) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return results.slice(0, limit);
  }

  private queryTerms(query: string): string[] {
    const spans: TokenSpan[] = tokenize(query.trim());
    const seen: Set<string> = new Set<string>();
    const out: string[] = [];
    for (let i: number = 0; i < spans.length; i++) {
      const t: string = spans[i].term;
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    return out;
  }

  private countOccurrences(entry: DocEntry, matched: ReadonlySet<string>): number {
    let n: number = 0;
    for (let i: number = 0; i < entry.spans.length; i++) {
      if (matched.has(entry.spans[i].term)) {
        n++;
      }
    }
    return n;
  }

  /**
   * 原文高亮映射：给出**原文偏移**，而不是插入标记的字符串。
   * 这样渲染层（ArkUI 或 ArkWeb）可自行决定高亮样式，既避免 XSS，也保证
   * 「屏幕显示 / 朗读 / 导出」三处使用同一份区间（设计 §4.3）。
   *
   * 独立导出：落库版检索（data/search-repository.ts）在拿到 SQL 候选后，
   * 用同一函数从原文构建 Snippet，保证两版高亮契约逐字节一致。
   */
  private buildSnippet(entry: DocEntry, matched: ReadonlySet<string>, radius: number): Snippet {
    return buildSnippet(entry.text, matched, radius);
  }
}

/**
 * 从原文构建高亮片段（`matched` 为命中的词元集合，通常取查询词元；
 * 词元未在原文分词中出现时自然不产出高亮区间，与倒排版行为一致）。
 */
export function buildSnippet(text: string, matched: ReadonlySet<string>, radius: number): Snippet {
  const spans: TokenSpan[] = tokenize(text);
  const ranges: HighlightRange[] = [];
  let firstStart: number = -1;
  for (let i: number = 0; i < spans.length; i++) {
    const span: TokenSpan = spans[i];
    if (!matched.has(span.term)) {
      continue;
    }
    if (firstStart < 0 || span.start < firstStart) {
      firstStart = span.start;
    }
    ranges.push({ start: span.start, end: span.end });
  }
  if (firstStart < 0) {
    const head: string = text.slice(0, radius * 2);
    return { text: head, offset: 0, highlights: [] };
  }
  const merged: HighlightRange[] = mergeRanges(ranges);
  const from: number = Math.max(0, firstStart - radius);
  const to: number = Math.min(text.length, firstStart + radius * 3);
  const snippetText: string = text.slice(from, to);
  const highlights: HighlightRange[] = [];
  for (let i: number = 0; i < merged.length; i++) {
    const r: HighlightRange = merged[i];
    if (r.end <= from || r.start >= to) {
      continue;
    }
    highlights.push({
      start: Math.max(0, r.start - from),
      end: Math.min(snippetText.length, r.end - from),
    });
  }
  return { text: snippetText, offset: from, highlights };
}

/** 合并重叠或相邻区间（2-gram 天然重叠，必须合并后才适合渲染高亮） */
export function mergeRanges(ranges: readonly HighlightRange[]): HighlightRange[] {
  if (ranges.length === 0) {
    return [];
  }
  const sorted: HighlightRange[] = ranges.slice().sort((a: HighlightRange, b: HighlightRange) => a.start - b.start);
  const out: HighlightRange[] = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i: number = 1; i < sorted.length; i++) {
    const cur: HighlightRange = sorted[i];
    const last: HighlightRange = out[out.length - 1];
    if (cur.start <= last.end) {
      if (cur.end > last.end) {
        out[out.length - 1] = { start: last.start, end: cur.end };
      }
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}
