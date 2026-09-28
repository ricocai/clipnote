/**
 * 附件内容寻址存储（Content-Addressed Storage）。
 * 设计 §4.2：blob 由关系库引用并经内容摘要校验；图片字节不在 SQLite 表内，
 * DB 事务**不**保护文件写入 —— 故写入顺序与恢复扫描是这一层的核心职责。
 */

import { BlobSha256 } from './model';
import {
  BlobReconcileReport,
  FileKind,
  IFileStore,
  IHasher,
  ILogger,
  IRandom,
  LogLevel,
} from './ports';
import { AtomicWriter, isTempArtifact } from './atomicfs';
import { utf8ByteLength } from './bytes';

/** blob 根目录（沙箱内相对路径） */
export const BLOB_ROOT: string = 'blobs';

const SHA256_RE: RegExp = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
  return SHA256_RE.test(value);
}

/**
 * 内容寻址相对路径：`blobs/<sha[0:2]>/<sha[2:4]>/<sha>`
 * 两级分片避免单目录文件数过大；路径完全由摘要派生，天然无越界风险。
 */
export function blobRelativePath(sha: string): string {
  if (!isSha256Hex(sha)) {
    throw new Error(`blobRelativePath: invalid sha256 "${sha.slice(0, 16)}"`);
  }
  return `${BLOB_ROOT}/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
}

export interface BlobPutResult {
  readonly sha256: BlobSha256;
  readonly relativePath: string;
  readonly size: number;
  /** 命中已有同摘要文件，未重复写入（去重） */
  readonly deduped: boolean;
}

export interface ReconcileOptions {
  /** 逐文件重新计算摘要，代价高但能发现内容被篡改/截断（G5 恢复演练使用） */
  readonly verifyHash?: boolean;
  /** 临时文件（`.tmp-*`）视为可清理残留 */
  readonly removeTempArtifacts?: boolean;
}

export class BlobCas {
  private readonly writer: AtomicWriter;

  constructor(
    private readonly root: string,
    private readonly fs: IFileStore,
    private readonly hasher: IHasher,
    private readonly logger: ILogger,
    random: IRandom,
  ) {
    this.writer = new AtomicWriter(fs, random, logger);
  }

  async put(text: string): Promise<BlobPutResult> {
    const sha: string = await this.hasher.sha256Hex(text);
    const relativePath: string = blobRelativePath(sha);
    const absolute: string = this.absolute(relativePath);
    const size: number = utf8ByteLength(text);

    if (await this.exists(sha)) {
      return { sha256: sha, relativePath, size, deduped: true };
    }

    await this.writer.write(absolute, text);
    this.logger.log(LogLevel.INFO, 'blob_put', { sha256: sha, size });
    return { sha256: sha, relativePath, size, deduped: false };
  }

  async exists(sha: string): Promise<boolean> {
    if (!isSha256Hex(sha)) {
      return false;
    }
    return this.fs.exists(this.absolute(blobRelativePath(sha)));
  }

  async read(sha: string): Promise<string> {
    return this.fs.readText(this.absolute(blobRelativePath(sha)));
  }

  /**
   * 校验指定摘要的内容是否与文件名一致。用于恢复演练与 GC 前的引用核对。
   */
  async verify(sha: string): Promise<boolean> {
    if (!(await this.exists(sha))) {
      return false;
    }
    const content: string = await this.read(sha);
    return (await this.hasher.sha256Hex(content)) === sha;
  }

  /**
   * 恢复扫描（启动时执行）。
   * 输入为当前 DB 中所有 blobs 表里 `status = referenced` 的摘要集合。
   * 输出报告；`missing` 非空即视为完整性事故，按 G5 阻断发布。
   */
  async reconcile(referenced: ReadonlySet<string>, options?: ReconcileOptions): Promise<BlobReconcileReport> {
    const verifyHash: boolean = options !== undefined && options.verifyHash === true;
    const removeTempArtifacts: boolean = options === undefined || options.removeTempArtifacts !== false;

    const found: Set<string> = new Set<string>();
    const mismatched: string[] = [];
    let scanned: number = 0;

    // 注意：必须从 blob 根（<root>/blobs）开始遍历，而不是 <root>：
    // 分级路径是 blobs/<2>/<2>/<sha>，从 <root> 起算会少下探一层，导致全部误报为 missing。
    const shardRoot: string = this.absolute(BLOB_ROOT);
    const dirs: string[] = await this.listDirs(shardRoot);
    for (let d: number = 0; d < dirs.length; d++) {
      const l1: string = dirs[d];
      const l2dirs: string[] = await this.listDirs(`${shardRoot}/${l1}`);
      for (let e: number = 0; e < l2dirs.length; e++) {
        const l2: string = l2dirs[e];
        const dirPath: string = `${shardRoot}/${l1}/${l2}`;
        const names: string[] = await this.safeList(dirPath);
        for (let i: number = 0; i < names.length; i++) {
          const name: string = names[i];
          if (isTempArtifact(name)) {
            if (removeTempArtifacts) {
              await this.fs.remove(`${dirPath}/${name}`);
            }
            continue;
          }
          if (!isSha256Hex(name)) {
            continue;
          }
          scanned++;
          found.add(name);
          if (verifyHash) {
            const ok: boolean = await this.verify(name);
            if (!ok) {
              mismatched.push(name);
            }
          }
        }
      }
    }

    const missing: string[] = [];
    const orphanSet: Set<string> = new Set<string>();
    referenced.forEach((sha: string) => {
      if (!found.has(sha)) {
        missing.push(sha);
      }
    });
    found.forEach((sha: string) => {
      if (!referenced.has(sha)) {
        orphanSet.add(sha);
      }
    });

    const report: BlobReconcileReport = {
      missing: missing.sort(),
      orphans: Array.from(orphanSet).sort(),
      mismatched: mismatched.sort(),
      scanned,
    };
    this.logger.log(LogLevel.INFO, 'blob_reconcile', {
      scanned,
      missing: report.missing.length,
      orphans: report.orphans.length,
      mismatched: report.mismatched.length,
    });
    return report;
  }

  /**
   * GC：仅回收报告中被判定为孤儿的 blob，并且**调用方必须**已二次确认
   * 它们未被回收站、备份快照或其他笔记引用（设计 §4.2 第 3 条：GC 经宽限期）。
   */
  async collectGarbage(confirmedOrphans: readonly string[]): Promise<number> {
    let removed: number = 0;
    for (let i: number = 0; i < confirmedOrphans.length; i++) {
      const sha: string = confirmedOrphans[i];
      if (!isSha256Hex(sha)) {
        continue;
      }
      const path: string = this.absolute(blobRelativePath(sha));
      if (await this.fs.exists(path)) {
        await this.fs.remove(path);
        removed++;
      }
    }
    this.logger.log(LogLevel.INFO, 'blob_gc', { removed });
    return removed;
  }

  absolute(relativePath: string): string {
    return `${this.root}/${relativePath}`;
  }

  private async listDirs(path: string): Promise<string[]> {
    const names: string[] = await this.safeList(path);
    const dirs: string[] = [];
    for (let i: number = 0; i < names.length; i++) {
      const st = await this.fs.stat(`${path}/${names[i]}`);
      if (st !== undefined && st.kind === FileKind.DIR) {
        dirs.push(names[i]);
      }
    }
    return dirs;
  }

  /** 目录不存在时返回空列表，而不是抛错 —— 首装场景不应报异常 */
  private async safeList(dir: string): Promise<string[]> {
    try {
      if (!(await this.fs.exists(dir))) {
        return [];
      }
      return await this.fs.list(dir);
    } catch (err) {
      this.logger.log(LogLevel.WARN, 'blob_list_failed', { dir, reason: String(err) });
      return [];
    }
  }
}
