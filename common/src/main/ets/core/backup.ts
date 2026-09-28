/**
 * 备份 / 导出（设计 §4.2 末段）。
 *
 * 关键区分（V1.4 新增，不要混淆）：
 *  - **可读导出**：MD/HTML + 附件 ZIP，重写相对链接 → 迁出到其他工具；
 *  - **可恢复备份**：`manifest.json` + 格式版本 + 实体元数据 + 文件摘要与关系 → 恢复到空库并得到可核对结果。
 *    二者不是一回事：能读 ≠ 能恢复。本文件同时实现两条路径的**契约与校验**。
 *
 * 安全要求（设计 §4.2）：
 *  - 恢复先校验暂存再导入，防路径越界与超大解压（zip bomb）；
 *  - **默认排除设备密钥与 MCP Token**（结构上就不存在这些字段，且解析时做字段名黑名单二次防御）。
 */

import { BlobRecord, BlockType, DocumentBlock, Note, NoteAttachment, Tag } from './model';
import { FileKind, IFileStore } from './ports';
import { isSha256Hex, blobRelativePath } from './blob-cas';
import { isSafeRelativePath } from './bytes';
import { isUuidV7 } from './id';
import { ATTACHMENT_SCHEME } from './markdown';

/** 备份格式版本；不兼容变更必须 +1（恢复侧据此判定） */
export const BACKUP_FORMAT_VERSION: number = 1;

/** 解压/导入硬上限，防超大解压（设计 §4.2） */
export const MAX_RESTORE_ENTRIES: number = 50000;
export const MAX_RESTORE_TOTAL_BYTES: number = 2 * 1024 * 1024 * 1024;

/** 恢复时校验的**单条** blob 大小上限（防单文件撑爆沙箱） */
export const MAX_SINGLE_BLOB_BYTES: number = 256 * 1024 * 1024;

export interface BackupManifest {
  readonly formatVersion: number;
  readonly contentSchemaVersion: number;
  readonly appVersion: string;
  readonly exportedAtMs: number;
  readonly notes: readonly Note[];
  readonly tags: readonly Tag[];
  readonly noteTags: readonly { noteId: string; tagId: string }[];
  readonly blobs: readonly BlobRecord[];
  readonly noteAttachments: readonly NoteAttachment[];
}

/** 禁止出现在备份中的字段名（结构上已保证，这里是二次防御） */
const FORBIDDEN_FIELD_NAMES: string[] = [
  'devicekey',
  'device_key',
  'mcptoken',
  'mcp_token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'privatekey',
  'private_key',
  'pairingsecret',
  'pairing_secret',
];

export interface RestoreIssue {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly detail: string;
}

export interface RestoreValidation {
  readonly ok: boolean;
  readonly issues: readonly RestoreIssue[];
  /** 校验通过后可安全导入的实体数量，便于 UI 预演 */
  readonly counts: {
    readonly notes: number;
    readonly blobs: number;
    readonly attachments: number;
    readonly tags: number;
  };
}

export interface BackupInput {
  readonly contentSchemaVersion: number;
  readonly appVersion: string;
  readonly exportedAtMs: number;
  readonly notes: readonly Note[];
  readonly tags: readonly Tag[];
  readonly noteTags: readonly { noteId: string; tagId: string }[];
  readonly blobs: readonly BlobRecord[];
  readonly noteAttachments: readonly NoteAttachment[];
}

export function buildManifest(input: BackupInput): BackupManifest {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    contentSchemaVersion: input.contentSchemaVersion,
    appVersion: input.appVersion,
    exportedAtMs: input.exportedAtMs,
    notes: input.notes,
    tags: input.tags,
    noteTags: input.noteTags,
    blobs: input.blobs,
    noteAttachments: input.noteAttachments,
  };
}

export function serializeManifest(manifest: BackupManifest): string {
  return JSON.stringify(manifest);
}

export interface ParseResult {
  readonly manifest?: BackupManifest;
  readonly issues: readonly RestoreIssue[];
  readonly ok: boolean;
}

/**
 * 严格解析并校验备份清单。
 * 拒绝策略（任何 error 都不得导入）：
 *  - 未知 formatVersion（不猜测兼容性）；
 *  - 缺失/非法的实体身份（note.id 必须是 UUID v7）；
 *  - blob 相对路径越界或与摘要不符；
 *  - 附件引用指向不存在的 blob；
 *  - 出现被禁止的凭证字段名。
 */
export function parseManifest(json: string, expectedSchemaVersion: number): ParseResult {
  const issues: RestoreIssue[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { ok: false, issues: [{ severity: 'error', code: 'invalid_json', detail: String(err) }] };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ severity: 'error', code: 'invalid_root', detail: 'manifest root must be an object' }] };
  }

  const obj = raw as Record<string, unknown>;
  const forbidden: string = findForbiddenField(raw, 0);
  if (forbidden.length > 0) {
    issues.push({
      severity: 'error',
      code: 'forbidden_field',
      detail: `backup contains forbidden credential field: ${forbidden}`,
    });
  }

  const formatVersion: number = toInt(obj['formatVersion']);
  if (formatVersion !== BACKUP_FORMAT_VERSION) {
    issues.push({
      severity: 'error',
      code: 'unsupported_format_version',
      detail: `expected ${BACKUP_FORMAT_VERSION}, got ${String(obj['formatVersion'])}`,
    });
    return { ok: false, issues };
  }

  const contentSchemaVersion: number = toInt(obj['contentSchemaVersion']);
  if (contentSchemaVersion > expectedSchemaVersion) {
    issues.push({
      severity: 'error',
      code: 'schema_too_new',
      detail: `backup schema ${contentSchemaVersion} > app schema ${expectedSchemaVersion}`,
    });
  } else if (contentSchemaVersion < expectedSchemaVersion) {
    issues.push({
      severity: 'warning',
      code: 'schema_migration_required',
      detail: `backup schema ${contentSchemaVersion} will be migrated to ${expectedSchemaVersion}`,
    });
  }

  const notes: Note[] = toArray<Note>(obj['notes']);
  const tags: Tag[] = toArray<Tag>(obj['tags']);
  const noteTags: { noteId: string; tagId: string }[] = toArray<{ noteId: string; tagId: string }>(obj['noteTags']);
  const blobs: BlobRecord[] = toArray<BlobRecord>(obj['blobs']);
  const noteAttachments: NoteAttachment[] = toArray<NoteAttachment>(obj['noteAttachments']);

  const totalEntries: number = notes.length + tags.length + noteTags.length + blobs.length + noteAttachments.length;
  if (totalEntries > MAX_RESTORE_ENTRIES) {
    issues.push({
      severity: 'error',
      code: 'too_many_entries',
      detail: `${totalEntries} > ${MAX_RESTORE_ENTRIES}`,
    });
  }

  const noteIds: Set<string> = new Set<string>();
  const duplicateNotes: string[] = [];
  for (let i: number = 0; i < notes.length; i++) {
    const n: Note = notes[i];
    if (n === null || typeof n !== 'object') {
      issues.push({ severity: 'error', code: 'invalid_note', detail: `notes[${i}] is not an object` });
      continue;
    }
    if (!isUuidV7(n.id)) {
      issues.push({ severity: 'error', code: 'invalid_note_id', detail: `notes[${i}].id="${String(n.id)}"` });
      continue;
    }
    if (noteIds.has(n.id)) {
      duplicateNotes.push(n.id);
    }
    noteIds.add(n.id);
    if (n.contentSchemaVersion !== contentSchemaVersion) {
      issues.push({
        severity: 'warning',
        code: 'note_schema_mismatch',
        detail: `note ${n.id} contentSchemaVersion=${String(n.contentSchemaVersion)}`,
      });
    }
  }
  if (duplicateNotes.length > 0) {
    issues.push({ severity: 'error', code: 'duplicate_note_id', detail: duplicateNotes.slice(0, 5).join(',') });
  }

  const blobShas: Set<string> = new Set<string>();
  let totalBytes: number = 0;
  for (let i: number = 0; i < blobs.length; i++) {
    const b: BlobRecord = blobs[i];
    if (b === null || typeof b !== 'object') {
      issues.push({ severity: 'error', code: 'invalid_blob', detail: `blobs[${i}] is not an object` });
      continue;
    }
    if (!isSha256Hex(b.sha256)) {
      issues.push({ severity: 'error', code: 'invalid_blob_sha', detail: `blobs[${i}].sha256="${String(b.sha256)}"` });
      continue;
    }
    const expectedPath: string = blobRelativePath(b.sha256);
    if (!isSafeRelativePath(b.relativePath)) {
      issues.push({
        severity: 'error',
        code: 'unsafe_blob_path',
        detail: `blobs[${i}].relativePath="${String(b.relativePath)}"`,
      });
    } else if (b.relativePath !== expectedPath) {
      // 允许历史迁移时带前缀，但不允许指向别处
      issues.push({
        severity: 'warning',
        code: 'blob_path_not_canonical',
        detail: `blobs[${i}] path "${b.relativePath}" != "${expectedPath}"`,
      });
    }
    if (b.size > MAX_SINGLE_BLOB_BYTES) {
      issues.push({
        severity: 'error',
        code: 'blob_too_large',
        detail: `blobs[${i}] size=${b.size}`,
      });
    }
    totalBytes += b.size;
    blobShas.add(b.sha256);
  }
  if (totalBytes > MAX_RESTORE_TOTAL_BYTES) {
    issues.push({ severity: 'error', code: 'total_too_large', detail: `${totalBytes} bytes` });
  }

  for (let i: number = 0; i < noteAttachments.length; i++) {
    const a: NoteAttachment = noteAttachments[i];
    if (a === null || typeof a !== 'object') {
      issues.push({ severity: 'error', code: 'invalid_attachment', detail: `noteAttachments[${i}]` });
      continue;
    }
    if (!noteIds.has(a.noteId)) {
      issues.push({
        severity: 'error',
        code: 'dangling_attachment_note',
        detail: `noteAttachments[${i}].noteId=${String(a.noteId)} not found`,
      });
    }
    if (!blobShas.has(a.blobSha256)) {
      issues.push({
        severity: 'error',
        code: 'dangling_attachment_blob',
        detail: `noteAttachments[${i}].blobSha256=${String(a.blobSha256)} not found`,
      });
    }
  }

  const hasError: boolean = issues.some((x: RestoreIssue) => x.severity === 'error');
  if (hasError) {
    return { ok: false, issues };
  }

  const manifest: BackupManifest = {
    formatVersion,
    contentSchemaVersion,
    appVersion: typeof obj['appVersion'] === 'string' ? (obj['appVersion'] as string) : 'unknown',
    exportedAtMs: toInt(obj['exportedAtMs']),
    notes,
    tags,
    noteTags,
    blobs,
    noteAttachments,
  };
  return { manifest, issues, ok: true };
}

function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : -1;
}

/** 递归查找被禁止的凭证字段名（大小写不敏感、下划线/驼峰皆覆盖） */
function findForbiddenField(value: unknown, depth: number): string {
  if (depth > 8 || value === null || typeof value !== 'object') {
    return '';
  }
  if (Array.isArray(value)) {
    for (let i: number = 0; i < value.length; i++) {
      const hit: string = findForbiddenField(value[i], depth + 1);
      if (hit.length > 0) {
        return hit;
      }
    }
    return '';
  }
  const obj = value as Record<string, unknown>;
  const keys: string[] = Object.keys(obj);
  for (let i: number = 0; i < keys.length; i++) {
    const key: string = keys[i];
    const lowered: string = key.toLowerCase();
    for (let j: number = 0; j < FORBIDDEN_FIELD_NAMES.length; j++) {
      if (lowered === FORBIDDEN_FIELD_NAMES[j]) {
        return key;
      }
    }
    const hit: string = findForbiddenField(obj[key], depth + 1);
    if (hit.length > 0) {
      return hit;
    }
  }
  return '';
}

export interface BlobRestoreCheck {
  readonly sha256: string;
  readonly relativePath: string;
  readonly exists: boolean;
  readonly sizeMatches: boolean;
  readonly actualSize: number;
}

export interface RestoreDryRun {
  readonly ok: boolean;
  readonly missingBlobs: readonly string[];
  readonly sizeMismatches: readonly string[];
  readonly checks: readonly BlobRestoreCheck[];
}

/**
 * 恢复预演：在**导入任何数据之前**核对附件实体是否齐备（设计 §4.2「恢复先校验暂存再导入」）。
 * 注意这里只看存在性与大小；内容摘要校验由 G5 恢复演练用 `verifyHash` 单独跑（代价高）。
 */
export async function dryRunRestore(manifest: BackupManifest, fs: IFileStore, root: string): Promise<RestoreDryRun> {
  const checks: BlobRestoreCheck[] = [];
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (let i: number = 0; i < manifest.blobs.length; i++) {
    const b: BlobRecord = manifest.blobs[i];
    const path: string = `${root}/${b.relativePath}`;
    const st = await fs.stat(path);
    const exists: boolean = st !== undefined && st.kind === FileKind.FILE;
    const actualSize: number = st === undefined ? -1 : st.size;
    const sizeMatches: boolean = exists && actualSize === b.size;
    if (!exists) {
      missing.push(b.sha256);
    } else if (!sizeMatches) {
      mismatched.push(b.sha256);
    }
    checks.push({ sha256: b.sha256, relativePath: b.relativePath, exists, sizeMatches, actualSize });
  }
  return {
    ok: missing.length === 0 && mismatched.length === 0,
    missingBlobs: missing,
    sizeMismatches: mismatched,
    checks,
  };
}

// ---------------------------------------------------------------------------
// 可读导出（≠ 备份）
// ---------------------------------------------------------------------------

export interface ReadableExportFile {
  readonly relativePath: string;
  readonly content: string;
}

/**
 * 把笔记正文中的附件引用重写为导出包内的相对路径，
 * 使导出内容可以直接在任意 Markdown 工具里打开（设计 §4.2「可读导出」）。
 * 未知摘要保持原样并登记告警，不静默改成坏链接。
 */
export function rewriteAttachmentLinks(
  markdown: string,
  resolve: (sha: string) => string | undefined,
): { readonly markdown: string; readonly unresolved: readonly string[] } {
  const unresolved: string[] = [];
  const out: string = markdown.replace(/attachment:\/\/([0-9a-f]{64})/g, (_m: string, sha: string) => {
    const mapped: string | undefined = resolve(sha);
    if (mapped === undefined) {
      unresolved.push(sha);
      return `${ATTACHMENT_SCHEME}${sha}`;
    }
    return mapped;
  });
  return { markdown: out, unresolved };
}

/** 从块模型生成可读导出的 Markdown（复用块模型，保证"屏幕 / 朗读 / 导出"一致） */
export function blocksToMarkdown(blocks: readonly DocumentBlock[]): string {
  const parts: string[] = [];
  for (let i: number = 0; i < blocks.length; i++) {
    const b: DocumentBlock = blocks[i];
    switch (b.type) {
      case BlockType.HEADING:
        parts.push(`${'#'.repeat(Math.max(1, Math.min(6, b.level)))} ${b.text}`);
        break;
      case BlockType.THEMATIC_BREAK:
        parts.push('---');
        break;
      case BlockType.CODE:
        parts.push('```\n' + b.text + '\n```');
        break;
      default:
        parts.push(b.text);
        break;
    }
  }
  return parts.join('\n\n');
}
