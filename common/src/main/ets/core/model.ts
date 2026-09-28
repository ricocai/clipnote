/**
 * ClipNote 领域模型（平台无关）
 *
 * 约束（项目铁律，勿破坏）：
 *  1. 本目录 core/ 下任何文件 **不得** import `@ohos.*` / `@kit.*` / Node 内建模块。
 *     所有平台能力必须通过 `ports.ts` 的接口注入 —— 否则领域内核无法被本机
 *     `tsc + node --test` 验证，也无法用 Mock 做单测（设计 §5 "可测试性"）。
 *  2. 只使用 ArkTS 1.1 与 TypeScript 的公共语法子集（无 any、无泛型技巧、无装饰器）。
 *  3. 实体身份与版本口径见设计 §4.8：UUID v7 + 单设备 revision。
 */

/** 业务记录 schema 版本；每次不兼容迁移 +1（设计 §4.2） */
export const CONTENT_SCHEMA_VERSION: number = 1;

/** 内容规范化版本；仅用于「内容类型判定与幂等键」，永不用于改写持久化正文（设计 §4.1） */
export const NORMALIZE_VERSION: number = 1;

/** 单条剪贴内容落盘上限（UTF-8 字节） */
export const MAX_CLIP_TEXT_BYTES: number = 1024 * 1024;

/** 收件箱默认保留期（毫秒） */
export const DEFAULT_INBOX_TTL_MS: number = 7 * 24 * 60 * 60 * 1000;

/** 幂等合并时间窗（毫秒）：同一次用户操作可能同时触发分享 / 前台读取 / 变化回调 */
export const DEDUPE_WINDOW_MS: number = 3000;

export type NoteId = string;
export type BlobSha256 = string;

/** 文档块类型；渲染、朗读、高亮、导出共用同一套块模型（设计 §4.3） */
export enum BlockType {
  HEADING = 'heading',
  PARAGRAPH = 'paragraph',
  LIST_ITEM = 'list_item',
  CODE = 'code',
  TABLE = 'table',
  QUOTE = 'quote',
  IMAGE = 'image',
  THEMATIC_BREAK = 'thematic_break',
  /** 未覆盖语法的降级形态：保留原文，不高亮、不朗读 */
  RAW = 'raw',
}

/** 源范围：以「行」与「字符偏移」双坐标表达，便于编辑器与朗读高亮双向映射 */
export interface SourceRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * 文档块。
 * `id` 只在确定的 `docRevision` 内稳定；文档编辑后必须终止旧朗读或整体重映射（设计 §4.3）。
 */
export interface DocumentBlock {
  readonly id: string;
  readonly type: BlockType;
  /** 标题层级，仅 BlockType.HEADING 有效（1~6） */
  readonly level: number;
  readonly range: SourceRange;
  /** 供朗读与检索使用的纯文本（代码块保留原始缩进） */
  readonly text: string;
  /** 引用到的附件摘要；未引用为 undefined */
  readonly attachmentRef?: BlobSha256;
  readonly docRevision: number;
}

/** 附件在笔记中的角色 */
export enum AttachmentRole {
  INLINE_IMAGE = 'inline_image',
  COVER = 'cover',
  FILE = 'file',
}

export interface BlobRecord {
  readonly sha256: BlobSha256;
  readonly relativePath: string;
  readonly mime: string;
  readonly size: number;
  readonly status: BlobStatus;
}

export enum BlobStatus {
  /** 已被笔记引用 */
  REFERENCED = 'referenced',
  /** 无引用，处于 GC 宽限期（设计 §4.2 第 3 条） */
  ORPHAN_GRACE = 'orphan_grace',
}

export interface NoteAttachment {
  readonly noteId: NoteId;
  readonly blobSha256: BlobSha256;
  readonly role: AttachmentRole;
  readonly ordinal: number;
}

export enum NoteSource {
  CLIPBOARD = 'clipboard',
  SHARE = 'share',
  MANUAL = 'manual',
  IMPORT = 'import',
  MCP = 'mcp',
}

export interface Note {
  readonly id: NoteId;
  readonly title: string;
  readonly contentMd: string;
  readonly contentType: string;
  readonly source: NoteSource;
  readonly originHash?: string;
  readonly revision: number;
  readonly contentSchemaVersion: number;
  readonly pinned: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** 软删除时间；undefined 表示未删除。搜索结果与备份快照需排除 */
  readonly deletedAtMs?: number;
}

export interface Tag {
  readonly id: string;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// 剪贴板采集（设计 §4.1）
// ---------------------------------------------------------------------------

export enum ClipKind {
  TEXT = 'text',
  URL = 'url',
  CODE = 'code',
  TABLE = 'table',
  IMAGE = 'image',
  FILE = 'file',
}

export enum Sensitivity {
  NONE = 'none',
  /** 疑似敏感：不自动持久化，需用户明确选择保存 */
  SUSPECTED = 'suspected',
  /** 强特征敏感（私钥块等）：不自动持久化，且默认不进 MCP 可见范围 */
  HIGH = 'high',
}

/** 收件箱条目状态 */
export enum InboxState {
  /** 已暂存待处理 */
  PENDING = 'pending',
  /** 用户已确认保存为笔记 */
  ACCEPTED = 'accepted',
  /** 用户放弃 */
  DISCARDED = 'discarded',
  /** 命中敏感策略，等待用户明确决定（尚未持久化） */
  AWAITING_CONFIRM = 'awaiting_confirm',
}

/** 采集入口；用于「入口 × 生命周期 × 承诺」矩阵的可观测性（设计 §4.1） */
export enum ClipEntry {
  FOREGROUND_WATCH = 'foreground_watch',
  RETURN_TO_FOREGROUND = 'return_to_foreground',
  SHARE = 'share',
  PASTE_BUTTON = 'paste_button',
  MANUAL = 'manual',
  DESKTOP_CARD = 'desktop_card',
}

export interface ClipboardItem {
  readonly id: string;
  readonly kind: ClipKind;
  readonly rawText: string;
  readonly structuredJson?: string;
  /** 允许为空：来源 API 存在且可伪造，来源不明不得匹配自动转存白名单（设计 §4.1） */
  readonly originApp?: string;
  readonly sha256: BlobSha256;
  readonly capturedAtMs: number;
  readonly expiresAtMs: number;
  readonly sensitivity: Sensitivity;
  readonly state: InboxState;
  readonly entry: ClipEntry;
  /** 超限截断标记；不得静默丢弃 */
  readonly truncated: boolean;
  readonly originalByteLength: number;
}

/** 摄取决策：决定是否自动落盘 */
export enum IngestDecision {
  /** 普通内容：进入收件箱 */
  AUTO_PERSIST = 'auto_persist',
  /** 疑似敏感：不自动落盘，交由用户确认 */
  REQUIRE_CONFIRM = 'require_confirm',
  /** 拒绝：内容无效或超出硬上限 */
  REJECT = 'reject',
}

export interface IngestInput {
  readonly text: string;
  readonly entry: ClipEntry;
  readonly originApp?: string;
  readonly capturedAtMs?: number;
}

export interface IngestOutcome {
  /** 与既有条目幂等合并时为 true（未产生新条目） */
  readonly merged: boolean;
  readonly decision: IngestDecision;
  readonly item: ClipboardItem;
  /** 决策依据，用于 UI 如实展示与审计（不记正文） */
  readonly reasons: string[];
}
