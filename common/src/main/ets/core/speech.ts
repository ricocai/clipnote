/**
 * 朗读文本处理（设计 §4.6 管线前半段）。
 *
 * 修正后的管线顺序（原图 05 的箭头顺序是错的）：
 *   DocumentBlock → 文本规范化 → 按句及长度上限切分（≤300 字，规范化**后**复查长度）→ 合成
 *
 * 本文件只做「规范化 + 切分」，两者都是纯函数、可单测：
 *  - 这是 TTS-0（系统离线引擎）就能验证的部分，不依赖任何端侧模型；
 *  - 切分质量直接决定首包延迟（设计 §4.6 要求低首包延迟），所以必须可测。
 */

/** 默认单段上限（字符数，按码点计）。设计：≤300 字，且在规范化后复查长度 */
export const DEFAULT_SEGMENT_MAX_CHARS: number = 300;

/** 句末标点（中英文） */
const SENTENCE_END_CHARS: string[] = ['。', '！', '？', '；', '…', '!', '?', ';'];

/** 长句二次切分点（优先级由高到低） */
const SOFT_BREAK_CHARS: string[] = ['，', '、', '：', ',', ':', '—', ' '];

/**
 * 英文缩写表：句号出现在这些词之后时**不**视为句末。
 * 这是真实缺陷来源——"e.g. this" 被切成两段会让 TTS 断得莫名其妙。
 */
const ABBREVIATIONS: string[] = [
  'e.g.',
  'i.e.',
  'etc.',
  'vs.',
  'cf.',
  'al.',
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'st.',
  'no.',
  'fig.',
  'eq.',
  'approx.',
  'inc.',
  'ltd.',
  'co.',
  'v1.',
  'v2.',
  'v3.',
];

export interface NormalizeOptions {
  /** 保留换行与连续空白（代码块朗读时使用） */
  readonly preserveWhitespace?: boolean;
}

/** 零宽与排版控制字符（朗读时会让引擎停顿异常） */
const ZERO_WIDTH_RE: RegExp = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** 中英边界插空格的判定 */
function isCjkChar(cp: number): boolean {
  return (cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff);
}

function isLatinLetter(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

/**
 * 文本规范化（朗读用）。
 *
 * 明确**不做**的事（避免"好心办坏事"）：
 *  - 不把 `50%` 改写成"百分之五十"：主流中文 TTS 已正确处理，改写反而可能双重朗读；
 *  - 不改写金额/单位：同上，端侧引擎的文本前端能力随版本变化，硬编码规则会随版本退化。
 * 明确**要做**的事：
 *  - 日期与时间改写（`2026-09-28` → `2026年9月28日`、`12:59` → `12点59分`），
 *    因为连字符与冒号被读成"减号/比"是跨引擎的稳定错误；
 *  - 中英边界插空格，帮助引擎正确分词（"用ArkTS写的" → "用 ArkTS 写的"）；
 *  - 清理零宽字符与多余空白。
 */
export function normalizeForSpeech(text: string, options?: NormalizeOptions): string {
  const preserveWhitespace: boolean = options !== undefined && options.preserveWhitespace === true;
  let out: string = text;
  out = out.replace(ZERO_WIDTH_RE, '');
  out = out.replace(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g, (_m: string, y: string, mo: string, d: string) => {
    return `${y}年${stripLeadingZero(mo)}月${stripLeadingZero(d)}日`;
  });
  out = out.replace(/(\d{1,2}):(\d{2})(?!\d)/g, (_m: string, h: string, mi: string) => `${stripLeadingZero(h)}点${mi}分`);
  out = insertCjkLatinSpacing(out);
  if (preserveWhitespace) {
    return out;
  }
  return out
    .split('\n')
    .map((line: string) => line.trim())
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripLeadingZero(value: string): string {
  if (value.length <= 1) {
    return value;
  }
  return value.charAt(0) === '0' ? value.slice(1) : value;
}

function insertCjkLatinSpacing(text: string): string {
  const chars: string[] = Array.from(text);
  let out: string = '';
  for (let i: number = 0; i < chars.length; i++) {
    const cur: string = chars[i];
    const cp: number = cur.codePointAt(0) as number;
    if (i > 0) {
      const prev: string = chars[i - 1];
      const prevCp: number = prev.codePointAt(0) as number;
      // 只在「汉字 ↔ 拉丁字母」边界插空格；数字与汉字之间（如 3.5 亿元、2026 年）
      // 保持紧邻，否则会把中文数字+单位读成两段。
      const cjkBoundary: boolean =
        (isCjkChar(prevCp) && isLatinLetter(cp)) || (isLatinLetter(prevCp) && isCjkChar(cp));
      if (cjkBoundary) {
        out += ' ';
      }
    }
    out += cur;
  }
  return out;
}

export interface SpeechSegment {
  readonly index: number;
  readonly text: string;
  /** 该段在规范化文本中的字符偏移，用于"按实际播放进度"回映射到文档块（设计 §4.6） */
  readonly startOffset: number;
  readonly endOffset: number;
  readonly charCount: number;
}

/**
 * 按句切分并施加长度上限。规范化**之后**再调用本函数（设计 §4.6 明确顺序）。
 *
 * 切分规则：
 *  ① 句末标点切分（。！？；…!?;），但句号在缩写或小数之后时不切；
 *  ② 单句超过 maxChars 时，就近在 `，、：,` 或空格处二次切分；
 *  ③ 仍超长（无任何软切点，如超长 URL、无标点长串）硬切，保证有界内存与低首包延迟。
 */
export function splitForSpeech(
  normalizedText: string,
  maxChars: number = DEFAULT_SEGMENT_MAX_CHARS,
): SpeechSegment[] {
  const limit: number = maxChars > 0 ? maxChars : DEFAULT_SEGMENT_MAX_CHARS;
  const sentences: Array<{ text: string; start: number; end: number }> = splitSentences(normalizedText);
  const segments: SpeechSegment[] = [];
  let index: number = 0;

  for (let i: number = 0; i < sentences.length; i++) {
    const s: { text: string; start: number; end: number } = sentences[i];
    const charCount: number = Array.from(s.text).length;
    if (charCount <= limit) {
      segments.push({ index: index++, text: s.text, startOffset: s.start, endOffset: s.end, charCount });
      continue;
    }
    const pieces: Array<{ text: string; start: number; end: number }> = splitLongSentence(s.text, s.start, limit);
    for (let p: number = 0; p < pieces.length; p++) {
      const piece: { text: string; start: number; end: number } = pieces[p];
      const cc: number = Array.from(piece.text).length;
      if (piece.text.trim().length === 0) {
        continue;
      }
      segments.push({ index: index++, text: piece.text, startOffset: piece.start, endOffset: piece.end, charCount: cc });
    }
  }
  return segments;
}

function splitSentences(text: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  let start: number = 0;
  let i: number = 0;
  const n: number = text.length;

  while (i < n) {
    const cp: number = text.codePointAt(i) as number;
    const width: number = cp > 0xffff ? 2 : 1;
    const ch: string = text.slice(i, i + width);

    if (ch === '\n') {
      const piece: string = text.slice(start, i);
      if (piece.trim().length > 0) {
        out.push({ text: piece, start, end: i });
      }
      i += width;
      start = i;
      continue;
    }

    if (isSentenceEnd(ch)) {
      let boundary: boolean = true;
      if (ch === '.') {
        boundary = isRealPeriodBoundary(text, i);
      }
      // 连续的句末标点（如 "？！"）应合并为一次切分
      let end: number = i + width;
      while (end < n) {
        const nextCp: number = text.codePointAt(end) as number;
        const nextWidth: number = nextCp > 0xffff ? 2 : 1;
        const nextCh: string = text.slice(end, end + nextWidth);
        if (nextCh === '"' || nextCh === '」' || nextCh === '』' || nextCh === '）' || nextCh === ')' || nextCh === '”') {
          end += nextWidth;
          continue;
        }
        if (isSentenceEnd(nextCh) && nextCh !== '.') {
          end += nextWidth;
          continue;
        }
        break;
      }
      if (boundary) {
        const piece: string = text.slice(start, end);
        if (piece.trim().length > 0) {
          out.push({ text: piece.trim(), start, end });
        }
        start = end;
        i = end;
        continue;
      }
    }
    i += width;
  }

  const tail: string = text.slice(start);
  if (tail.trim().length > 0) {
    out.push({ text: tail.trim(), start, end: n });
  }
  return out;
}

function isSentenceEnd(ch: string): boolean {
  for (let i: number = 0; i < SENTENCE_END_CHARS.length; i++) {
    if (SENTENCE_END_CHARS[i] === ch) {
      return true;
    }
  }
  return ch === '.';
}

/** 判断英文句点是否真的是句末（排除小数、缩写、域名） */
function isRealPeriodBoundary(text: string, dotIndex: number): boolean {
  const prev: string = dotIndex > 0 ? text.charAt(dotIndex - 1) : '';
  const next: string = dotIndex + 1 < text.length ? text.charAt(dotIndex + 1) : '';
  // 小数：两侧都是数字
  if (isDigitChar(prev) && isDigitChar(next)) {
    return false;
  }
  // 版本号/域名等：句点后紧跟非空白字符且前文是字母 → 视为缩写或标识符内部
  if (next.length > 0 && next !== ' ' && next !== '\n' && next !== '"' && next !== ')' && next !== '。') {
    return false;
  }
  const lower: string = text.slice(0, dotIndex + 1).toLowerCase();
  for (let i: number = 0; i < ABBREVIATIONS.length; i++) {
    const abbr: string = ABBREVIATIONS[i];
    if (lower.endsWith(abbr)) {
      return false;
    }
  }
  return true;
}

function isDigitChar(ch: string): boolean {
  if (ch.length === 0) {
    return false;
  }
  const cp: number = ch.codePointAt(0) as number;
  return cp >= 0x30 && cp <= 0x39;
}

function splitLongSentence(
  sentence: string,
  baseOffset: number,
  limit: number,
): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const chars: string[] = Array.from(sentence);
  let cursor: number = 0;

  while (cursor < chars.length) {
    const remaining: number = chars.length - cursor;
    if (remaining <= limit) {
      out.push({
        text: chars.slice(cursor).join(''),
        start: baseOffset + cursor,
        end: baseOffset + chars.length,
      });
      break;
    }
    // 优先在软切点切，且在 [limit/2, limit] 区间内从后往前找
    let cut: number = -1;
    for (let i: number = limit; i >= Math.floor(limit / 2); i--) {
      const ch: string = chars[cursor + i - 1];
      if (isSoftBreak(ch)) {
        cut = i;
        break;
      }
    }
    if (cut < 0) {
      cut = limit; // 无软切点：硬切，保证有界
    }
    out.push({
      text: chars.slice(cursor, cursor + cut).join(''),
      start: baseOffset + cursor,
      end: baseOffset + cursor + cut,
    });
    cursor += cut;
  }
  return out;
}

function isSoftBreak(ch: string): boolean {
  if (ch === undefined) {
    return false;
  }
  for (let i: number = 0; i < SOFT_BREAK_CHARS.length; i++) {
    if (SOFT_BREAK_CHARS[i] === ch) {
      return true;
    }
  }
  return false;
}
