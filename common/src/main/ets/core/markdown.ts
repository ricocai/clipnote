/**
 * Markdown 单一解析入口（设计 §4.3）：
 *
 *   一期以 markdown-it 为唯一语法入口，解析一次产出轻量 `DocumentBlock`：
 *   块类型、源范围、文本、附件引用、文档 revision。
 *   渲染、朗读文本提取、高亮映射、导出**全部复用块模型**。
 *
 * 两个刻意的设计决定：
 *  1. **不直接 import markdown-it**，而是注入 `IMarkdownTokenizer`。
 *     一期解析运行在 ArkWeb（Web 引擎）内，ArkTS 侧无法直接引用 npm 包；
 *     设计 §4.3 明确要求"定义桥接 Schema 与解析缓存导入，不假定 ArkTS 与浏览器 JS 运行时等价"。
 *     注入后：本机测试注入真实 markdown-it（算法被真实验证过），
 *     鸿蒙侧由 Web 上下文注入同一个库，两边共享同一份块构建逻辑。
 *  2. **未覆盖语法降级为 RAW**，保留原文而不猜测语义（设计 §6 风险 12 的缓解）。
 */

import { BlockType, DocumentBlock, SourceRange } from './model';
import { blobRelativePath, isSha256Hex } from './blob-cas';

/** markdown-it Token 的最小结构（只声明真正读取的字段，避免绑定版本细节） */
export interface MdToken {
  readonly type: string;
  readonly tag: string;
  readonly nesting: number;
  readonly map: number[] | null;
  readonly level: number;
  readonly content: string;
  readonly markup: string;
  readonly info: string;
  readonly children: MdToken[] | null;
  /** 形如 [['src','...'],['alt','...']]；markdown-it 的 Token.attrs 同构 */
  readonly attrs?: string[][];
}

/** 解析器桥接接口：ArkWeb 内由 markdown-it 实现 */
export interface IMarkdownTokenizer {
  /** 产出**块级** token 流（含 inline token 及其 children） */
  parse(source: string): MdToken[];
}

/** 附件引用协议前缀：`attachment://<sha256>` */
export const ATTACHMENT_SCHEME: string = 'attachment://';

export interface ParseOptions {
  readonly docRevision: number;
  /** 是否把未识别的块降级为 RAW（默认 true，保留原文；false 时直接丢弃） */
  readonly keepRawBlocks?: boolean;
}

/** 计算每一行起始字符偏移，用于把「行号范围」映射为「字符偏移范围」 */
export function computeLineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i: number = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function rangeOf(lineStarts: readonly number[], map: number[] | null, totalLength: number): SourceRange {
  if (map === null || map.length < 2) {
    return { startLine: 0, endLine: 0, startOffset: 0, endOffset: 0 };
  }
  const startLine: number = map[0];
  const endLine: number = map[1];
  const startOffset: number = startLine < lineStarts.length ? lineStarts[startLine] : totalLength;
  const endOffset: number = endLine < lineStarts.length ? lineStarts[endLine] : totalLength;
  return { startLine, endLine, startOffset, endOffset };
}

/** 从图片 src 解析附件摘要；非附件引用（外链、远程图片）返回 undefined */
export function attachmentRefOf(src: string): string | undefined {
  if (src.startsWith(ATTACHMENT_SCHEME)) {
    const sha: string = src.slice(ATTACHMENT_SCHEME.length).split('?')[0];
    return isSha256Hex(sha) ? sha : undefined;
  }
  const slash: number = src.lastIndexOf('/');
  const base: string = (slash >= 0 ? src.slice(slash + 1) : src).split('?')[0].split('#')[0];
  return isSha256Hex(base) ? base : undefined;
}

interface InlineExtraction {
  /** 非图片文字（朗读时图片 alt 会随后拼接） */
  readonly text: string;
  /** 图片 alt 文本 */
  readonly altText: string;
  readonly hasImage: boolean;
  readonly attachmentRef?: string;
  readonly imageSrc?: string;
}

function extractInline(children: readonly MdToken[] | null): InlineExtraction {
  let text: string = '';
  let altText: string = '';
  let attachmentRef: string | undefined = undefined;
  let imageSrc: string | undefined = undefined;
  let hasImage: boolean = false;

  if (children !== null) {
    for (let i: number = 0; i < children.length; i++) {
      const child: MdToken = children[i];
      const type: string = child.type;
      if (type === 'text' || type === 'code_inline') {
        text += child.content;
      } else if (type === 'softbreak' || type === 'hardbreak') {
        text += '\n';
      } else if (type === 'image') {
        hasImage = true;
        const src: string = srcOf(child);
        if (imageSrc === undefined) {
          imageSrc = src;
        }
        const ref: string | undefined = attachmentRefOf(src);
        if (ref !== undefined && attachmentRef === undefined) {
          attachmentRef = ref;
        }
        if (child.content.length > 0) {
          altText += child.content;
        }
      } else if (type === 'html_inline') {
        // Markdown 默认不允许执行原始 HTML（设计 §4.4）；朗读也不应把标签读出来
      } else if (child.content.length > 0) {
        text += child.content;
      }
    }
  }

  const result: InlineExtraction = { text, altText, hasImage };
  return withOptional(result, attachmentRef, imageSrc);
}

function withOptional(base: InlineExtraction, attachmentRef?: string, imageSrc?: string): InlineExtraction {
  if (attachmentRef !== undefined && imageSrc !== undefined) {
    return { text: base.text, altText: base.altText, hasImage: base.hasImage, attachmentRef, imageSrc };
  }
  if (attachmentRef !== undefined) {
    return { text: base.text, altText: base.altText, hasImage: base.hasImage, attachmentRef };
  }
  if (imageSrc !== undefined) {
    return { text: base.text, altText: base.altText, hasImage: base.hasImage, imageSrc };
  }
  return base;
}

function srcOf(token: MdToken): string {
  const attrs: string[][] | undefined = token.attrs;
  if (attrs !== undefined) {
    for (let i: number = 0; i < attrs.length; i++) {
      const pair: string[] = attrs[i];
      if (pair.length >= 2 && pair[0] === 'src') {
        return pair[1];
      }
    }
  }
  return token.content;
}

interface ContainerFrame {
  readonly kind: string;
  readonly startLine: number;
  endLine: number;
}

export function parseDocument(tokenizer: IMarkdownTokenizer, markdown: string, options: ParseOptions): DocumentBlock[] {
  const keepRaw: boolean = options.keepRawBlocks === undefined || options.keepRawBlocks;
  const lineStarts: number[] = computeLineStarts(markdown);
  const total: number = markdown.length;
  const tokens: MdToken[] = tokenizer.parse(markdown);

  const blocks: DocumentBlock[] = [];
  let seq: number = 0;

  /**
   * 容器帧栈（list / table / blockquote）。
   *
   * 为什么需要**独立记录 endLine**：markdown-it 的 `*_close` token 的 `map` 是 `null`
   * （实测 14.1.0：blockquote_close / table_close 均无 map），因此不能靠 close token 反推范围，
   * 必须在容器内持续取 max(map[1])。这是"整段保留原文"能成立的前提。
   */
  const frames: ContainerFrame[] = [];
  let pendingType: BlockType | undefined = undefined;
  let pendingLevel: number = 0;
  let pendingRange: SourceRange | undefined = undefined;

  for (let i: number = 0; i < tokens.length; i++) {
    const token: MdToken = tokens[i];
    const top: ContainerFrame | undefined = frames.length > 0 ? frames[frames.length - 1] : undefined;

    // 位于 table / blockquote 内部时：只推进范围，不产出块（内容由容器整体承载）
    if (top !== undefined && (top.kind === 'table' || top.kind === 'blockquote')) {
      if (token.map !== null && token.map.length >= 2 && token.map[1] > top.endLine) {
        top.endLine = token.map[1];
      }
      const closing: boolean =
        (top.kind === 'table' && token.type === 'table_close') ||
        (top.kind === 'blockquote' && token.type === 'blockquote_close');
      if (!closing) {
        continue;
      }
    }

    if (token.type === 'heading_open') {
      pendingType = BlockType.HEADING;
      const m: RegExpMatchArray | null = token.tag.match(/^h([1-6])$/);
      pendingLevel = m === null ? 1 : parseInt(m[1], 10);
      pendingRange = rangeOf(lineStarts, token.map, total);
      continue;
    }

    if (token.type === 'paragraph_open') {
      pendingType = inList(frames) ? BlockType.LIST_ITEM : BlockType.PARAGRAPH;
      pendingLevel = 0;
      pendingRange = rangeOf(lineStarts, token.map, total);
      continue;
    }

    if (token.type === 'list_item_open') {
      pendingType = BlockType.LIST_ITEM;
      pendingLevel = 0;
      pendingRange = rangeOf(lineStarts, token.map, total);
      continue;
    }

    if (token.type === 'inline') {
      const extraction: InlineExtraction = extractInline(token.children);
      const range: SourceRange = pendingRange === undefined ? rangeOf(lineStarts, token.map, total) : pendingRange;
      const onlyImage: boolean =
        extraction.hasImage && extraction.text.trim().length === 0 && extraction.altText.length > 0;
      const type: BlockType = onlyImage ? BlockType.IMAGE : pendingType === undefined ? BlockType.PARAGRAPH : pendingType;
      const text: string = extraction.altText.length === 0 ? extraction.text : extraction.text + extraction.altText;
      if (text.trim().length > 0 || onlyImage) {
        blocks.push(makeBlock(blocks.length, seq++, type, pendingLevel, range, text, options.docRevision, extraction.attachmentRef));
      }
      pendingType = undefined;
      pendingRange = undefined;
      pendingLevel = 0;
      continue;
    }

    if (token.type === 'fence' || token.type === 'code_block') {
      const range: SourceRange = rangeOf(lineStarts, token.map, total);
      // 代码块保留原始缩进与空行（设计 §4.1「代码空白不得粗暴规范化」）
      const body: string = token.type === 'fence' ? token.content : markdown.slice(range.startOffset, range.endOffset);
      const lang: string = token.type === 'fence' ? langOf(token.info) : '';
      const text: string = lang.length > 0 ? `${lang}\n${trimTrailingNewline(body)}` : trimTrailingNewline(body);
      blocks.push(makeBlock(blocks.length, seq++, BlockType.CODE, 0, range, text, options.docRevision, undefined));
      continue;
    }

    if (token.type === 'table_open' || token.type === 'blockquote_open') {
      const kind: string = token.type === 'table_open' ? 'table' : 'blockquote';
      frames.push({
        kind,
        startLine: token.map === null ? -1 : token.map[0],
        endLine: token.map === null ? -1 : token.map[1],
      });
      continue;
    }

    if (token.type === 'table_close' || token.type === 'blockquote_close') {
      const frame: ContainerFrame | undefined = frames.pop();
      if (frame !== undefined) {
        const type: BlockType = frame.kind === 'table' ? BlockType.TABLE : BlockType.QUOTE;
        seq = pushContainer(blocks, markdown, lineStarts, frame.startLine, frame.endLine, type, options, total, seq);
      }
      continue;
    }

    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      frames.push({
        kind: 'list',
        startLine: token.map === null ? -1 : token.map[0],
        endLine: token.map === null ? -1 : token.map[1],
      });
      continue;
    }
    if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') {
      frames.pop();
      continue;
    }

    if (token.type === 'hr') {
      const range: SourceRange = rangeOf(lineStarts, token.map, total);
      blocks.push(makeBlock(blocks.length, seq++, BlockType.THEMATIC_BREAK, 0, range, '', options.docRevision, undefined));
      continue;
    }

    // 未覆盖语法（html_block、footnote、自定义插件等）：降级为 RAW 并保留原文
    if (keepRaw && token.nesting === 0 && token.map !== null && token.map.length >= 2) {
      const range: SourceRange = rangeOf(lineStarts, token.map, total);
      const raw: string = markdown.slice(range.startOffset, range.endOffset);
      if (raw.trim().length > 0) {
        blocks.push(makeBlock(blocks.length, seq++, BlockType.RAW, 0, range, trimTrailingNewline(raw), options.docRevision, undefined));
      }
    }
  }

  return blocks;
}

function inList(frames: readonly ContainerFrame[]): boolean {
  for (let i: number = frames.length - 1; i >= 0; i--) {
    if (frames[i].kind === 'list') {
      return true;
    }
  }
  return false;
}

function langOf(info: string): string {
  const trimmed: string = info.trim();
  if (trimmed.length === 0) {
    return '';
  }
  const sp: number = trimmed.indexOf(' ');
  return sp < 0 ? trimmed : trimmed.slice(0, sp);
}

function trimTrailingNewline(text: string): string {
  return text.replace(/\n+$/, '');
}

function pushContainer(
  blocks: DocumentBlock[],
  markdown: string,
  lineStarts: readonly number[],
  startLine: number,
  endLine: number,
  type: BlockType,
  options: ParseOptions,
  totalLength: number,
  seq: number,
): number {
  if (startLine < 0 || endLine <= startLine) {
    return seq;
  }
  const startOffset: number = lineStarts[startLine];
  const endOffset: number = endLine < lineStarts.length ? lineStarts[endLine] : totalLength;
  const raw: string = markdown.slice(startOffset, endOffset);
  const range: SourceRange = { startLine, endLine, startOffset, endOffset };
  blocks.push(makeBlock(blocks.length, seq, type, 0, range, trimTrailingNewline(raw), options.docRevision, undefined));
  return seq + 1;
}

function makeBlock(
  index: number,
  seq: number,
  type: BlockType,
  level: number,
  range: SourceRange,
  text: string,
  docRevision: number,
  attachmentRef: string | undefined,
): DocumentBlock {
  // 块 ID 只在确定的 docRevision 内稳定（设计 §4.3）
  const id: string = `${docRevision}:${index}:${seq}`;
  if (attachmentRef !== undefined) {
    return { id, type, level, range, text, attachmentRef, docRevision };
  }
  return { id, type, level, range, text, docRevision };
}

/** 朗读 / 索引共用的纯文本抽取；跳过 RAW（未覆盖语法）与分隔线 */
export function extractPlainText(blocks: readonly DocumentBlock[], includeCode: boolean): string {
  const parts: string[] = [];
  for (let i: number = 0; i < blocks.length; i++) {
    const b: DocumentBlock = blocks[i];
    if (b.type === BlockType.THEMATIC_BREAK || b.type === BlockType.RAW) {
      continue;
    }
    if (b.type === BlockType.CODE && !includeCode) {
      continue;
    }
    if (b.text.length > 0) {
      parts.push(b.text);
    }
  }
  return parts.join('\n\n');
}

/** 供渲染层使用的附件虚拟路径映射（只按授权附件 ID 查找，见设计 §4.4） */
export function attachmentVirtualPath(sha: string): string {
  return blobRelativePath(sha);
}
