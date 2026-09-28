/**
 * 原子文件写入协议（设计 §4.2「附件写入与恢复协议」第 1 条）。
 *
 *  临时写入并校验 → 同一文件系统内原子改名 → 由调用方在 DB 事务中提交引用
 *
 * 不变量：**绝不出现"DB 已提交引用、文件却不存在或内容不符"**。
 * 因此顺序固定为 文件先落地、引用后提交；崩溃最坏结果是"孤儿文件"（可由恢复扫描回收），
 * 而不是"悬空引用"（不可恢复的数据丢失）。
 */

import { IRandom, IFileStore, LogLevel, ILogger } from './ports';
import { bytesEqual, toHex } from './bytes';

/** 临时文件后缀；恢复扫描必须能识别并清理（设计 §4.2 第 2 条） */
export const TEMP_SUFFIX_MARKER: string = '.tmp-';

export function isTempArtifact(name: string): boolean {
  return name.indexOf(TEMP_SUFFIX_MARKER) >= 0;
}

function dirOf(path: string): string {
  const idx: number = path.lastIndexOf('/');
  return idx < 0 ? '.' : path.slice(0, idx);
}

export interface AtomicWriteOptions {
  /** 写入后回读校验（默认 true）；磁盘满等场景可能截断，必须校验 */
  readonly verify?: boolean;
}

export class AtomicWriter {
  constructor(
    private readonly fs: IFileStore,
    private readonly random: IRandom,
    private readonly logger: ILogger,
  ) {}

  /**
   * 原子写入文本。返回最终落盘的路径。
   * 失败时尽最大努力清理临时文件，并把失败原样抛出（调用方负责保持引用未提交）。
   */
  async write(path: string, data: string, options?: AtomicWriteOptions): Promise<void> {
    const verify: boolean = options === undefined || options.verify !== false;
    const dir: string = dirOf(path);
    await this.fs.mkdirp(dir);

    const nonce: string = toHex(this.random.nextBytes(8));
    const tempPath: string = `${path}${TEMP_SUFFIX_MARKER}${nonce}`;

    try {
      await this.fs.writeRaw(tempPath, data);
      // 临时文件先落盘、再校验，避免"改名成功但内容截断"
      await this.fs.sync(tempPath);
      if (verify) {
        const actual: string = await this.fs.readText(tempPath);
        if (actual !== data) {
          throw new Error(`atomic write verify failed: content mismatch at ${tempPath}`);
        }
      }
      await this.fs.rename(tempPath, path);
      // 目录项同步，保证改名本身对崩溃可见
      await this.fs.sync(dir);
    } catch (err) {
      try {
        if (await this.fs.exists(tempPath)) {
          await this.fs.remove(tempPath);
        }
      } catch (cleanupErr) {
        this.logger.log(LogLevel.WARN, 'atomic_write_cleanup_failed', {
          tempPath,
          reason: String(cleanupErr),
        });
      }
      this.logger.log(LogLevel.ERROR, 'atomic_write_failed', {
        path,
        reason: String(err),
      });
      throw err;
    }
  }

  /**
   * 原子写入二进制（图片等附件字节）。与 write() 完全同一协议：
   * 临时写入 → fsync → 回读字节校验 → 同 FS 原子改名 → fsync 目录。
   * 设计 §4.2 的写入顺序对二进制同样成立 —— 文件先落地、引用后提交。
   */
  async writeBytes(path: string, data: Uint8Array, options?: AtomicWriteOptions): Promise<void> {
    const verify: boolean = options === undefined || options.verify !== false;
    const dir: string = dirOf(path);
    await this.fs.mkdirp(dir);

    const nonce: string = toHex(this.random.nextBytes(8));
    const tempPath: string = `${path}${TEMP_SUFFIX_MARKER}${nonce}`;

    try {
      await this.fs.writeRawBytes(tempPath, data);
      await this.fs.sync(tempPath);
      if (verify) {
        const actual: Uint8Array = await this.fs.readBytes(tempPath);
        if (!bytesEqual(actual, data)) {
          throw new Error(`atomic write verify failed: content mismatch at ${tempPath}`);
        }
      }
      await this.fs.rename(tempPath, path);
      await this.fs.sync(dir);
    } catch (err) {
      try {
        if (await this.fs.exists(tempPath)) {
          await this.fs.remove(tempPath);
        }
      } catch (cleanupErr) {
        this.logger.log(LogLevel.WARN, 'atomic_write_cleanup_failed', {
          tempPath,
          reason: String(cleanupErr),
        });
      }
      this.logger.log(LogLevel.ERROR, 'atomic_write_failed', {
        path,
        reason: String(err),
      });
      throw err;
    }
  }
}
