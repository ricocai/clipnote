/**
 * 可读导出编排（S4-2；issue WHY-102）。
 *
 * 链路：取笔记（单篇/批量/全量）→ 逐篇收集附件字节（BlobCas 内容寻址）
 *   → buildExportEntries 组装 ZIP 条目（链接重写 + README 声明，见 export.ts）
 *   → buildZip（STORE 模式）→ AtomicWriter 原子落盘到 exports/ → 登记 ExportRecord
 *   → 记录保留策略（只留最近 N 条，连同产物文件一起清）。
 *
 * 口径纪律（与 backup-service.ts 的分界，勿破坏）：
 *  - 本服务**不做**一致性快照、不生成 manifest —— 那是可恢复备份（S4-1）的协议；
 *    导出产物不含任何可恢复语义（V1.4 F06「导出 ≠ 备份」）；
 *  - 附件字节读取失败的引用不阻断导出：正文链接保持 `attachment://` 原样并记入
 *    `unresolved`（不静默改成坏链接），由 UI 如实提示；
 *  - 全量导出只覆盖**未删除**笔记；回收站条目、收件箱条目（设计 §4.1「默认不进入
 *    备份导出」）一律不在导出范围内。
 *
 * 纯领域逻辑、零平台依赖（core 铁律），由 tools/test/export.test.ts 直载验证。
 */

import { AtomicWriter } from './atomicfs';
import { BlobCas } from './blob-cas';
import { toHex, utf8Encode } from './bytes';
import { BlobStatus, NoteAttachment } from './model';
import { IClock, IFileStore, ILogger, IRandom, LogLevel } from './ports';
import { buildZip } from './zip';
import {
  BuiltReadableExport,
  ExportAssetInput,
  ExportNoteInput,
  buildExportEntries,
  sanitizeFileName,
} from './export';
import { BlobRepository } from './data/blob-repository';
import {
  ExportKind,
  ExportRecord,
  ExportRecordRepository,
} from './data/export-record-repository';
import { NoteRepository } from './data/note-repository';

/** 导出产物目录（沙箱 files 根下；交接经 Share Kit 临时授权，路径本身不外泄） */
export const EXPORT_OUTPUT_DIR: string = 'exports';

/** 导出记录保留条数：超出的连同产物文件一起清理（本机运行痕迹，不无限堆积） */
export const EXPORT_RECORD_KEEP: number = 20;

export interface ExportServiceDeps {
  readonly notes: NoteRepository;
  readonly blobs: BlobRepository;
  readonly cas: BlobCas;
  readonly records: ExportRecordRepository;
  readonly fs: IFileStore;
  readonly clock: IClock;
  readonly random: IRandom;
  readonly logger: ILogger;
  /** 沙箱 files 根目录（exports/ 挂在其下，与备份 backups/ 平级分开） */
  readonly root: string;
  readonly appVersion: string;
}

export interface ReadableExportResult {
  readonly record: ExportRecord;
  /** 正文引用到但字节未能读取的 attachment:// 摘要（链接保持原样，未改写） */
  readonly unresolved: readonly string[];
}

export class ExportService {
  private readonly writer: AtomicWriter;

  constructor(private readonly deps: ExportServiceDeps) {
    this.writer = new AtomicWriter(deps.fs, deps.random, deps.logger);
  }

  /** 单篇导出（笔记页入口）。笔记不存在或已删除即报错，不产出空包。 */
  async exportSingle(noteId: string): Promise<ReadableExportResult> {
    return this.exportNotes([noteId], 'single');
  }

  /** 批量导出（列表多选入口）。传入顺序即包内编号顺序。 */
  async exportBatch(noteIds: readonly string[]): Promise<ReadableExportResult> {
    return this.exportNotes(noteIds, 'batch');
  }

  /** 全量导出（设置页入口）：全部未删除笔记，按更新时间倒序。 */
  async exportAll(): Promise<ReadableExportResult> {
    // 导出范围以库为准，不设 UI 分页上限：逐页拉全，避免"以为全量实则截断"
    const ids: string[] = [];
    const page: number = 200;
    for (let offset: number = 0; ; offset += page) {
      const notes = await this.deps.notes.listRecent(page, offset);
      for (let i: number = 0; i < notes.length; i++) {
        ids.push(notes[i].id);
      }
      if (notes.length < page) {
        break;
      }
    }
    if (ids.length === 0) {
      throw new Error('export: no notes to export');
    }
    return this.exportNotes(ids, 'full');
  }

  /** 最近导出记录（设置页展示），时间倒序 */
  async listRecords(limit: number): Promise<ExportRecord[]> {
    return this.deps.records.listRecent(limit);
  }

  private async exportNotes(noteIds: readonly string[], kind: ExportKind): Promise<ReadableExportResult> {
    const inputs: ExportNoteInput[] = [];
    for (let i: number = 0; i < noteIds.length; i++) {
      const note = await this.deps.notes.getById(noteIds[i]);
      if (note === undefined) {
        if (kind === 'single') {
          throw new Error(`export: note not found: ${noteIds[i]}`);
        }
        // 批量/全量：竞态下被删的篇目跳过，不阻断整包
        continue;
      }
      inputs.push({ note, assets: await this.readAssets(note.id) });
    }
    if (inputs.length === 0) {
      throw new Error('export: no exportable notes');
    }

    const built: BuiltReadableExport = buildExportEntries(inputs, {
      appVersion: this.deps.appVersion,
      exportedAtMs: this.deps.clock.nowMs(),
    });
    const zipBytes: Uint8Array = buildZip(built.entries);

    const outDir: string = `${this.deps.root}/${EXPORT_OUTPUT_DIR}`;
    await this.deps.fs.mkdirp(outDir);
    const zipPath: string = `${outDir}/${this.outputFileName(inputs, kind)}`;
    await this.writer.writeBytes(zipPath, zipBytes);

    const record: ExportRecord = {
      id: toHex(this.deps.random.nextBytes(16)),
      kind,
      format: built.format,
      noteCount: built.noteCount,
      blobCount: built.blobCount,
      totalBytes: built.totalBytes,
      filePath: zipPath,
      createdAtMs: this.deps.clock.nowMs(),
    };
    await this.deps.records.insert(record);
    await this.enforceRetention();

    if (built.unresolved.length > 0) {
      this.deps.logger.log(LogLevel.WARN, 'export_unresolved_attachments', {
        count: built.unresolved.length,
      });
    }
    return { record, unresolved: built.unresolved };
  }

  /** 读取一篇笔记引用到的附件字节；读取失败的引用跳过（由 export.ts 登记 unresolved） */
  private async readAssets(noteId: string): Promise<ExportAssetInput[]> {
    const attachments: NoteAttachment[] = await this.deps.blobs.listAttachmentsOf(noteId);
    const seen: Set<string> = new Set<string>();
    const out: ExportAssetInput[] = [];
    for (let i: number = 0; i < attachments.length; i++) {
      const sha: string = attachments[i].blobSha256;
      if (seen.has(sha)) {
        continue;
      }
      seen.add(sha);
      const meta = await this.deps.blobs.get(sha);
      if (meta === undefined || meta.status !== BlobStatus.REFERENCED) {
        continue;
      }
      try {
        const bytes: Uint8Array = await this.deps.cas.readBytes(sha);
        out.push({ sha256: sha, mime: meta.mime, bytes });
      } catch (err) {
        this.deps.logger.log(LogLevel.WARN, 'export_asset_read_failed', { sha256: sha });
      }
    }
    return out;
  }

  private outputFileName(inputs: readonly ExportNoteInput[], kind: ExportKind): string {
    const rand: string = toHex(this.deps.random.nextBytes(4));
    if (kind === 'single' && inputs.length === 1) {
      const title: string = sanitizeFileName(inputs[0].note.title, 'note');
      return `clipnote-${title}-${rand}.zip`;
    }
    const stamp: string = new Date(this.deps.clock.nowMs()).toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..*$/, '')
      .replace('T', '-');
    return `clipnote-export-${stamp}-${rand}.zip`;
  }

  /** 只保留最近 EXPORT_RECORD_KEEP 条；超出的记录删除并尽力清掉产物文件 */
  private async enforceRetention(): Promise<void> {
    const records: ExportRecord[] = await this.deps.records.listRecent(EXPORT_RECORD_KEEP * 4);
    for (let i: number = EXPORT_RECORD_KEEP; i < records.length; i++) {
      await this.deps.records.remove(records[i].id);
      try {
        if (await this.deps.fs.exists(records[i].filePath)) {
          await this.deps.fs.remove(records[i].filePath);
        }
      } catch (err) {
        // 产物清理失败不阻断：最坏后果是孤儿 ZIP，由用户手动清理或下次覆盖
        this.deps.logger.log(LogLevel.WARN, 'export_record_sweep_failed', { path: records[i].filePath });
      }
    }
  }
}

/** 设置页"导出记录"一行的展示文案（导出 ≠ 备份口径在这里落到字面） */
export function describeExportRecord(record: ExportRecord): string {
  const kindLabel: string =
    record.kind === 'single' ? '单篇' : record.kind === 'batch' ? '批量' : '全量';
  const formatLabel: string =
    record.format === 'markdown' ? 'Markdown' : record.format === 'html' ? 'HTML' : 'Markdown+HTML';
  const when: string = new Date(record.createdAtMs).toISOString().replace('T', ' ').replace(/\..*$/, '');
  return `${when} · ${kindLabel}导出（${formatLabel}）· ${record.noteCount} 篇 / ${record.blobCount} 个附件`;
}
