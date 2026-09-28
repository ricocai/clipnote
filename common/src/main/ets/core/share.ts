/**
 * 分享接收处理（S2-3；设计 §4.1 场景矩阵第 3 行，S1-2 探测报告 §3/§9 采信口径）。
 *
 * 职责边界：
 *  - 输入是**平台无关**的 ShareWantData —— want / Share Kit 的字段提取在 entry 适配层完成，
 *    本文件不出现任何 @kit.* 依赖，全部行为由 tools/ 本机用例覆盖；
 *  - 文本：原样走统一管线（InboxService.capture），与手动粘贴完全同路径；
 *  - 图片：URI 临时授权窗口内"拿到即复制"（探测报告 §3 E23~E25）——
 *    stat 限大小 → readBytes → blob CAS 复制并核验 → blob 记录登记 → InboxService.captureImage。
 *    收件箱条目只保存内容摘要引用（structured_json.ref），**绝不保存外部临时 URI**（设计 §4.1）；
 *  - 失败必须如实上报（降级提示的语料），不静默吞掉：类型不支持 / 超过大小上限 /
 *    URI 不可读（授权过期或 revoked）/ 空分享，各自是不同原因。
 *
 * blob 记录以 ORPHAN_GRACE 登记：收件箱条目对图片的引用**不在** note_attachment 表内
 * （转存为笔记时由后续 Stage 建立正式引用），因此启动恢复扫描会把它们报告为孤儿 ——
 * 这是预期行为，孤儿只进 GC 宽限期、不会被自动删除（设计 §4.2 第 3 条）。
 */

import { BlobStatus, ClipEntry } from './model';
import { BlobCas } from './blob-cas';
import { CaptureKind, CaptureResult, InboxService } from './inbox';
import { BlobRepository } from './data/blob-repository';
import { IFileStore, ILogger, LogLevel } from './ports';

export const SHARE_ACTION_SEND: string = 'ohos.want.action.sendData';
export const SHARE_ACTION_SEND_MULTIPLE: string = 'ohos.want.action.sendMultipleData';

/** 单个分享文件的大小上限：超过即拒绝，字节不读入内存（防误操作/异常数据吃内存） */
export const DEFAULT_MAX_SHARE_FILE_BYTES: number = 32 * 1024 * 1024;

export interface SharePolicy {
  readonly maxFileBytes: number;
}

export const DEFAULT_SHARE_POLICY: SharePolicy = {
  maxFileBytes: DEFAULT_MAX_SHARE_FILE_BYTES,
};

/** 平台无关的分享文件引用：沙箱外 URI + 可选 MIME（缺失时按魔数嗅探） */
export interface ShareFileRef {
  readonly uri: string;
  readonly mime?: string;
}

/** 平台无关的分享载荷：由 entry 适配层从 want / Share Kit 提取为纯数据 */
export interface ShareWantData {
  readonly action?: string;
  readonly texts: string[];
  readonly files: ShareFileRef[];
}

export function isShareAction(action: string | undefined): boolean {
  return action === SHARE_ACTION_SEND || action === SHARE_ACTION_SEND_MULTIPLE;
}

/** 可接收的图片 MIME 清单（与 module.json5 的 UTD 注册保持一致；其余类型明确拒绝） */
const SUPPORTED_IMAGE_MIMES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/heic',
  'image/heif',
  'image/avif',
];

export function isSupportedImageMime(mime: string): boolean {
  const lower: string = mime.toLowerCase();
  return SUPPORTED_IMAGE_MIMES.indexOf(lower) >= 0;
}

/**
 * 魔数嗅探：分享方未提供 MIME 时识别图片。只识别位图/容器头部，
 * 不解析内容；识别不出即返回 undefined（调用方按"类型不支持"处理）。
 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 // ftyp 盒（heic/heif/avif）
  ) {
    return 'image/heic';
  }
  return undefined;
}

/** 拒绝原因即降级提示的语义来源；UI 逐类映射为用户可读文案 */
export enum ShareRejectReason {
  /** 类型不支持（非图片文件、识别不出的内容） */
  UNSUPPORTED_TYPE = 'unsupported_type',
  /** 超过单文件大小上限 */
  FILE_TOO_LARGE = 'file_too_large',
  /** URI 不可读：临时授权已过期/被撤销、文件不存在或读取中断 */
  URI_UNREADABLE = 'uri_unreadable',
  /** 空分享：want 到达但无可接收内容 */
  EMPTY_SHARE = 'empty_share',
}

export interface ShareRejection {
  /** 出问题的对象：文件 URI 或空串（整体性问题）；日志与 UI 只用其做计数/定位，不展示正文 */
  readonly target: string;
  readonly reason: ShareRejectReason;
  readonly detail?: string;
}

export interface ShareIntakeSummary {
  /** false 表示这不是分享 want，调用方不应给出任何分享提示 */
  readonly handled: boolean;
  /** 已写入收件箱的条数（文本 + 图片） */
  readonly persisted: number;
  /** 与既有条目幂等合并的条数（未产生新条目） */
  readonly merged: number;
  /** 管线级拒绝的文本条目（空内容/超硬上限），decision=REJECT 的完整结果 */
  readonly rejectedContent: CaptureResult[];
  /** 疑似敏感、待用户确认的条目（只在内存，未落盘）；携带完整结果供 UI 展示命中依据 */
  readonly pendingConfirm: CaptureResult[];
  /** 分享级拒绝（类型/大小/URI 读取） */
  readonly rejections: ShareRejection[];
  /** 本次落盘连带清理的收件箱条数（容量/保留期） */
  readonly evicted: number;
}

/** 内部可变草稿；对外返回时按只读的 ShareIntakeSummary 交付 */
interface SummaryDraft {
  handled: boolean;
  persisted: number;
  merged: number;
  rejectedContent: CaptureResult[];
  pendingConfirm: CaptureResult[];
  rejections: ShareRejection[];
  evicted: number;
}

function emptyDraft(handled: boolean): SummaryDraft {
  return {
    handled,
    persisted: 0,
    merged: 0,
    rejectedContent: [],
    pendingConfirm: [],
    rejections: [],
    evicted: 0,
  };
}

export interface ShareIntakeDeps {
  readonly inbox: InboxService;
  readonly blobs: BlobCas;
  readonly blobRepo: BlobRepository;
  readonly fs: IFileStore;
  readonly logger: ILogger;
  readonly policy?: SharePolicy;
}

export class ShareIntakeService {
  private readonly policy: SharePolicy;

  constructor(private readonly deps: ShareIntakeDeps) {
    this.policy = deps.policy === undefined ? DEFAULT_SHARE_POLICY : deps.policy;
  }

  /**
   * 处理一次分享。非分享 action 返回 handled=false；其余情况 handled=true 且
   * 每个输入都有确定去向（落盘/合并/待确认/拒绝），绝不静默丢弃。
   */
  async handleShare(data: ShareWantData): Promise<ShareIntakeSummary> {
    if (!isShareAction(data.action)) {
      return emptyDraft(false);
    }
    const out: SummaryDraft = emptyDraft(true);

    if (data.texts.length === 0 && data.files.length === 0) {
      out.rejections.push({ target: '', reason: ShareRejectReason.EMPTY_SHARE });
      this.deps.logger.log(LogLevel.WARN, 'share_intake', {
        persisted: 0, merged: 0, rejected: 1, pending: 0,
      });
      return out;
    }

    // 文本：与手动粘贴完全同一条管线（类型识别 → 敏感判断 → 去重 → 收件箱）
    for (let i: number = 0; i < data.texts.length; i++) {
      const r: CaptureResult = await this.deps.inbox.capture({
        text: data.texts[i],
        entry: ClipEntry.SHARE,
      });
      this.fold(out, r);
    }

    // 图片/文件：URI 授权窗口内复制入沙箱，再走管线图片分支
    for (let i: number = 0; i < data.files.length; i++) {
      await this.intakeFile(data.files[i], out);
    }

    this.deps.logger.log(LogLevel.INFO, 'share_intake', {
      persisted: out.persisted,
      merged: out.merged,
      rejected: out.rejections.length + out.rejectedContent.length,
      pending: out.pendingConfirm.length,
    });
    return out;
  }

  private fold(out: SummaryDraft, r: CaptureResult): void {
    if (r.kind === CaptureKind.PERSISTED) {
      out.persisted++;
      out.evicted += r.evicted;
    } else if (r.kind === CaptureKind.MERGED) {
      out.merged++;
    } else if (r.kind === CaptureKind.PENDING_CONFIRM) {
      out.pendingConfirm.push(r);
    } else {
      out.rejectedContent.push(r);
    }
  }

  /**
   * 单个文件 URI 的接收。顺序即安全边界：先声明类型闸门（声明了非图片类型直接拒绝，
   * 不读字节），再 stat 大小闸门（超限不读入内存），最后才在授权窗口内读取并复制。
   */
  private async intakeFile(file: ShareFileRef, out: SummaryDraft): Promise<void> {
    if (file.mime !== undefined && !isSupportedImageMime(file.mime)) {
      out.rejections.push({ target: file.uri, reason: ShareRejectReason.UNSUPPORTED_TYPE, detail: file.mime });
      return;
    }

    let sizeBytes: number;
    try {
      const st = await this.deps.fs.stat(file.uri);
      if (st === undefined) {
        out.rejections.push({ target: file.uri, reason: ShareRejectReason.URI_UNREADABLE, detail: 'not_found' });
        return;
      }
      sizeBytes = st.size;
    } catch (err) {
      out.rejections.push({ target: file.uri, reason: ShareRejectReason.URI_UNREADABLE, detail: String(err) });
      return;
    }
    if (sizeBytes <= 0) {
      out.rejections.push({ target: file.uri, reason: ShareRejectReason.UNSUPPORTED_TYPE, detail: 'empty_file' });
      return;
    }
    if (sizeBytes > this.policy.maxFileBytes) {
      out.rejections.push({
        target: file.uri,
        reason: ShareRejectReason.FILE_TOO_LARGE,
        detail: `${sizeBytes} > ${this.policy.maxFileBytes}`,
      });
      return;
    }

    // 授权窗口内"拿到即复制"（探测报告 §3：URI 授权随进程退出被系统回收）
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.fs.readBytes(file.uri);
    } catch (err) {
      out.rejections.push({ target: file.uri, reason: ShareRejectReason.URI_UNREADABLE, detail: String(err) });
      return;
    }

    // MIME 缺失时按魔数嗅探；仍非图片则拒绝（不信任分享方声明之外的内容）
    let mime: string;
    if (file.mime !== undefined) {
      mime = file.mime;
    } else {
      const sniffed: string | undefined = sniffImageMime(bytes);
      if (sniffed === undefined) {
        out.rejections.push({ target: file.uri, reason: ShareRejectReason.UNSUPPORTED_TYPE, detail: 'not_image' });
        return;
      }
      mime = sniffed;
    }

    // 复制入 blob CAS 并核验（原子写 + 回读校验在 AtomicWriter 内）；
    // 登记 blob 记录（ORPHAN_GRACE：收件箱引用不是 note_attachment，GC 有宽限期保护）
    const put = await this.deps.blobs.putBytes(bytes);
    await this.deps.blobRepo.saveRecord({
      sha256: put.sha256,
      relativePath: put.relativePath,
      mime,
      size: put.size,
      status: BlobStatus.ORPHAN_GRACE,
    });

    // 走统一管线的图片分支：幂等去重 → 收件箱暂存 → 容量/保留期整理
    const r: CaptureResult = await this.deps.inbox.captureImage({
      sha256: put.sha256,
      sizeBytes: put.size,
      mime,
      entry: ClipEntry.SHARE,
    });
    this.fold(out, r);
  }
}
