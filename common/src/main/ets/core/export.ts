/**
 * 可读导出（S4-2；设计 §4.2 末段「可读导出 ≠ 可恢复备份」，评审 F06）。
 *
 * 与备份（backup.ts / backup-service.ts）的边界：
 *  - 产物是**给人与其他工具读**的 MD/HTML + 附件 ZIP，链接重写为包内相对路径；
 *  - 不含 manifest、不含实体元数据与摘要关系，**不能用于恢复**；
 *  - 包内 README.md 把这一点写给接收方，UI 文案同样区分（设置页）。
 *
 * 正文保真口径（与 issue「复用 blocksToMarkdown」的偏差说明）：
 *  blocksToMarkdown 是块模型的**有损**重建（列表/引用等行内标记丢失，
 *  服务于朗读/检索的纯文本口径）；可读导出的目标是"迁出到其他工具仍能原样打开"，
 *  因此 MD 正文直接取权威 `note.contentMd`（块模型本就由它解析而来，不存在
 *  "屏幕/朗读/导出"分叉），链接重写复用 backup.ts 的 rewriteAttachmentLinks。
 *
 * HTML 笔记导出为**受控静态页**：正文再过一遍 sanitizeHtml（采集时已清洗，
 *  导出侧复跑是纵深防御），外套最小壳（charset + CSP meta），
 *  attachment:// 引用同样重写为包内相对路径。
 *
 * 纯函数、零平台依赖（core 铁律），由 tools/ 本机用例直载验证。
 */

import { CONTENT_TYPE_HTML, sanitizeHtml } from './htmlsafe';
import { rewriteAttachmentLinks } from './backup';
import { Note } from './model';
import { utf8Encode } from './bytes';
import { ZipEntryInput } from './zip';
import { ExportFormat } from './data/export-record-repository';

/** 包内目录布局 */
export const EXPORT_NOTES_DIR: string = 'notes';
export const EXPORT_ASSETS_DIR: string = 'assets';
export const EXPORT_README_ENTRY: string = 'README.md';

/** 单篇文件名标题部分的长度上限（文件系统与分享面板的现实约束） */
const MAX_TITLE_CHARS: number = 60;

/** 附件在包内的相对路径：`assets/<sha256>.<ext>`（内容寻址，天然去重） */
export function assetEntryName(sha256: string, mime: string): string {
  return `${EXPORT_ASSETS_DIR}/${sha256}.${extensionForMime(mime)}`;
}

/** notes/ 下的文件指向 assets/ 的相对链接 */
export function assetLinkFromNote(sha256: string, mime: string): string {
  return `../${assetEntryName(sha256, mime)}`;
}

/** MIME → 导出文件扩展名；未登记的一律 .bin（不做嗅探，与阅读页同一口径） */
export function extensionForMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'bin';
  }
}

/**
 * 标题 → 安全文件名：剥除路径分隔与 Windows/Unix 双平台非法字符、控制字符，
 * 去首尾空白与前导点（防隐藏文件与相对路径歧义），超限截断；空则给兜底名。
 * 产出不包含 `/`，因此不可能越出 notes/ 目录（zip.ts 的 isSafeRelativePath 是第二道闸）。
 */
export function sanitizeFileName(title: string, fallback: string): string {
  let out: string = '';
  for (let i: number = 0; i < title.length; i++) {
    const ch: string = title.charAt(i);
    const code: number = title.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    if (ch === '/' || ch === '\\' || ch === ':' || ch === '*' || ch === '?' ||
      ch === '"' || ch === '<' || ch === '>' || ch === '|') {
      out += ' ';
      continue;
    }
    out += ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  while (out.startsWith('.')) {
    out = out.slice(1);
  }
  if (out.length > MAX_TITLE_CHARS) {
    out = out.slice(0, MAX_TITLE_CHARS).trim();
  }
  return out.length > 0 ? out : fallback;
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * HTML 笔记的受控静态页外壳：无脚本、CSP 锁死联网与脚本（与应用内阅读页同口径，
 * 设计 §4.4 信任域分离）；正文传入前必须已经过 sanitizeHtml。
 */
export function buildStaticHtmlPage(title: string, sanitizedBodyHtml: string): string {
  return '<!DOCTYPE html>\n' +
    '<html lang="zh-CN">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' data:; style-src \'unsafe-inline\'">\n' +
    `<title>${escapeHtmlText(title)}</title>\n` +
    '</head>\n<body>\n' +
    sanitizedBodyHtml +
    '\n</body>\n</html>\n';
}

/** 单篇笔记的导出输入（附件字节由调用方经 BlobCas 读取后传入） */
export interface ExportNoteInput {
  readonly note: Note;
  /** 本篇引用且字节已成功读取的附件 */
  readonly assets: readonly ExportAssetInput[];
}

export interface ExportAssetInput {
  readonly sha256: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

export interface ExportBuildMeta {
  readonly appVersion: string;
  readonly exportedAtMs: number;
}

export interface BuiltReadableExport {
  readonly entries: ZipEntryInput[];
  readonly format: ExportFormat;
  readonly noteCount: number;
  /** 去重后的附件条数（内容寻址，多笔记共享同一 blob 只带一份） */
  readonly blobCount: number;
  readonly totalBytes: number;
  /** 正文引用到但未能提供字节的 attachment:// 摘要（保持原链接并登记，不静默改成坏链接） */
  readonly unresolved: readonly string[];
}

function pad2(index: number): string {
  return index < 10 ? `0${index}` : `${index}`;
}

/**
 * 把一组笔记组装为可读导出 ZIP 的条目集：
 *   notes/<NN>-<安全标题>.md|.html   每篇一条，附件链接重写为 ../assets/<sha>.<ext>
 *   assets/<sha256>.<ext>            内容寻址去重
 *   README.md                        导出说明（含"可读导出 ≠ 可恢复备份"声明）
 */
export function buildExportEntries(
  inputs: readonly ExportNoteInput[],
  meta: ExportBuildMeta,
): BuiltReadableExport {
  // 第一遍：汇总附件（内容寻址去重；同摘要以后到的登记 MIME 为准无意义，取先到者）
  const assetShas: string[] = [];
  const assetMime: Map<string, string> = new Map<string, string>();
  const assetBytes: Map<string, Uint8Array> = new Map<string, Uint8Array>();
  for (let i: number = 0; i < inputs.length; i++) {
    const assets = inputs[i].assets;
    for (let j: number = 0; j < assets.length; j++) {
      const a = assets[j];
      if (!assetBytes.has(a.sha256)) {
        assetShas.push(a.sha256);
        assetMime.set(a.sha256, a.mime);
        assetBytes.set(a.sha256, a.bytes);
      }
    }
  }

  // 第二遍：逐篇生成正文条目并重写链接
  const entries: ZipEntryInput[] = [];
  const unresolved: string[] = [];
  let htmlCount: number = 0;
  for (let i: number = 0; i < inputs.length; i++) {
    const note: Note = inputs[i].note;
    const isHtml: boolean = note.contentType === CONTENT_TYPE_HTML;
    if (isHtml) {
      htmlCount++;
    }
    // HTML 笔记导出前复跑清洗（纵深防御：采集时已清洗，导出侧不假设上游必然执行过）
    const body: string = isHtml
      ? buildStaticHtmlPage(note.title, sanitizeHtml(note.contentMd).html)
      : note.contentMd;
    const rewritten = rewriteAttachmentLinks(body, (sha: string) => {
      const mime: string | undefined = assetMime.get(sha);
      return mime === undefined ? undefined : assetLinkFromNote(sha, mime);
    });
    for (let u: number = 0; u < rewritten.unresolved.length; u++) {
      if (unresolved.indexOf(rewritten.unresolved[u]) < 0) {
        unresolved.push(rewritten.unresolved[u]);
      }
    }
    const safeTitle: string = sanitizeFileName(note.title, `note-${note.id.slice(0, 8)}`);
    const ext: string = isHtml ? 'html' : 'md';
    entries.push({
      name: `${EXPORT_NOTES_DIR}/${pad2(i + 1)}-${safeTitle}.${ext}`,
      data: utf8Encode(rewritten.markdown),
    });
  }

  // 第三遍：附件条目 + README
  for (let i: number = 0; i < assetShas.length; i++) {
    const sha: string = assetShas[i];
    entries.push({
      name: assetEntryName(sha, assetMime.get(sha) as string),
      data: assetBytes.get(sha) as Uint8Array,
    });
  }
  const readme: string = buildReadme(inputs.length, assetShas.length, htmlCount, meta);
  entries.push({ name: EXPORT_README_ENTRY, data: utf8Encode(readme) });

  let totalBytes: number = 0;
  for (let i: number = 0; i < entries.length; i++) {
    totalBytes += entries[i].data.length;
  }

  const format: ExportFormat =
    htmlCount === 0 ? 'markdown' : htmlCount === inputs.length ? 'html' : 'mixed';
  return {
    entries,
    format,
    noteCount: inputs.length,
    blobCount: assetShas.length,
    totalBytes,
    unresolved,
  };
}

function buildReadme(noteCount: number, blobCount: number, htmlCount: number, meta: ExportBuildMeta): string {
  const exportedAt: string = new Date(meta.exportedAtMs).toISOString();
  const lines: string[] = [
    '# ClipNote 拾记 · 可读导出包',
    '',
    `- 导出时间：${exportedAt}`,
    `- 应用版本：${meta.appVersion}`,
    `- 内容：${noteCount} 篇笔记（其中 ${htmlCount} 篇为受控静态 HTML 页）、${blobCount} 个附件`,
    '',
    '## 目录',
    '',
    '- `notes/`：笔记正文（Markdown / 受控静态 HTML），附件链接已重写为相对路径；',
    '- `assets/`：笔记引用的附件（按内容摘要命名，多笔记共享的附件只有一份）。',
    '',
    '## 重要：可读导出 ≠ 可恢复备份',
    '',
    '本包用于把笔记迁出到其他工具阅读与再加工，**不包含**恢复所需的元数据与一致性校验信息，',
    '不能用来把数据恢复回 ClipNote。需要可恢复备份时请使用应用内的备份功能。',
    '',
  ];
  return lines.join('\n');
}
