/**
 * 收件箱服务（S2-2；设计 §4.1 收件箱策略的端到端落地）。
 *
 * 职责边界：
 *  - 组合 ClipIngestService（限长/类型/敏感判断/幂等）与 InboxRepository / NoteRepository，
 *    让"采集 → 收件箱 → 存为笔记"全链路走同一条领域路径，UI 只做渲染与转发；
 *  - 敏感内容**不落盘**：REQUIRE_CONFIRM 的条目只存在于内存，用户 confirmSave 后才写入
 *    `clipboard_item`（收件箱即持久化，写入就是已保存）；
 *  - 容量上限与保留期清理由 housekeep 保证：每次落盘后执行，启动时由 AppDataRuntime
 *    另行执行一次 purgeExpired（重启即清）。
 *
 * 数值口径：设计 §4.1 只规定"有容量上限、可配置保留期、一键清空"，未定具体数值。
 * 首期默认容量 200 条（PENDING 计），保留期沿用 model.DEFAULT_INBOX_TTL_MS（7 天）；
 * 两者均经 InboxPolicy / IngestPolicy 注入，设置页（S2-4）接配置时无需改本服务。
 */

import {
  ClipEntry,
  ClipboardItem,
  InboxState,
  IngestDecision,
  IngestInput,
  IngestOutcome,
  Note,
  NoteSource,
  PERSISTED_DEDUPE_WINDOW_MS,
  Sensitivity,
} from './model';
import { ClipIngestService, IngestImageInput } from './clip';
import { InboxRepository } from './data/inbox-repository';
import { NoteRepository } from './data/note-repository';
import { CONTENT_TYPE_HTML, looksLikeHtml } from './htmlsafe';
import { IClock, ILogger, LogLevel } from './ports';

/** 收件箱容量上限（按 PENDING 条数计，超限淘汰最旧） */
export const DEFAULT_INBOX_CAPACITY: number = 200;

/** 列表页单次加载上限（与容量对齐：一页足以装下全量 PENDING） */
export const INBOX_LIST_LIMIT: number = 200;

export interface InboxPolicy {
  readonly capacity: number;
  /**
   * 持久化去重时间窗（真机验收 Q4：只对最近 2 日内的条目/笔记去重）。
   * 缺省取 model.PERSISTED_DEDUPE_WINDOW_MS；测试可注入更小窗口。
   */
  readonly dedupeWindowMs?: number;
}

export const DEFAULT_INBOX_POLICY: InboxPolicy = {
  capacity: DEFAULT_INBOX_CAPACITY,
  dedupeWindowMs: PERSISTED_DEDUPE_WINDOW_MS,
};

export interface InboxServiceDeps {
  readonly ingest: ClipIngestService;
  readonly inbox: InboxRepository;
  readonly notes: NoteRepository;
  readonly clock: IClock;
  readonly logger: ILogger;
  readonly policy?: InboxPolicy;
}

export enum CaptureKind {
  /** 已写入收件箱 */
  PERSISTED = 'persisted',
  /** 与既有条目幂等合并，未产生新条目 */
  MERGED = 'merged',
  /** 疑似敏感：未落盘，待用户明确决定（条目仅在内存） */
  PENDING_CONFIRM = 'pending_confirm',
  /** 拒绝：空内容或超硬上限 */
  REJECTED = 'rejected',
}

export interface CaptureResult {
  readonly kind: CaptureKind;
  readonly item: ClipboardItem;
  /** 决策依据（类型识别/敏感命中规则 id 等），供 UI 如实展示 */
  readonly reasons: string[];
  /** 本次落盘连带清理的条数（保留期 + 容量淘汰） */
  readonly evicted: number;
}

/** 批量转存结果（Feature 4）：各去向如实分开报告，UI 逐项播报 */
export interface BatchAcceptResult {
  /** 成功转存为笔记的收件箱条目 id */
  readonly acceptedIds: string[];
  /** 与 acceptedIds 一一对应的转存笔记 */
  readonly notes: Note[];
  /** 已确认保存的敏感条目：批量不触碰，需用户逐条处理 */
  readonly skippedSensitive: string[];
  /** 不存在或已不在 PENDING 时间线的条目（并发变化时幂等跳过） */
  readonly skippedNotPending: string[];
  /** 转存过程中抛错的条目 id（日志有各条原因） */
  readonly failed: string[];
}

export class InboxService {
  private readonly policy: InboxPolicy;
  private readonly dedupeWindowMs: number;

  constructor(private readonly deps: InboxServiceDeps) {
    this.policy = deps.policy === undefined ? DEFAULT_INBOX_POLICY : deps.policy;
    this.dedupeWindowMs = this.policy.dedupeWindowMs === undefined
      ? PERSISTED_DEDUPE_WINDOW_MS
      : this.policy.dedupeWindowMs;
  }

  /** 采集入口的统一路径：管线判定 → 按决策落盘或挂起 → 容量/保留期整理 */
  async capture(input: IngestInput): Promise<CaptureResult> {
    const outcome: IngestOutcome = await this.deps.ingest.ingest(input);
    if (outcome.decision === IngestDecision.REJECT) {
      return { kind: CaptureKind.REJECTED, item: outcome.item, reasons: outcome.reasons, evicted: 0 };
    }
    // 注意顺序：敏感判定优先于 merged —— 重复复制同一敏感内容时仍要再次给出确认，
    // 不能因幂等合并而静默跳过提示（merged 只说明"和刚才那条一样"，而那条也未曾落盘）
    if (outcome.decision === IngestDecision.REQUIRE_CONFIRM) {
      return { kind: CaptureKind.PENDING_CONFIRM, item: outcome.item, reasons: outcome.reasons, evicted: 0 };
    }
    if (outcome.merged) {
      return { kind: CaptureKind.MERGED, item: outcome.item, reasons: outcome.reasons, evicted: 0 };
    }
    const persistedDup: CaptureResult | undefined = await this.findPersistedDuplicate(outcome.item);
    if (persistedDup !== undefined) {
      return persistedDup;
    }
    await this.deps.inbox.save(outcome.item);
    const evicted: number = await this.housekeep();
    return { kind: CaptureKind.PERSISTED, item: outcome.item, reasons: outcome.reasons, evicted };
  }

  /**
   * 图片摄取的落盘路径（S2-3）。前提：字节已复制入 blob CAS 并核验（见 ShareIntakeService），
   * 本方法只负责幂等去重 → 收件箱暂存 → 容量/保留期整理。
   * 图片无 REQUIRE_CONFIRM 分支：二进制不走文本敏感规则（见 ClipIngestService.ingestImage）。
   */
  async captureImage(input: IngestImageInput): Promise<CaptureResult> {
    const outcome: IngestOutcome = await this.deps.ingest.ingestImage(input);
    if (outcome.merged) {
      return { kind: CaptureKind.MERGED, item: outcome.item, reasons: outcome.reasons, evicted: 0 };
    }
    const persistedDup: CaptureResult | undefined = await this.findPersistedDuplicate(outcome.item);
    if (persistedDup !== undefined) {
      return persistedDup;
    }
    await this.deps.inbox.save(outcome.item);
    const evicted: number = await this.housekeep();
    return { kind: CaptureKind.PERSISTED, item: outcome.item, reasons: outcome.reasons, evicted };
  }

  /**
   * 持久化去重（真机验收 Q4）：内存 3 秒窗未命中后，查最近 dedupeWindowMs（默认 2 日）内
   * 已落盘的同内容收件箱条目（任意状态）与同来源摘要的未删除笔记 —— 命中即合并，
   * 不产生新条目；窗口外同内容视为新内容正常入库。
   * 敏感内容（REQUIRE_CONFIRM）在调用点之前已分流，不会走到这里被静默合并。
   */
  private async findPersistedDuplicate(item: ClipboardItem): Promise<CaptureResult | undefined> {
    const sinceMs: number = this.deps.clock.nowMs() - this.dedupeWindowMs;
    const inboxHit: ClipboardItem | undefined = await this.deps.inbox.findBySha256Since(
      item.sha256, item.kind, sinceMs);
    if (inboxHit !== undefined) {
      this.deps.logger.log(LogLevel.DEBUG, 'inbox_dedupe_persisted', {
        kind: item.kind,
        entry: item.entry,
        hit: 'inbox',
        hitId: inboxHit.id,
      });
      return {
        kind: CaptureKind.MERGED,
        item: inboxHit,
        reasons: ['dedupe:persisted_within_2d'],
        evicted: 0,
      };
    }
    const noteHit: Note | undefined = await this.deps.notes.findByOriginHashSince(item.sha256, sinceMs);
    if (noteHit !== undefined) {
      this.deps.logger.log(LogLevel.DEBUG, 'inbox_dedupe_persisted', {
        kind: item.kind,
        entry: item.entry,
        hit: 'note',
        hitId: noteHit.id,
      });
      // 命中的是笔记而非收件箱条目：返回本次未落盘的 item 承载上下文，kind=MERGED 表明未产生新条目
      return {
        kind: CaptureKind.MERGED,
        item,
        reasons: ['dedupe:note_within_2d'],
        evicted: 0,
      };
    }
    return undefined;
  }

  /**
   * 用户在敏感提示后明确选择保存：此刻才写入 clipboard_item。
   * 状态由 AWAITING_CONFIRM 转为 PENDING（确认行为本身就是"处理"）。
   * 返回连带清理条数。
   */
  async confirmSave(item: ClipboardItem): Promise<number> {
    if (item.state !== InboxState.AWAITING_CONFIRM) {
      throw new Error(`InboxService.confirmSave: item ${item.id} state=${item.state}, not awaiting confirm`);
    }
    const confirmed: ClipboardItem = {
      id: item.id,
      kind: item.kind,
      rawText: item.rawText,
      structuredJson: item.structuredJson,
      originApp: item.originApp,
      sha256: item.sha256,
      capturedAtMs: item.capturedAtMs,
      expiresAtMs: item.expiresAtMs,
      sensitivity: item.sensitivity,
      state: InboxState.PENDING,
      entry: item.entry,
      truncated: item.truncated,
      originalByteLength: item.originalByteLength,
    };
    await this.deps.inbox.save(confirmed);
    this.deps.logger.log(LogLevel.INFO, 'inbox_sensitive_confirmed', {
      id: confirmed.id,
      sensitivity: confirmed.sensitivity,
      entry: confirmed.entry,
    });
    return this.housekeep();
  }

  /** 用户放弃敏感内容：从未落盘，只留审计日志（不记正文） */
  decline(item: ClipboardItem): void {
    this.deps.logger.log(LogLevel.INFO, 'inbox_sensitive_declined', {
      id: item.id,
      sensitivity: item.sensitivity,
      entry: item.entry,
    });
  }

  /** 收件箱列表：仅 PENDING，按采集时间倒序（时间线） */
  async listPending(limit: number): Promise<ClipboardItem[]> {
    return this.deps.inbox.listByState(InboxState.PENDING, limit);
  }

  async pendingCount(): Promise<number> {
    return this.deps.inbox.countByState(InboxState.PENDING);
  }

  /**
   * 存为笔记：以收件箱条目正文建笔记（首行作标题、来源按入口映射、origin_hash 记内容摘要），
   * 条目标记 ACCEPTED —— 从收件箱列表消失，物理行由保留期清理收尾。
   * 正文判定为 HTML 文档时 contentType 记 'text/html'（S3-3；设计 §4.4），
   * 该笔记此后只能进受控展示页（只读），不进 Markdown 编辑渲染链路。
   * notebookId 缺省落当前默认笔记本（Feature 4 批量转存的笔记本选择入口）。
   */
  async acceptAsNote(id: string, notebookId?: string): Promise<Note> {
    const item: ClipboardItem | undefined = await this.deps.inbox.getById(id);
    if (item === undefined) {
      throw new Error(`InboxService.acceptAsNote: item ${id} not found`);
    }
    if (item.state !== InboxState.PENDING) {
      throw new Error(`InboxService.acceptAsNote: item ${id} state=${item.state}, not pending`);
    }
    return this.acceptItem(item, notebookId);
  }

  /** 单条转存的统一管线（acceptAsNote 与 acceptMany 共用，语义完全一致） */
  private async acceptItem(item: ClipboardItem, notebookId?: string): Promise<Note> {
    const contentType: string = looksLikeHtml(item.rawText) ? CONTENT_TYPE_HTML : 'text/markdown';
    const note: Note = await this.deps.notes.create({
      title: deriveTitle(item.rawText),
      contentMd: item.rawText,
      source: noteSourceOf(item.entry),
      originHash: item.sha256,
      contentType,
      notebookId,
    });
    await this.deps.inbox.updateState(item.id, InboxState.ACCEPTED);
    this.deps.logger.log(LogLevel.INFO, 'inbox_accepted_as_note', {
      id: item.id,
      noteId: note.id,
      kind: item.kind,
      contentType,
    });
    return note;
  }

  /**
   * 批量转存（Feature 4）：逐条走与单条完全相同的 acceptItem 管线；任一条失败
   * 如实报告并继续处理其余（批次不因单条异常整体回滚——各条独立成立）。
   *
   * 口径（计划阶段 4）：批量仅作用于非敏感条目——capture 时已确认保存的敏感条目
   * （sensitivity != NONE）跳过并单独列出，转由用户逐条处理；敏感确认只发生在
   * 落盘前的显式决定，批量不能隐式替代。
   */
  async acceptMany(ids: readonly string[], notebookId?: string): Promise<BatchAcceptResult> {
    const result: BatchAcceptResult = {
      acceptedIds: [],
      notes: [],
      skippedSensitive: [],
      skippedNotPending: [],
      failed: [],
    };
    for (let i: number = 0; i < ids.length; i++) {
      const id: string = ids[i];
      try {
        const item: ClipboardItem | undefined = await this.deps.inbox.getById(id);
        if (item === undefined || item.state !== InboxState.PENDING) {
          result.skippedNotPending.push(id);
          continue;
        }
        if (item.sensitivity !== Sensitivity.NONE) {
          result.skippedSensitive.push(id);
          continue;
        }
        result.notes.push(await this.acceptItem(item, notebookId));
        result.acceptedIds.push(id);
      } catch (err) {
        this.deps.logger.log(LogLevel.WARN, 'inbox_batch_accept_failed', { id, err: String(err) });
        result.failed.push(id);
      }
    }
    this.deps.logger.log(LogLevel.INFO, 'inbox_batch_accepted', {
      accepted: result.acceptedIds.length,
      skippedSensitive: result.skippedSensitive.length,
      skippedNotPending: result.skippedNotPending.length,
      failed: result.failed.length,
    });
    return result;
  }

  /**
   * 批量删除（Feature 4）：逐条走与单条 remove 相同的 PENDING → DISCARDED 管线，
   * 返回实际转 DISCARDED 条数（非 PENDING 幂等跳过；进垃圾桶可恢复）。
   */
  async discardMany(ids: readonly string[]): Promise<number> {
    let count: number = 0;
    for (let i: number = 0; i < ids.length; i++) {
      if (await this.remove(ids[i])) {
        count++;
      }
    }
    if (count > 0) {
      this.deps.logger.log(LogLevel.INFO, 'inbox_batch_discarded', { count });
    }
    return count;
  }

  /**
   * 删除单条：PENDING → DISCARDED（进垃圾桶，可恢复；V5 垃圾桶口径）。
   * 非 PENDING 条目返回 false（幂等：已弃置/已转存的条目不在收件箱时间线上）。
   * 物理移除只在垃圾桶页「彻底删除/清空」发生（permanentlyDelete）。
   */
  async remove(id: string): Promise<boolean> {
    const item: ClipboardItem | undefined = await this.deps.inbox.getById(id);
    if (item === undefined || item.state !== InboxState.PENDING) {
      return false;
    }
    return this.deps.inbox.updateState(id, InboxState.DISCARDED);
  }

  /** 垃圾桶列表：已弃收件箱条目（按采集时间倒序） */
  async listDiscarded(limit: number): Promise<ClipboardItem[]> {
    return this.deps.inbox.listByState(InboxState.DISCARDED, limit);
  }

  /** 从垃圾桶恢复（回 PENDING 时间线） */
  async restoreDiscarded(id: string): Promise<boolean> {
    const item: ClipboardItem | undefined = await this.deps.inbox.getById(id);
    if (item === undefined) {
      return false;
    }
    if (item.state !== InboxState.DISCARDED) {
      throw new Error(`InboxService.restoreDiscarded: item ${id} state=${item.state}, not discarded`);
    }
    return this.deps.inbox.updateState(id, InboxState.PENDING);
  }

  /** 彻底删除单条（仅限 DISCARDED 条目；物理移除不留副本） */
  async permanentlyDelete(id: string): Promise<boolean> {
    const item: ClipboardItem | undefined = await this.deps.inbox.getById(id);
    if (item === undefined) {
      return false;
    }
    if (item.state !== InboxState.DISCARDED) {
      throw new Error(`InboxService.permanentlyDelete: item ${id} state=${item.state}, not discarded`);
    }
    return this.deps.inbox.deleteById(id);
  }

  /** 一键清空收件箱（仅 PENDING 时间线；垃圾桶 DISCARDED 条目由垃圾桶页独立清空）；返回清理条数 */
  async clearAll(): Promise<number> {
    const n: number = await this.deps.inbox.clearPending();
    this.deps.logger.log(LogLevel.INFO, 'inbox_cleared', { count: n });
    return n;
  }

  /** 保留期清理（以注入时钟为准，便于测试与启动路径复用） */
  async purgeExpired(): Promise<number> {
    return this.deps.inbox.purgeExpired(this.deps.clock.nowMs());
  }

  /** 落盘后的整理：先清过期，再按容量淘汰最旧；返回移除总条数 */
  private async housekeep(): Promise<number> {
    let removed: number = await this.purgeExpired();
    removed += await this.enforceCapacity();
    return removed;
  }

  private async enforceCapacity(): Promise<number> {
    const count: number = await this.deps.inbox.countByState(InboxState.PENDING);
    const overflow: number = count - this.policy.capacity;
    if (overflow <= 0) {
      return 0;
    }
    // listByState 按 captured_at DESC，尾部即最旧的 overflow 条
    const items: ClipboardItem[] = await this.deps.inbox.listByState(InboxState.PENDING, count);
    for (let i: number = items.length - overflow; i < items.length; i++) {
      await this.deps.inbox.deleteById(items[i].id);
    }
    this.deps.logger.log(LogLevel.INFO, 'inbox_capacity_evicted', {
      evicted: overflow,
      capacity: this.policy.capacity,
    });
    return overflow;
  }
}

/** 标题取首个非空行（截断 50 字），全空时给兜底名 */
export function deriveTitle(rawText: string): string {
  const lines: string[] = rawText.split('\n');
  for (let i: number = 0; i < lines.length; i++) {
    const t: string = lines[i].trim();
    if (t.length > 0) {
      return t.length > 50 ? `${t.slice(0, 50)}…` : t;
    }
  }
  return '未命名笔记';
}

/** 入口 → 笔记来源映射：分享入分享，其余采集入口统一记剪贴板 */
export function noteSourceOf(entry: ClipEntry): NoteSource {
  return entry === ClipEntry.SHARE ? NoteSource.SHARE : NoteSource.CLIPBOARD;
}
