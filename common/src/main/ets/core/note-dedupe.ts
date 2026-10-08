/**
 * 笔记周期去重清理（真机验收 Q4：「去重的工作每天或 6h 清理一次」）。
 *
 * 与保存时实时去重（NoteService.save 的 findRecentDuplicate）的分工：
 *  - 实时去重防**新增**重复（保存路径的入口闸）；
 *  - 本服务清理**存量**重复——历史版本没有实时去重时积累的、以及绕过保存路径
 *    （如早期收件箱转存）产生的重复，周期性地收敛掉。
 *
 * 口径：
 *  - 只对最近 windowMs（默认 2 日，PERSISTED_DEDUPE_WINDOW_MS）内**创建**的活体笔记分组；
 *  - 分组键为正文精确相等（与保存去重同口径，可预期、可解释）；
 *  - 每组保留**最早创建**的一篇（原始件），其余软删进回收站——可恢复，不是物理删除；
 *  - 置顶（pinned）笔记优先保留：若组内有置顶件，保留置顶件中最早的一篇。
 *
 * 调度（AppDataRuntime 接线）：启动必跑一次；回前台时距上次运行 > 6h 再跑
 * （NOTE_DEDUPE_INTERVAL_MS 节流，运行时间戳只存内存——重启即重置，启动那次本来就要跑）。
 */

import { Note } from './model';
import { NoteRepository } from './data/note-repository';
import { IClock, ILogger, LogLevel } from './ports';

/** 周期清理的节流间隔（6 小时） */
export const NOTE_DEDUPE_INTERVAL_MS: number = 6 * 60 * 60 * 1000;

/** 单次清理的窗口扫描上限（2 日内笔记数的宽松上限） */
export const NOTE_DEDUPE_CLEANUP_SCAN_LIMIT: number = 1000;

export interface NoteDedupeDeps {
  readonly notes: NoteRepository;
  readonly clock: IClock;
  readonly logger: ILogger;
}

export interface NoteDedupeReport {
  /** 窗口内扫描的活体笔记数 */
  readonly scanned: number;
  /** 发现的重复合（同正文 ≥2 篇）数 */
  readonly duplicateGroups: number;
  /** 软删（移入回收站）的重复笔记数 */
  readonly trashed: number;
  /** 距上次运行不足节流间隔而跳过 */
  readonly skipped: boolean;
}

/**
 * 执行一次窗口去重清理。force=true 忽略节流（启动路径用）；
 * 否则距上次运行不足 NOTE_DEDUPE_INTERVAL_MS 直接 skipped 返回。
 */
export class NoteDedupeService {
  private lastRunMs: number = 0;

  constructor(private readonly deps: NoteDedupeDeps) {}

  async run(windowMs: number, force: boolean = false): Promise<NoteDedupeReport> {
    const now: number = this.deps.clock.nowMs();
    if (!force && now - this.lastRunMs < NOTE_DEDUPE_INTERVAL_MS) {
      return { scanned: 0, duplicateGroups: 0, trashed: 0, skipped: true };
    }
    this.lastRunMs = now;

    const recent: Note[] = await this.deps.notes.listCreatedSince(
      now - windowMs, NOTE_DEDUPE_CLEANUP_SCAN_LIMIT);

    // 按正文分组（保持 listCreatedSince 的创建时间升序，组内首篇即最早）
    const groups: Map<string, Note[]> = new Map<string, Note[]>();
    for (let i: number = 0; i < recent.length; i++) {
      const n: Note = recent[i];
      const g: Note[] | undefined = groups.get(n.contentMd);
      if (g === undefined) {
        groups.set(n.contentMd, [n]);
      } else {
        g.push(n);
      }
    }

    let duplicateGroups: number = 0;
    let trashed: number = 0;
    for (const members of groups.values()) {
      if (members.length < 2) {
        continue;
      }
      duplicateGroups++;
      // 保留件：组内有置顶则保留置顶的最早一篇，否则保留最早一篇；其余软删
      let keep: Note = members[0];
      for (let i = 0; i < members.length; i++) {
        if (members[i].pinned) {
          keep = members[i];
          break;
        }
      }
      for (let i = 0; i < members.length; i++) {
        if (members[i].id === keep.id) {
          continue;
        }
        try {
          await this.deps.notes.softDelete(members[i].id);
          trashed++;
        } catch (err) {
          // 单篇失败不阻断整轮（下轮再收敛），如实记录
          this.deps.logger.log(LogLevel.WARN, 'note_dedupe_trash_failed', {
            id: members[i].id, error: String(err),
          });
        }
      }
    }

    const report: NoteDedupeReport = {
      scanned: recent.length,
      duplicateGroups,
      trashed,
      skipped: false,
    };
    this.deps.logger.log(LogLevel.INFO, 'note_dedupe_cleanup', {
      scanned: report.scanned,
      duplicateGroups: report.duplicateGroups,
      trashed: report.trashed,
      windowDays: Math.round(windowMs / (24 * 60 * 60 * 1000)),
    });
    return report;
  }
}
