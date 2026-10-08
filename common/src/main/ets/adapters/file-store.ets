import { fileIo as fs } from '@kit.CoreFileKit';
import { FileKind, FileStat, IFileStore } from '../core/ports';

/**
 * 沙箱文件原语实现（设计 §4.2）。
 *
 * 注意：本类**只提供原语**，不提供原子写入 ——
 * 「临时写入 → fsync → 同文件系统原子改名 → fsync 目录」这一协议属于领域逻辑，
 * 由 core/atomicfs.ts 的 AtomicWriter 复用本类实现，从而在两端保持同一份可测协议。
 */
export class SandboxFileStore implements IFileStore {
  async mkdirp(path: string): Promise<void> {
    if (!fs.accessSync(path)) {
      fs.mkdirSync(path, true);
    }
  }

  async exists(path: string): Promise<boolean> {
    return fs.accessSync(path);
  }

  async stat(path: string): Promise<FileStat | undefined> {
    if (!fs.accessSync(path)) {
      return undefined;
    }
    const st: fs.Stat = fs.statSync(path);
    let kind: FileKind = FileKind.OTHER;
    if (st.isDirectory()) {
      kind = FileKind.DIR;
    } else if (st.isFile()) {
      kind = FileKind.FILE;
    }
    return { size: st.size, mtimeMs: st.mtime, kind };
  }

  async writeRaw(path: string, data: string): Promise<void> {
    const file: fs.File = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, data);
    } finally {
      fs.closeSync(file);
    }
  }

  async readText(path: string): Promise<string> {
    return fs.readTextSync(path);
  }

  async writeRawBytes(path: string, data: Uint8Array): Promise<void> {
    const file: fs.File = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, data.buffer);
    } finally {
      fs.closeSync(file);
    }
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const file: fs.File = fs.openSync(path, fs.OpenMode.READ_ONLY);
    try {
      const stat: fs.Stat = fs.statSync(file.fd);
      const buffer: ArrayBuffer = new ArrayBuffer(stat.size);
      fs.readSync(file.fd, buffer);
      return new Uint8Array(buffer);
    } finally {
      fs.closeSync(file);
    }
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    fs.renameSync(fromPath, toPath);
  }

  async sync(path: string): Promise<void> {
    // 目录 fsync 在部分文件系统上不可用：容忍失败，不影响"原子改名"语义本身
    try {
      const file: fs.File = fs.openSync(path, fs.OpenMode.READ_ONLY);
      try {
        fs.fsyncSync(file.fd);
      } finally {
        fs.closeSync(file);
      }
    } catch (err) {
      // no-op：仅提示，不上升为业务错误
    }
  }

  async remove(path: string): Promise<void> {
    if (!fs.accessSync(path)) {
      return;
    }
    const st: fs.Stat = fs.statSync(path);
    if (st.isDirectory()) {
      fs.rmdirSync(path);
    } else {
      fs.unlinkSync(path);
    }
  }

  async list(dir: string): Promise<string[]> {
    if (!fs.accessSync(dir)) {
      return [];
    }
    return fs.listFileSync(dir);
  }
}
