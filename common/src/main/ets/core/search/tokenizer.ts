/**
 * 检索分词器（设计 §4.7）。
 *
 * 设计把中文搜索拆成三个**独立**问题，本文件只负责第 2、3 项：
 *   ① FTS5 可用性 —— 平台探测（tools/probes/g7-search.ts）
 *   ② 中文切词 —— 应用层生成 n-gram 后索引（这里用 2-gram）
 *   ③ 短查询与特殊文本 —— 单字 / 混合英文 / 数字 / 标点 / 简繁体 / emoji 单独处理
 *
 * 已知限制（必须显式登记，不得用"支持中文搜索"一句话掩盖）：
 *  - **简繁不互通**：不做繁简归一化，因此「笔记」检索不到「筆記」。
 *    补齐需要 OpenCC 之类词表；在内核里内嵌大词表会撑大包体，列为后续专项。
 *  - **单字查询不支持倒排**：2-gram 无法直接回答单字，走受限扫描降级路径（见 inverted-index.ts）。
 */

/** 词元及其在原文中的位置，用于"原文高亮映射"（设计 §4.7 要求定义高亮映射） */
export interface TokenSpan {
  readonly term: string;
  readonly start: number;
  readonly end: number;
  /** 是否为降级扫描产出的单字词元 */
  readonly singleChar: boolean;
}

/** 单文档索引词元上限，防止超长正文把索引撑爆 */
export const MAX_TOKENS_PER_DOC: number = 8192;

/** 单个词元最大长度（ASCII 单词）：超长按前 N 字符截断为前缀词元 */
const MAX_ASCII_TERM_LENGTH: number = 64;

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // 日文假名
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 基本区
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意
    (cp >= 0xac00 && cp <= 0xd7af) || // 韩文音节
    (cp >= 0x20000 && cp <= 0x2fa1f) // 扩展 B~F
  );
}

function isAsciiWordChar(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) || // 0-9
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    (cp >= 0x61 && cp <= 0x7a) || // a-z
    cp === 0x5f || // _
    cp === 0x2b || // +
    cp === 0x23 // #
  );
}

/**
 * 是否需要"受限扫描"降级。
 *
 * 只有**单个 CJK 码点**才需要：索引只在「孤立单字成段」时才产出单字词元，
 * 因此它的倒排表是**不完整**的，不能直接用来回答单字查询。
 * 反例说明（避免过度降级）：
 *  - 单个 ASCII 字符（如 `a`）：按"整词匹配"语义，倒排表是完整的，无需扫描；
 *  - emoji / 全角符号：索引对每个码点都产出词元，倒排表同样是完整的。
 */
export function needsScanFallback(queryTerms: readonly string[]): boolean {
  for (let i: number = 0; i < queryTerms.length; i++) {
    const t: string = queryTerms[i];
    if (t.length === 0) {
      continue;
    }
    const cps: string[] = Array.from(t);
    if (cps.length === 1 && isCjkCodePoint(t.codePointAt(0) as number)) {
      return true;
    }
  }
  return false;
}

/**
 * 分词：产出带位置的词元流。
 *  - ASCII 词：整词小写（`httpx2` 之类保持原样）
 *  - CJK 连续段：长度 1 → 单字词元；长度 ≥2 → 全部 2-gram + 整段词元
 *  - 其它码点（emoji、全角符号等）：每个码点一个词元，使 emoji 可检索
 *  - 标点与空白：不作为词元（也不生成跨标点的 gram，避免"甲。乙"被切成"甲乙"）
 */
export function tokenize(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  const n: number = text.length;
  let i: number = 0;
  let emitted: number = 0;

  while (i < n && emitted < MAX_TOKENS_PER_DOC) {
    const cp: number = text.codePointAt(i) as number;
    const charLen: number = cp > 0xffff ? 2 : 1;

    if (isAsciiWordChar(cp)) {
      const start: number = i;
      while (i < n) {
        const c: number = text.codePointAt(i) as number;
        if (!isAsciiWordChar(c)) {
          break;
        }
        i += c > 0xffff ? 2 : 1;
      }
      let term: string = text.slice(start, i).toLowerCase();
      if (term.length > MAX_ASCII_TERM_LENGTH) {
        term = term.slice(0, MAX_ASCII_TERM_LENGTH);
      }
      spans.push({ term, start, end: i, singleChar: false });
      emitted++;
      continue;
    }

    if (isCjkCodePoint(cp)) {
      const start: number = i;
      while (i < n) {
        const c: number = text.codePointAt(i) as number;
        if (!isCjkCodePoint(c)) {
          break;
        }
        i += c > 0xffff ? 2 : 1;
      }
      const run: string = text.slice(start, i);
      const units: string[] = Array.from(run);
      if (units.length === 1) {
        // 孤立单字成段：产出单字词元（注意其倒排表不完整，见 needsScanFallback 说明）
        spans.push({ term: units[0], start, end: i, singleChar: true });
        emitted++;
      } else {
        // 只产出 2-gram，**不**产出整段词元：
        // 查询侧同样只产出 gram，因此「全 gram 命中」等价于"该连续片段出现"，
        // 既保证短语精确性（gram 重叠 → 连续），又不让索引为长句付出额外体积。
        let offset: number = start;
        for (let u: number = 0; u + 1 < units.length; u++) {
          const a: string = units[u];
          const b: string = units[u + 1];
          const w: number = a.length + b.length;
          spans.push({ term: a + b, start: offset, end: offset + w, singleChar: false });
          emitted++;
          offset += a.length;
          if (emitted >= MAX_TOKENS_PER_DOC) {
            break;
          }
        }
      }
      continue;
    }

    // 其它可见码点：emoji / 全角字母数字 / 少见符号（含 U+2000 以上的各种符号）
    const isSpace: boolean = cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x3000;
    const isPunct: boolean = isAsciiPunctuation(cp) || isCjkPunctuation(cp);
    if (!isSpace && !isPunct) {
      const rawTerm: string = text.slice(i, i + charLen);
      spans.push({ term: rawTerm, start: i, end: i + charLen, singleChar: true });
      emitted++;
    }
    i += charLen;
  }

  return spans;
}

function isAsciiPunctuation(cp: number): boolean {
  if (cp >= 0x21 && cp <= 0x2f) {
    return true;
  }
  if (cp >= 0x3a && cp <= 0x40) {
    return true;
  }
  if (cp >= 0x5b && cp <= 0x60) {
    return true;
  }
  if (cp >= 0x7b && cp <= 0x7e) {
    return true;
  }
  return false;
}

function isCjkPunctuation(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
    (cp >= 0xff00 && cp <= 0xff0f) ||
    (cp >= 0xff1a && cp <= 0xff20) ||
    (cp >= 0xff3b && cp <= 0xff40) ||
    (cp >= 0xff5b && cp <= 0xff65) ||
    (cp >= 0x2010 && cp <= 0x2027)
  );
}

/** 仅取词元字符串（索引键），保持出现顺序 */
export function termsOf(text: string): string[] {
  const spans: TokenSpan[] = tokenize(text);
  const out: string[] = [];
  for (let i: number = 0; i < spans.length; i++) {
    out.push(spans[i].term);
  }
  return out;
}

/** 查询分词：去重且保序 */
export function tokenizeQuery(query: string): string[] {
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
