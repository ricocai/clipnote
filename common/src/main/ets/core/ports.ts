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

/** 摘要：实现必须返回小写 64 位十六进制 SHA-256 */
export interface IHasher {
  sha256Hex(data: string): Promise<string>;
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
  readText(path: string): Promise<string>;
  /** 二进制覆盖写（备份 ZIP 等）；崩溃一致性同样由 atomicfs 协议在上层保证 */
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  rename(fromPath: string, toPath: string): Promise<void>;
  /** 刷新文件（或目录）元数据到存储介质 */
  sync(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** 列出直接子项（文件名，不含目录路径） */
  list(dir: string): Promise<string[]>;
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
