/**
 * 朗读段规划（S5-2；设计 §4.6 管线的「文档块 → 文本规范化 → 按句及长度上限切分」落点）。
 *
 * 把 common 的两个纯函数（normalizeForSpeech / splitForSpeech）接到 DocumentBlock[] 上：
 * 每个可朗读块先规范化，块间以 '\n' 拼接后整体切分——'\n' 是 splitForSpeech 的硬边界，
 * 因此**段永远不跨块**，每段可唯一回映射到块下标（段落级高亮锚点，设计 §4.6）。
 *
 * 纯函数、零 @kit.*，本机 node 全量验证。
 *
 * 可朗读性口径（刻意保守，不私自扩设计范围）：
 *  - heading / paragraph / list_item / quote：块纯文本（model.ts 口径）；
 *  - code：保留原始缩进朗读（normalizeForSpeech 的 preserveWhitespace 即为此准备），
 *    fence 围栏行与语言标签不入文本（与 reader.js codeParts 同一剥离口径）；
 *  - image：朗读 alt 文本（无 alt 跳过）；
 *  - table：块 text 是整段表格原文（含 | 分隔符），朗读体验无定义，**跳过**；
 *  - thematic_break / raw：跳过（model.ts 枚举注释已注明 raw「不高亮、不朗读」）。
 */

import { BlockType, DocumentBlock, SpeechSegment, normalizeForSpeech, splitForSpeech } from 'common';

/** 一条待发朗读段：段文本 + 高亮锚点（块下标） */
export interface SpeechPlanItem {
  readonly segment: SpeechSegment;
  /** 该段所在块在入参 DocumentBlock[] 中的下标（渲染页 data-cl-i 同源） */
  readonly blockIndex: number;
}

/** 一篇文档的朗读计划 */
export interface SpeechPlan {
  readonly items: readonly SpeechPlanItem[];
  /** 全部段的字符总数（进度分母） */
  readonly totalChars: number;
  /** 实际参与朗读的块数（被跳过的块不计） */
  readonly speakableBlocks: number;
}

export interface SpeechPlanOptions {
  /** 单段字符上限；默认走 common 的 DEFAULT_SEGMENT_MAX_CHARS（≤300 字，设计 §4.6） */
  maxCharsPerSegment?: number;
  /** 是否朗读代码块；默认 true（preserveWhitespace 口径） */
  includeCode?: boolean;
}

/** 块 → 规范化朗读文本；不可朗读/空块返回 undefined */
function speechTextOf(
  block: DocumentBlock,
  markdown: string,
  includeCode: boolean,
): { text: string; preserveWhitespace: boolean } | undefined {
  switch (block.type) {
    case BlockType.HEADING:
    case BlockType.PARAGRAPH:
    case BlockType.LIST_ITEM:
    case BlockType.QUOTE:
      return { text: block.text, preserveWhitespace: false };
    case BlockType.CODE:
      if (!includeCode) {
        return undefined;
      }
      return { text: stripFence(block, markdown), preserveWhitespace: true };
    case BlockType.IMAGE:
      // alt 文本即块 text；为空（裸 ![](/x)）没有可朗读内容
      return block.text.trim().length > 0 ? { text: block.text, preserveWhitespace: false } : undefined;
    case BlockType.TABLE:
    case BlockType.THEMATIC_BREAK:
    case BlockType.RAW:
    default:
      return undefined;
  }
}

/** fence 围栏剥离：与 entry reader.js codeParts 同口径（首行 ```lang 与收尾围栏不入文本） */
function stripFence(block: DocumentBlock, markdown: string): string {
  const slice: string = markdown.slice(block.range.startOffset, block.range.endOffset);
  const lines: string[] = slice.split('\n');
  if (lines.length > 0 && lines[0].indexOf('```') === 0) {
    lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    if (lines.length > 0 && /^`{3,}\s*$/.test(lines[lines.length - 1].trim())) {
      lines.pop();
    }
  }
  return lines.join('\n');
}

interface Part {
  readonly text: string;
  readonly blockIndex: number;
  /** 该部分在拼接文本中的起始偏移（UTF-16 code unit，与 splitForSpeech 口径一致） */
  readonly start: number;
  readonly end: number;
}

/**
 * DocumentBlock[] → 朗读计划。
 *
 * blockIndex 与入参数组下标严格一致：调用方（阅读页）渲染用的就是同一个数组，
 * 高亮时直接拿 blockIndex 找 DOM 锚点，不做二次映射。
 */
export function planSpeech(
  blocks: readonly DocumentBlock[],
  markdown: string,
  options?: SpeechPlanOptions,
): SpeechPlan {
  const includeCode: boolean = options === undefined || options.includeCode !== false;
  const parts: Part[] = [];
  let offset: number = 0;

  for (let i: number = 0; i < blocks.length; i++) {
    const spec: { text: string; preserveWhitespace: boolean } | undefined = speechTextOf(blocks[i], markdown, includeCode);
    if (spec === undefined) {
      continue;
    }
    const normalized: string = normalizeForSpeech(spec.text, { preserveWhitespace: spec.preserveWhitespace });
    if (normalized.length === 0) {
      continue;
    }
    // 块间 '\n' 分隔：splitForSpeech 的硬边界，段不跨块
    const start: number = offset;
    offset += normalized.length + 1;
    parts.push({ text: normalized, blockIndex: i, start, end: start + normalized.length });
  }

  if (parts.length === 0) {
    return { items: [], totalChars: 0, speakableBlocks: 0 };
  }

  const concatenated: string = parts.map((p: Part) => p.text).join('\n');
  const segments: SpeechSegment[] = splitForSpeech(
    concatenated,
    options === undefined || options.maxCharsPerSegment === undefined ? undefined : options.maxCharsPerSegment,
  );

  const items: SpeechPlanItem[] = [];
  let totalChars: number = 0;
  for (let s: number = 0; s < segments.length; s++) {
    const seg: SpeechSegment = segments[s];
    // 段不跨块（'\n' 硬边界）→ 起始偏移落在唯一 part 内
    const part: Part | undefined = partAt(parts, seg.startOffset);
    if (part === undefined) {
      continue; // 防御：找不到归属的段不播（理论不可达）
    }
    items.push({ segment: seg, blockIndex: part.blockIndex });
    totalChars += seg.charCount;
  }
  return { items, totalChars, speakableBlocks: parts.length };
}

/** 按起始偏移找归属 part（parts 有序且不相交） */
function partAt(parts: readonly Part[], offset: number): Part | undefined {
  for (let i: number = 0; i < parts.length; i++) {
    const p: Part = parts[i];
    if (offset >= p.start && offset < p.end) {
      return p;
    }
  }
  return undefined;
}
