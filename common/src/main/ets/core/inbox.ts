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
} from './model';
import { ClipIngestService } from './clip';
import { InboxRepository } from './data/inbox-repository';
import { NoteRepository } from './data/note-repository';
import { IClock, ILogger, LogLevel } from './ports';

/** 收件箱容量上限（按 PENDING 条数计，超限淘汰最旧） */
export const DEFAULT_INBOX_CAPACITY: number = 200;

/** 列表页单次加载上限（与容量对齐：一页足以装下全量 PENDING） */
export const INBOX_LIST_LIMIT: number = 200;

export interface InboxPolicy {
  readonly capacity: number;
}

export const DEFAULT_INBOX_POLICY: InboxPolicy = {
  capacity: DEFAULT_INBOX_CAPACITY,
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

export class InboxService {
  private readonly policy: InboxPolicy;

  constructor(private readonly deps: InboxServiceDeps) {
    this.policy = deps.policy === undefined ? DEFAULT_INBOX_POLICY : deps.policy;
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
    await this.deps.inbox.save(outcome.item);
    const evicted: number = await this.housekeep();
    return { kind: CaptureKind.PERSISTED, item: outcome.item, reasons: outcome.reasons, evicted };
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
   */
  async acceptAsNote(id: string): Promise<Note> {
    const item: ClipboardItem | undefined = await this.deps.inbox.getById(id);
    if (item === undefined) {
      throw new Error(`InboxService.acceptAsNote: item ${id} not found`);
    }
    if (item.state !== InboxState.PENDING) {
      throw new Error(`InboxService.acceptAsNote: item ${id} state=${item.state}, not pending`);
    }
    const note: Note = await this.deps.notes.create({
      title: deriveTitle(item.rawText),
      contentMd: item.rawText,
      source: noteSourceOf(item.entry),
      originHash: item.sha256,
    });
    await this.deps.inbox.updateState(id, InboxState.ACCEPTED);
    this.deps.logger.log(LogLevel.INFO, 'inbox_accepted_as_note', {
      id,
      noteId: note.id,
      kind: item.kind,
    });
    return note;
  }

  /** 删除单条：用户明确删除即物理移除，不留副本（隐私口径同"一键清空"） */
  async remove(id: string): Promise<boolean> {
    return this.deps.inbox.deleteById(id);
  }

  /** 一键清空收件箱（全部状态）；返回清理条数 */
  async clearAll(): Promise<number> {
    const n: number = await this.deps.inbox.clearAll();
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
