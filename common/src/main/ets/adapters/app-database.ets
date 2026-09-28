import { common } from '@kit.AbilityKit';
import { IClock, IHasher, ILogger, IRandom, LogLevel } from '../core/ports';
import { BlobCas } from '../core/blob-cas';
import { IRdbExecutor } from '../core/data/rdb';
import { SchemaMigrator } from '../core/data/migrator';
import { NoteRepository } from '../core/data/note-repository';
import { InboxRepository } from '../core/data/inbox-repository';
import { BlobRepository } from '../core/data/blob-repository';
import { StartupRecoveryReport, runStartupRecovery } from '../core/data/recovery';
import { RelationalStoreExecutor } from './relational-store';
import { SandboxFileStore } from './file-store';

/**
 * 数据层装配与启动恢复接线（S2-1；设计 §4.2 写入恢复协议第 2 条）。
 *
 * EntryAbility.onCreate 调用 `init()`，顺序固定为：
 *   打开库 → schema 迁移 → 装配仓储 → 启动恢复扫描（临时残留清理 + 孤儿宽限期 +
 *   完整性事故上报）→ 收件箱保留期清理（S2-2）→ 就绪
 *
 * 恢复扫描完成前 `current()` 不可用：UI 层必须等 init 完成（或显式处理未就绪态），
 * 防止在"可能有缺失附件"的未核对状态下渲染笔记。UI 侧用 `whenReady()` 等待同一 Promise。
 */
export class AppDataRuntime {
  private static instance: AppDataRuntime | undefined = undefined;
  private static initPromise: Promise<AppDataRuntime> | undefined = undefined;

  readonly executor: IRdbExecutor;
  readonly notes: NoteRepository;
  readonly inbox: InboxRepository;
  readonly blobs: BlobRepository;
  readonly blobCas: BlobCas;
  recoveryReport: StartupRecoveryReport | undefined = undefined;

  private constructor(
    executor: IRdbExecutor,
    notes: NoteRepository,
    inbox: InboxRepository,
    blobs: BlobRepository,
    blobCas: BlobCas,
  ) {
    this.executor = executor;
    this.notes = notes;
    this.inbox = inbox;
    this.blobs = blobs;
    this.blobCas = blobCas;
  }

  static isReady(): boolean {
    return AppDataRuntime.instance !== undefined;
  }

  /** UI 等待数据就绪的统一入口（init 由 EntryAbility 发起，本方法可重复调用） */
  static whenReady(): Promise<AppDataRuntime> {
    const p: Promise<AppDataRuntime> | undefined = AppDataRuntime.initPromise;
    if (p === undefined) {
      throw new Error('AppDataRuntime: init() not called; expected in EntryAbility.onCreate');
    }
    return p;
  }

  static current(): AppDataRuntime {
    const rt: AppDataRuntime | undefined = AppDataRuntime.instance;
    if (rt === undefined) {
      throw new Error('AppDataRuntime: not initialized; call init() in EntryAbility.onCreate');
    }
    return rt;
  }

  static init(
    context: common.UIAbilityContext,
    clock: IClock,
    random: IRandom,
    hasher: IHasher,
    logger: ILogger,
  ): Promise<AppDataRuntime> {
    if (AppDataRuntime.initPromise === undefined) {
      AppDataRuntime.initPromise = AppDataRuntime.doInit(context, clock, random, hasher, logger);
    }
    return AppDataRuntime.initPromise;
  }

  private static async doInit(
    context: common.UIAbilityContext,
    clock: IClock,
    random: IRandom,
    hasher: IHasher,
    logger: ILogger,
  ): Promise<AppDataRuntime> {
    const executor: RelationalStoreExecutor = await RelationalStoreExecutor.open(context, logger);
    await new SchemaMigrator(executor, logger).migrate();

    const notes: NoteRepository = new NoteRepository({ db: executor, clock, random, logger });
    const inbox: InboxRepository = new InboxRepository({ db: executor, logger });
    const blobs: BlobRepository = new BlobRepository({ db: executor, logger });
    const blobCas: BlobCas = new BlobCas(context.filesDir, new SandboxFileStore(), hasher, logger, random);

    const runtime: AppDataRuntime = new AppDataRuntime(executor, notes, inbox, blobs, blobCas);
    runtime.recoveryReport = await runStartupRecovery({ blobRepository: blobs, blobCas, logger });
    // 收件箱保留期清理（S2-2，设计 §4.1）：启动即清，不依赖用户是否打开收件箱页
    const purged: number = await inbox.purgeExpired(clock.nowMs());
    if (purged > 0) {
      logger.log(LogLevel.INFO, 'inbox_purge_expired_at_startup', { count: purged });
    }
    AppDataRuntime.instance = runtime;
    return runtime;
  }
}
