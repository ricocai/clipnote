/**
 * 本机测试用平台实现（Node）。
 *
 * 这些实现**不是交付物**，只是设计 §5「可测试性：平台抽象层全部 Mock」在本机的落地：
 * 鸿蒙侧的实现位于 `common/src/main/ets/adapters/`，两者必须满足同一组接口契约。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import {
  FileKind,
  FileStat,
  IClock,
  IFileStore,
  IHasher,
  ILogger,
  IRandom,
  LogLevel,
} from '../../../common/src/main/ets/core/ports';
import { MdToken, IMarkdownTokenizer } from '../../../common/src/main/ets/core/markdown';

export class FixedClock implements IClock {
  constructor(private ms: number) {}
  nowMs(): number {
    return this.ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

/** 确定性随机源：i 递增填充，便于断言 UUID 与临时文件名 */
export class SequentialRandom implements IRandom {
  private counter: number = 0;
  nextBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      this.counter = (this.counter + 1) & 0xff;
      out[i] = this.counter;
    }
    return out;
  }
}

export class NodeHasher implements IHasher {
  async sha256Hex(data: string): Promise<string> {
    return crypto.createHash('sha256').update(Buffer.from(data, 'utf8')).digest('hex');
  }
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Record<string, string | number | boolean>;
}

export class CapturingLogger implements ILogger {
  readonly records: LogRecord[] = [];
  log(level: LogLevel, event: string, fields: Record<string, string | number | boolean>): void {
    this.records.push({ level, event, fields });
  }
  has(event: string): boolean {
    return this.records.some((r) => r.event === event);
  }
  clear(): void {
    this.records.length = 0;
  }
}

class NodeFileStat implements FileStat {
  constructor(
    readonly size: number,
    readonly mtimeMs: number,
    readonly kind: FileKind,
  ) {}
}

function fileKindOf(st: fs.Stats): FileKind {
  if (st.isDirectory()) {
    return FileKind.DIR;
  }
  if (st.isFile()) {
    return FileKind.FILE;
  }
  return FileKind.OTHER;
}

/** 真实文件系统实现（用于探测与端到端验证） */
export class NodeFileStore implements IFileStore {
  async mkdirp(p: string): Promise<void> {
    fs.mkdirSync(p, { recursive: true });
  }
  async exists(p: string): Promise<boolean> {
    return fs.existsSync(p);
  }
  async stat(p: string): Promise<FileStat | undefined> {
    try {
      const st = fs.statSync(p);
      return new NodeFileStat(st.size, st.mtimeMs, fileKindOf(st));
    } catch {
      return undefined;
    }
  }
  async writeRaw(p: string, data: string): Promise<void> {
    fs.writeFileSync(p, data, { encoding: 'utf8' });
  }
  async readText(p: string): Promise<string> {
    return fs.readFileSync(p, 'utf8');
  }
  async writeBytes(p: string, data: Uint8Array): Promise<void> {
    fs.writeFileSync(p, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const buf: Buffer = fs.readFileSync(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  async rename(fromPath: string, toPath: string): Promise<void> {
    fs.renameSync(fromPath, toPath);
  }
  async sync(p: string): Promise<void> {
    try {
      const fd = fs.openSync(p, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // 目录 fsync 在部分文件系统上不可用，容忍失败（不影响原子改名语义）
    }
  }
  async remove(p: string): Promise<void> {
    fs.rmSync(p, { recursive: true, force: true });
  }
  async list(dir: string): Promise<string[]> {
    return fs.readdirSync(dir);
  }
  realpath(p: string): string {
    return path.resolve(p);
  }
}

/**
 * 内存文件系统：确定性、可注入故障（磁盘满 / 被杀）。
 * `failNextWrite` 用于验证"临时文件已写但改名未执行"这一崩溃点。
 */
export class MemoryFileStore implements IFileStore {
  private readonly files: Map<string, string | Uint8Array> = new Map<string, string | Uint8Array>();
  private readonly dirs: Set<string> = new Set<string>();
  /** 注入的写失败次数（模拟磁盘满） */
  public failNextWrite: number = 0;
  /** 记录所有写操作路径，用于断言原子写入顺序 */
  readonly writeLog: string[] = [];
  readonly renameLog: string[] = [];

  async mkdirp(p: string): Promise<void> {
    this.ensureDir(p);
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(p) || this.dirs.has(p);
  }
  async stat(p: string): Promise<FileStat | undefined> {
    if (this.files.has(p)) {
      const v = this.files.get(p) as string | Uint8Array;
      const size: number = typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : v.byteLength;
      return new NodeFileStat(size, 0, FileKind.FILE);
    }
    if (this.dirs.has(p)) {
      return new NodeFileStat(0, 0, FileKind.DIR);
    }
    return undefined;
  }
  async writeRaw(p: string, data: string): Promise<void> {
    this.writeLog.push(p);
    if (this.failNextWrite > 0) {
      this.failNextWrite--;
      throw new Error('ENOSPC: no space left on device (injected)');
    }
    this.files.set(p, data);
    this.ensureDir(p.slice(0, p.lastIndexOf('/')));
  }
  async readText(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) {
      throw new Error(`ENOENT: ${p}`);
    }
    if (typeof v !== 'string') {
      throw new Error(`MemoryFileStore.readText: ${p} holds binary data`);
    }
    return v;
  }
  async writeBytes(p: string, data: Uint8Array): Promise<void> {
    this.writeLog.push(p);
    if (this.failNextWrite > 0) {
      this.failNextWrite--;
      throw new Error('ENOSPC: no space left on device (injected)');
    }
    this.files.set(p, new Uint8Array(data));
    this.ensureDir(p.slice(0, p.lastIndexOf('/')));
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.files.get(p);
    if (v === undefined) {
      throw new Error(`ENOENT: ${p}`);
    }
    if (typeof v === 'string') {
      const buf: Buffer = Buffer.from(v, 'utf8');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    return new Uint8Array(v);
  }
  async rename(fromPath: string, toPath: string): Promise<void> {
    this.renameLog.push(`${fromPath}->${toPath}`);
    const v = this.files.get(fromPath);
    if (v === undefined) {
      throw new Error(`ENOENT: ${fromPath}`);
    }
    this.files.delete(fromPath);
    this.files.set(toPath, v);
  }
  async sync(): Promise<void> {
    /* no-op */
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
    this.dirs.delete(p);
  }
  async list(dir: string): Promise<string[]> {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const out = new Set<string>();
    this.files.forEach((_v, k) => {
      if (k.startsWith(prefix)) {
        out.add(k.slice(prefix.length).split('/')[0]);
      }
    });
    this.dirs.forEach((d) => {
      if (d.startsWith(prefix)) {
        out.add(d.slice(prefix.length).split('/')[0]);
      }
    });
    return Array.from(out);
  }
  /** 直接注入文件（模拟"文件已在盘上但 DB 无引用"） */
  seed(p: string, content: string): void {
    this.files.set(p, content);
    this.ensureDir(p.slice(0, p.lastIndexOf('/')));
  }

  /** 递归登记父目录，保证 list/stat 能像真实文件系统一样逐层下探 */
  private ensureDir(p: string): void {
    if (p.length === 0 || p === '.' || p === '/') {
      return;
    }
    if (this.dirs.has(p)) {
      return;
    }
    this.dirs.add(p);
    const parent = p.slice(0, p.lastIndexOf('/'));
    if (parent.length > 0 && parent !== p) {
      this.ensureDir(parent);
    }
  }
  /** 直接删除文件（模拟"DB 有引用但文件丢失"） */
  drop(p: string): void {
    this.files.delete(p);
  }
  allPaths(): string[] {
    return Array.from(this.files.keys()).sort();
  }
}

/**
 * markdown-it → MdToken 桥接适配器。
 * 这个适配器**就是**设计 §4.3 要求定义的"桥接 Schema"：
 * 鸿蒙侧的 ArkWeb 内实现同一个映射（成对维护）。
 */
export class MarkdownItTokenizer implements IMarkdownTokenizer {
  constructor(private readonly md: { parse: (src: string, env: unknown) => unknown[] }) {}

  parse(source: string): MdToken[] {
    const tokens = this.md.parse(source, {}) as Array<Record<string, unknown>>;
    return tokens.map((t) => this.convert(t));
  }

  private convert(t: Record<string, unknown>): MdToken {
    const children = t['children'] as Array<Record<string, unknown>> | null;
    const attrs = t['attrs'] as string[][] | null;
    const map = t['map'] as number[] | null;
    const token: MdToken = {
      type: String(t['type']),
      tag: String(t['tag']),
      nesting: Number(t['nesting']),
      map: map === undefined ? null : map,
      level: Number(t['level']),
      content: t['content'] === undefined ? '' : String(t['content']),
      markup: t['markup'] === undefined ? '' : String(t['markup']),
      info: t['info'] === undefined ? '' : String(t['info']),
      children: children === null || children === undefined ? null : children.map((c) => this.convert(c)),
      attrs: attrs === null || attrs === undefined ? undefined : attrs,
    };
    return token;
  }
}
