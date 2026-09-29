/**
 * 端口（Port）定义 —— 领域内核与平台之间的全部接触面。
 *
 * 鸿蒙实现放在 `common/src/main/ets/adapters/`（`@ohos.*`），本机测试实现在 `tools/test/support/`。
 * 设计 §2「平台抽象层」、§5「可测试性：平台抽象层全部 Mock」。
 */

import { BlobSha256 } from './model';

/** 时间源：可注入固定时钟，保证时间相关单测确定性 */
export interface IClock {
  nowMs(): number;
}

/** 摘要：实现必须返回小写 64 位十六进制 SHA-256（文本与字节两个入口语义一致） */
export interface IHasher {
  sha256Hex(data: string): Promise<string>;
  /** 对原始字节取摘要：图片等二进制附件的内容寻址入口（设计 §4.2） */
  sha256HexBytes(data: Uint8Array): Promise<string>;
}

/** 随机源：UUID v7 与临时文件名使用 */
export interface IRandom {
  nextBytes(length: number): Uint8Array;
}

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

/**
 * 日志。审计要求：记录客户端、操作、对象 ID、结果与时间，**不记完整正文**（设计 §4.5.5）。
 */
export interface ILogger {
  log(level: LogLevel, event: string, fields: Record<string, string | number | boolean>): void;
}

export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly kind: FileKind;
}

export enum FileKind {
  FILE = 'file',
  DIR = 'dir',
  OTHER = 'other',
}

/**
 * 最小文件原语集合。
 * 刻意**不**提供 `atomicWrite` —— 原子写入协议（临时写入 → fsync → 同 FS 改名 → fsync 目录）
 * 是领域逻辑，由 `atomicfs.ts` 复用本接口实现（设计 §4.2 附件写入顺序）。
 */
export interface IFileStore {
  mkdirp(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | undefined>;
  /** 覆盖写；不保证崩溃一致性 */
  writeRaw(path: string, data: string): Promise<void>;
  /** 二进制覆盖写；与 writeRaw 同为原语，原子性由 atomicfs.ts 的协议保证 */
  writeRawBytes(path: string, data: Uint8Array): Promise<void>;
  readText(path: string): Promise<string>;
  /** 读取原始字节（图片附件回读校验用） */
  readBytes(path: string): Promise<Uint8Array>;
  rename(fromPath: string, toPath: string): Promise<void>;
  /** 刷新文件（或目录）元数据到存储介质 */
  sync(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** 列出直接子项（文件名，不含目录路径） */
  list(dir: string): Promise<string[]>;
}

/**
 * 剪贴板接触面（S2-4；实现只允许放在 adapters/，@kit 不下沉到 core）。
 *
 * 口径约束（WHY-96，设计 §4.1）：
 *  - hasData 只回答"有没有内容"，**永不读内容** —— 回前台提示的"不自动读取"以此法
 *    无权限依赖为前提（G1 探测报告 §1：API 12 受管控读取清单不含 hasData）；
 *  - readText 只取主文本；失败必须抛出真实错误，不得吞错返回空串（"不得静默丢弃"）；
 *  - 实现可以把 hasData 的异常折叠为 false（探测失败＝无提示、不打扰），其余不得伪装。
 */
export interface ClipboardProbe {
  hasData(): Promise<boolean>;
  readText(): Promise<string>;
}

export enum PasteboardPermissionState {
  /** 系统记录为已授权 */
  GRANTED = 'granted',
  /** 系统记录为未授权 */
  DENIED = 'denied',
  /** 应用无法查询（系统接口受限）—— UI 必须如实展示，不得当成"未授权" */
  UNKNOWN = 'unknown',
}

/**
 * 权限状态快照（S2-4 设置页展示用）。
 * 注意：这只是**状态展示**，不是安全判定 —— 应用查不到系统级"剪贴板策略"开关，
 * 也改不了它；安全边界由"用户手势触发读取 + 敏感不落盘"承担，不由本快照承担。
 */
export interface PermissionStatusReport {
  readonly pasteboardState: PasteboardPermissionState;
  /** 通知栏开关是否开启；查不到时按 false 展示，配合 notificationKnown 如实措辞 */
  readonly notificationEnabled: boolean;
  readonly notificationKnown: boolean;
  readonly bundleName: string;
}

export interface PermissionStatusProbe {
  fetch(): Promise<PermissionStatusReport>;
  /** 跳转系统设置的本应用详情页；返回拉起是否成功（失败时 UI 给手动路径文案） */
  openAppSettings(): Promise<boolean>;
}

/**
 * 系统分享交接（S4-2；设计 §4.4「外部交接是数据交接行为：沙箱路径可能不可读，
 * 走受控导出/分享机制并验证临时权限」）。
 *
 * 口径：只交接**已落盘的导出产物**（沙箱绝对路径）；实现侧负责 file:// URI 转换
 * 与临时授权。返回值只表示"系统分享面板是否成功拉起"，不承诺接收方完成保存——
 * 交接结果以导出记录（ExportRecord）为准，不以对端行为为准。
 */
export interface ShareHandoff {
  shareFile(absPath: string, displayName: string): Promise<boolean>;
}

/** 附件与备份的完整性核对结果（设计 §4.2 恢复扫描 / §8 G5） */
export interface BlobReconcileReport {
  /** **必须为 0** 才能发布：被引用但文件缺失 —— 绝不允许"笔记已提交但引用文件缺失" */
  readonly missing: BlobSha256[];
  /** 无引用者：进入 GC 宽限期，宁可留孤儿也不删被引用文件 */
  readonly orphans: BlobSha256[];
  /** 文件内容与文件名摘要不符（仅在 verifyHash=true 时非空） */
  readonly mismatched: BlobSha256[];
  readonly scanned: number;
}
