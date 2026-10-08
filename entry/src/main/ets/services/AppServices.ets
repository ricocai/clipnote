import { bundleManager } from '@kit.AbilityKit';
import {
  AppContextHolder,
  AppDataRuntime,
  AppSettingsStore,
  BackupService,
  BlobCas,
  ClipIngestService,
  CryptoHasher,
  CryptoRandom,
  ExportKind,
  ExportService,
  HilogLogger,
  InboxService,
  NotebookService,
  NoteService,
  ReadableExportResult,
  SandboxFileStore,
  ShareIntakeService,
  SystemClock,
  SystemShareHandoff,
} from 'common';
import {
  PreferencesTtsSettingsStore,
  SystemTtsDriver,
  SystemTtsEngine,
} from 'speech';
import { McpService } from './McpService';
import { BackupEntry } from './BackupEntry';
import { GlobalPlayback } from './GlobalPlayback';

/**
 * 依赖装配（最薄的一层；S3-1 从 Index 页抽出为独立模块，供收件箱页 / 笔记列表页 / 编辑页共用）。
 *
 * 只做实例化与注入，不含任何业务规则 —— 业务规则全部在 common/core 内（由本机用例覆盖）。
 * 这样做的直接收益：UI 这一层（无法在本机自动化验证的部分）尽可能没有可出错的逻辑。
 *
 * 注意：笔记附件的 CAS 只有一份 —— AppDataRuntime.blobCas（根 = context.filesDir，
 * 与启动恢复扫描共用同一实例与同一套路径口径）。不要在 UI 层另建 BlobCas 写附件，
 * 否则恢复扫描会把"已提交引用"误判为缺失（G5 阻断项）。
 * 本类保留的 blobs 是 G1 探针期实例（根 = filesDir/clipnote），不承担附件写入路径。
 */
export class AppServices {
  private static instance: AppServices | undefined = undefined;

  readonly clock: SystemClock = new SystemClock();
  readonly logger: HilogLogger = new HilogLogger();
  readonly random: CryptoRandom = new CryptoRandom();
  readonly hasher: CryptoHasher = new CryptoHasher();
  readonly fs: SandboxFileStore = new SandboxFileStore();
  readonly ingest: ClipIngestService;
  readonly blobs: BlobCas;

  private inboxSvc: InboxService | undefined = undefined;
  private noteSvc: NoteService | undefined = undefined;
  private notebookSvc: NotebookService | undefined = undefined;
  private shareSvc: ShareIntakeService | undefined = undefined;
  private mcpSvc: McpService | undefined = undefined;
  private appVersion: string | undefined = undefined;
  private backupEntryInst: BackupEntry | undefined = undefined;
  private engineInst: SystemTtsEngine | undefined = undefined;
  private globalPlaybackInst: GlobalPlayback | undefined = undefined;
  private settingsStoreInst: AppSettingsStore | undefined = undefined;

  private constructor() {
    const root: string = AppContextHolder.filesDir();
    this.ingest = new ClipIngestService({
      clock: this.clock,
      hasher: this.hasher,
      random: this.random,
      logger: this.logger,
    });
    this.blobs = new BlobCas(`${root}/clipnote`, this.fs, this.hasher, this.logger, this.random);
  }

  static get(): AppServices {
    if (AppServices.instance === undefined) {
      AppServices.instance = new AppServices();
    }
    return AppServices.instance;
  }

  /** 收件箱服务：依赖数据层就绪（打开库 → 迁移 → 恢复扫描 → 保留期清理，见 AppDataRuntime） */
  async inboxService(): Promise<InboxService> {
    if (this.inboxSvc === undefined) {
      const rt: AppDataRuntime = await AppDataRuntime.whenReady();
      this.inboxSvc = new InboxService({
        ingest: this.ingest,
        inbox: rt.inbox,
        notes: rt.notes,
        clock: this.clock,
        logger: this.logger,
      });
    }
    return this.inboxSvc;
  }

  /** 笔记服务（S3-1）：与收件箱服务共用同一数据层运行时与同一附件 CAS */
  async noteService(): Promise<NoteService> {
    if (this.noteSvc === undefined) {
      const rt: AppDataRuntime = await AppDataRuntime.whenReady();
      this.noteSvc = new NoteService({
        db: rt.executor,
        notes: rt.notes,
        search: rt.search,
        blobs: rt.blobs,
        blobCas: rt.blobCas,
        hasher: this.hasher,
        clock: this.clock,
        logger: this.logger,
      });
    }
    return this.noteSvc;
  }

  /** 笔记本服务（V5 / Feature 1）：与笔记服务共用同一数据层运行时 */
  async notebookService(): Promise<NotebookService> {
    if (this.notebookSvc === undefined) {
      const rt: AppDataRuntime = await AppDataRuntime.whenReady();
      this.notebookSvc = new NotebookService({
        db: rt.executor,
        notes: rt.notes,
        clock: this.clock,
        random: this.random,
        logger: this.logger,
      });
    }
    return this.notebookSvc;
  }

  /**
   * 分享接收服务（S2-3）。图片字节一律进 AppDataRuntime 的 CAS（与启动恢复扫描同一棵
   * blobs/ 树）；本类的 this.blobs 是 G1 探针期独立根目录实例，分享路径不得使用它
   * （否则恢复扫描核对不到分享图片，G5 阻断项）。
   */
  async shareIntakeService(): Promise<ShareIntakeService> {
    if (this.shareSvc === undefined) {
      const rt: AppDataRuntime = await AppDataRuntime.whenReady();
      this.shareSvc = new ShareIntakeService({
        inbox: await this.inboxService(),
        blobs: rt.blobCas,
        blobRepo: rt.blobs,
        fs: this.fs,
        logger: this.logger,
      });
    }
    return this.shareSvc;
  }

  /**
   * 系统离线 TTS 引擎（S5-1/5-2 单例）：音色/语速持久化走 preferences。
   * 引擎是「无 UI 状态」组件，进程内只建一份；播放调度（SpeechPlaybackController）
   * 由使用方（阅读页）各自持有——控制器绑定 UI 回调，不进单例。
   */
  speechEngine(): SystemTtsEngine {
    if (this.engineInst === undefined) {
      const ctx = AppContextHolder.get();
      if (ctx === undefined) {
        throw new Error('AppContext 未初始化——EntryAbility 必须先 AppContextHolder.set()');
      }
      this.engineInst = new SystemTtsEngine(
        new SystemTtsDriver(),
        new PreferencesTtsSettingsStore(ctx),
      );
    }
    return this.engineInst;
  }

  /**
   * 全局朗读播放（第二批 Feature 5+9）：控制器生命周期与进程同寿命，
   * 阅读页只租借 UI 回调；AVSession 播控与长时任务随播放惰性启停。
   */
  globalPlayback(): GlobalPlayback {
    if (this.globalPlaybackInst === undefined) {
      this.globalPlaybackInst = new GlobalPlayback(this);
    }
    return this.globalPlaybackInst;
  }

  /** 功能开关持久化（Feature 6/9）：preferences 存储，内存缓存 */
  settingsStore(): AppSettingsStore {
    if (this.settingsStoreInst === undefined) {
      const ctx = AppContextHolder.get();
      if (ctx === undefined) {
        throw new Error('AppContext 未初始化——EntryAbility 必须先 AppContextHolder.set()');
      }
      this.settingsStoreInst = new AppSettingsStore(ctx);
    }
    return this.settingsStoreInst;
  }

  /**
   * MCP 局域网服务（S6-7；设计 §4.5.3）：单例协调器。
   * 开关状态内存态（重启默认关，安全默认 = 默认拒绝）；实际启停由
   * EntryAbility 前台/后台回调与设置页开关驱动（见 McpService 头注释）。
   */
  mcpService(): McpService {
    if (this.mcpSvc === undefined) {
      this.mcpSvc = new McpService({
        clock: this.clock,
        random: this.random,
        hasher: this.hasher,
        fs: this.fs,
        logger: this.logger,
        noteService: () => this.noteService(),
      });
    }
    return this.mcpSvc;
  }

  /**
   * 备份/恢复入口（WHY-131 条件 A；设计 §4.2「可恢复备份」）：设置页接线面。
   * 薄装配 —— 恢复语义全在 common 的 BackupService（先校验→暂存→单事务原子替换），
   * 此处只提供装配好的入口；导出 ≠ 备份的文案区分在设置页（V1.4 F06）。
   */
  backupEntry(): BackupEntry {
    if (this.backupEntryInst === undefined) {
      this.backupEntryInst = new BackupEntry({
        random: this.random,
        logger: this.logger,
        backup: async (): Promise<BackupService> => {
          const rt: AppDataRuntime = await AppDataRuntime.whenReady();
          return rt.getBackupService(await this.resolveAppVersion());
        },
      });
    }
    return this.backupEntryInst;
  }

  /**
   * 阅读页附件字节通道：只按内容摘要经 BlobCas 寻址读取（路径完全由摘要派生，
   * 天然无越界风险；设计 §4.4「文件映射只按授权附件 ID 查找」）。
   */
  async readAttachmentBytes(sha: string): Promise<Uint8Array> {
    const rt: AppDataRuntime = await AppDataRuntime.whenReady();
    return rt.blobCas.readBytes(sha);
  }

  /** 应用版本名（导出包 README 署名用）；查询失败如实降级为 unknown，不阻断导出 */
  private async resolveAppVersion(): Promise<string> {
    if (this.appVersion === undefined) {
      try {
        const info = await bundleManager.getBundleInfoForSelf(
          bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
        this.appVersion = info.versionName;
      } catch (err) {
        this.appVersion = 'unknown';
      }
    }
    return this.appVersion;
  }

  /** 可读导出服务（S4-2）：数据层就绪后由 AppDataRuntime 装配（产物在 filesDir/exports/） */
  async exportService(): Promise<ExportService> {
    const rt: AppDataRuntime = await AppDataRuntime.whenReady();
    return rt.getExportService(await this.resolveAppVersion());
  }

  /**
   * 导出并交接（S4-2 三处入口共用）：先落盘并登记导出记录，再拉起系统分享面板。
   * 面板拉起失败不抹掉导出事实（记录已入库、产物在 exports/），错误抛给调用方如实提示。
   */
  async exportAndShare(noteIds: string[], kind: ExportKind): Promise<ReadableExportResult> {
    const svc: ExportService = await this.exportService();
    const result: ReadableExportResult =
      kind === 'single' ? await svc.exportSingle(noteIds[0])
        : kind === 'full' ? await svc.exportAll()
          : await svc.exportBatch(noteIds);
    const path: string = result.record.filePath;
    const name: string = path.slice(path.lastIndexOf('/') + 1);
    const ctx = AppContextHolder.get();
    if (ctx === undefined) {
      throw new Error('分享交接不可用：应用上下文未就绪（导出已完成，可在设置页查看记录）');
    }
    await new SystemShareHandoff(ctx).shareFile(path, name);
    return result;
  }
}
