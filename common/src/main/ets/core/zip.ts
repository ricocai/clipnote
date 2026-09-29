/**
 * ZIP 归档读写（纯 TS，零平台依赖）。
 *
 * 为什么自实现而不是用平台 zip：
 *  - 鸿蒙 `@ohos.zlib` 与 Node 的 zip 能力形态不同，内核要求两端同一份可测代码（设计 §5）；
 *  - 备份包只走**本模块写出、本模块读入**的闭环，因此可以刻意收窄到 ZIP 的最小安全子集：
 *    仅 STORE（不压缩）条目 —— 结构上消除 zip bomb 的"声明小、解压大"问题
 *    （解压后字节数 == 归档内字节数，配合总量上限即可硬约束，设计 §4.2「防超大解压」）。
 *
 * 读入侧拒绝策略（任何一项不满足即整体拒绝，逐条登记 issue）：
 *  - 非 EOCD 结尾 / 中央目录越界 / 本地头与中央目录不一致 / 数据截断；
 *  - 压缩条目（method ≠ 0）、加密条目（flag bit0）、ZIP64（0xFFFFFFFF 占位尺寸）；
 *  - 条目名路径越界（复用 isSafeRelativePath）、重名条目；
 *  - 条目数 / 单条 / 总量超上限（上限常量与 backup.ts 恢复口径共享）；
 *  - CRC32 不符（篡改或传输损坏的第一道闸门，manifest 语义校验是第二道）。
 *
 * 不追求通用 ZIP 兼容性：外部工具产出的 deflate 包会被拒绝，这是有意为之的安全口径。
 */

import { isSafeRelativePath, utf8Decode, utf8Encode } from './bytes';
import { MAX_RESTORE_ENTRIES, MAX_RESTORE_TOTAL_BYTES, MAX_SINGLE_BLOB_BYTES } from './backup';

const LOCAL_HEADER_SIG: number = 0x04034b50;
const CENTRAL_HEADER_SIG: number = 0x02014b50;
const EOCD_SIG: number = 0x06054b50;
const EOCD_MIN_LEN: number = 22;
/** EOCD 最大搜索回退：固定 22 字节 + 最长 65535 字节注释 */
const EOCD_MAX_COMMENT: number = 65535;
const ZIP64_PLACEHOLDER: number = 0xffffffff;
/** 通用标志 bit11：条目名为 UTF-8（本模块写出的包恒置位） */
const FLAG_UTF8: number = 0x0800;
const FLAG_ENCRYPTED: number = 0x0001;
const METHOD_STORE: number = 0;

// ---------------------------------------------------------------------------
// CRC32（ISO 3309，与 ZIP 规范一致）
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | undefined = undefined;

function table(): Uint32Array {
  if (crcTable !== undefined) {
    return crcTable;
  }
  const t: Uint32Array = new Uint32Array(256);
  for (let n: number = 0; n < 256; n++) {
    let c: number = n;
    for (let k: number = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

export function crc32(data: Uint8Array): number {
  const t: Uint32Array = table();
  let crc: number = 0xffffffff;
  for (let i: number = 0; i < data.length; i++) {
    crc = t[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

export interface ZipEntryInput {
  readonly name: string;
  readonly data: Uint8Array;
}

function writeU16(out: Uint8Array, off: number, v: number): void {
  out[off] = v & 0xff;
  out[off + 1] = (v >>> 8) & 0xff;
}

function writeU32(out: Uint8Array, off: number, v: number): void {
  out[off] = v & 0xff;
  out[off + 1] = (v >>> 8) & 0xff;
  out[off + 2] = (v >>> 16) & 0xff;
  out[off + 3] = (v >>> 24) & 0xff;
}

function readU16(bytes: Uint8Array, off: number): number {
  return bytes[off] | (bytes[off + 1] << 8);
}

function readU32(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

/**
 * 构建 STORE 模式 ZIP。条目名必须是安全相对路径（否则抛错 —— 写出侧不应产生非法包）。
 * 总尺寸受 32 位偏移约束；备份上限（2GiB）远在之内，无需 ZIP64。
 */
export function buildZip(entries: readonly ZipEntryInput[]): Uint8Array {
  if (entries.length > MAX_RESTORE_ENTRIES) {
    throw new Error(`buildZip: too many entries (${entries.length} > ${MAX_RESTORE_ENTRIES})`);
  }
  const names: Uint8Array[] = [];
  let localSize: number = 0;
  let centralSize: number = 0;
  for (let i: number = 0; i < entries.length; i++) {
    const e: ZipEntryInput = entries[i];
    if (!isSafeRelativePath(e.name)) {
      throw new Error(`buildZip: unsafe entry name "${e.name}"`);
    }
    const nameBytes: Uint8Array = utf8Encode(e.name);
    names.push(nameBytes);
    localSize += 30 + nameBytes.length + e.data.length;
    centralSize += 46 + nameBytes.length;
  }
  const total: number = localSize + centralSize + EOCD_MIN_LEN;
  if (total >= ZIP64_PLACEHOLDER) {
    throw new Error(`buildZip: archive too large (${total} bytes); ZIP64 intentionally unsupported`);
  }

  const out: Uint8Array = new Uint8Array(total);
  let off: number = 0;
  const localOffsets: number[] = [];

  for (let i: number = 0; i < entries.length; i++) {
    const e: ZipEntryInput = entries[i];
    const nameBytes: Uint8Array = names[i];
    const crc: number = crc32(e.data);
    localOffsets.push(off);
    writeU32(out, off, LOCAL_HEADER_SIG);
    writeU16(out, off + 4, 20); // version needed
    writeU16(out, off + 6, FLAG_UTF8);
    writeU16(out, off + 8, METHOD_STORE);
    writeU16(out, off + 10, 0); // mod time
    writeU16(out, off + 12, 0); // mod date
    writeU32(out, off + 14, crc);
    writeU32(out, off + 18, e.data.length);
    writeU32(out, off + 22, e.data.length);
    writeU16(out, off + 26, nameBytes.length);
    writeU16(out, off + 28, 0); // extra len
    out.set(nameBytes, off + 30);
    out.set(e.data, off + 30 + nameBytes.length);
    off += 30 + nameBytes.length + e.data.length;
  }

  const cdOffset: number = off;
  for (let i: number = 0; i < entries.length; i++) {
    const e: ZipEntryInput = entries[i];
    const nameBytes: Uint8Array = names[i];
    const crc: number = crc32(e.data);
    writeU32(out, off, CENTRAL_HEADER_SIG);
    writeU16(out, off + 4, 20); // version made by
    writeU16(out, off + 6, 20); // version needed
    writeU16(out, off + 8, FLAG_UTF8);
    writeU16(out, off + 10, METHOD_STORE);
    writeU16(out, off + 12, 0);
    writeU16(out, off + 14, 0);
    writeU32(out, off + 16, crc);
    writeU32(out, off + 20, e.data.length);
    writeU32(out, off + 24, e.data.length);
    writeU16(out, off + 28, nameBytes.length);
    writeU16(out, off + 30, 0); // extra
    writeU16(out, off + 32, 0); // comment
    writeU16(out, off + 34, 0); // disk number
    writeU16(out, off + 36, 0); // internal attrs
    writeU32(out, off + 38, 0); // external attrs
    writeU32(out, off + 42, localOffsets[i]);
    out.set(nameBytes, off + 46);
    off += 46 + nameBytes.length;
  }

  writeU32(out, off, EOCD_SIG);
  writeU16(out, off + 4, 0); // disk
  writeU16(out, off + 6, 0); // cd start disk
  writeU16(out, off + 8, entries.length);
  writeU16(out, off + 10, entries.length);
  writeU32(out, off + 12, centralSize);
  writeU32(out, off + 16, cdOffset);
  writeU16(out, off + 20, 0); // comment len
  return out;
}

// ---------------------------------------------------------------------------
// 读取与校验
// ---------------------------------------------------------------------------

export interface ZipIssue {
  readonly code: string;
  readonly detail: string;
}

export interface ZipEntryData {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface ZipReadResult {
  readonly ok: boolean;
  readonly entries: ZipEntryData[];
  readonly issues: ZipIssue[];
}

interface CentralRecord {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

function fail(issues: ZipIssue[], code: string, detail: string): ZipReadResult {
  issues.push({ code, detail });
  return { ok: false, entries: [], issues };
}

/**
 * 解析并校验 ZIP。结构校验（目录/偏移/尺寸上限）全部通过后才触碰条目数据，
 * 最后逐条核对 CRC32 —— 任何一步失败都返回 ok=false 且不产出部分结果。
 */
export function readZip(bytes: Uint8Array): ZipReadResult {
  const issues: ZipIssue[] = [];

  if (bytes.length < EOCD_MIN_LEN) {
    return fail(issues, 'bad_eocd', `archive too small (${bytes.length} bytes)`);
  }
  let eocd: number = -1;
  const scanFrom: number = Math.max(0, bytes.length - EOCD_MIN_LEN - EOCD_MAX_COMMENT);
  for (let i: number = bytes.length - EOCD_MIN_LEN; i >= scanFrom; i--) {
    if (readU32(bytes, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return fail(issues, 'bad_eocd', 'end of central directory not found');
  }

  const entryCount: number = readU16(bytes, eocd + 10);
  const cdSize: number = readU32(bytes, eocd + 12);
  const cdOffset: number = readU32(bytes, eocd + 16);
  if (entryCount > MAX_RESTORE_ENTRIES) {
    return fail(issues, 'too_many_entries', `${entryCount} > ${MAX_RESTORE_ENTRIES}`);
  }
  if (cdOffset + cdSize > eocd) {
    return fail(issues, 'bad_central_dir', `central directory [${cdOffset}, +${cdSize}) exceeds EOCD at ${eocd}`);
  }

  // 第一遍：只读中央目录，先做全部结构/上限校验，不触碰条目数据
  const records: CentralRecord[] = [];
  const seen: Set<string> = new Set<string>();
  let totalBytes: number = 0;
  let off: number = cdOffset;
  for (let i: number = 0; i < entryCount; i++) {
    if (off + 46 > eocd || readU32(bytes, off) !== CENTRAL_HEADER_SIG) {
      return fail(issues, 'bad_central_dir', `central record ${i} malformed at offset ${off}`);
    }
    const flags: number = readU16(bytes, off + 8);
    const method: number = readU16(bytes, off + 10);
    const crc: number = readU32(bytes, off + 16);
    const compressedSize: number = readU32(bytes, off + 20);
    const uncompressedSize: number = readU32(bytes, off + 24);
    const nameLen: number = readU16(bytes, off + 28);
    const extraLen: number = readU16(bytes, off + 30);
    const commentLen: number = readU16(bytes, off + 32);
    const localOffset: number = readU32(bytes, off + 42);
    if (off + 46 + nameLen > eocd) {
      return fail(issues, 'bad_central_dir', `central record ${i} name out of bounds`);
    }
    const name: string = decodeEntryName(bytes, off + 46, nameLen, (flags & FLAG_UTF8) !== 0);
    off += 46 + nameLen + extraLen + commentLen;

    if (compressedSize === ZIP64_PLACEHOLDER || uncompressedSize === ZIP64_PLACEHOLDER || localOffset === ZIP64_PLACEHOLDER) {
      return fail(issues, 'zip64_unsupported', `entry "${name}" uses ZIP64 placeholders`);
    }
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      return fail(issues, 'encrypted_entry', `entry "${name}" is encrypted`);
    }
    if (method !== METHOD_STORE) {
      return fail(issues, 'unsupported_method', `entry "${name}" method=${method}; only STORE is accepted`);
    }
    if (compressedSize !== uncompressedSize) {
      return fail(issues, 'size_field_mismatch', `entry "${name}" compressed=${compressedSize} stored=${uncompressedSize}`);
    }
    if (!isSafeRelativePath(name)) {
      return fail(issues, 'unsafe_entry_path', `entry name "${name}"`);
    }
    if (seen.has(name)) {
      return fail(issues, 'duplicate_entry', `entry "${name}" appears twice`);
    }
    seen.add(name);
    if (uncompressedSize > MAX_SINGLE_BLOB_BYTES) {
      return fail(issues, 'entry_too_large', `entry "${name}" size=${uncompressedSize}`);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > MAX_RESTORE_TOTAL_BYTES) {
      return fail(issues, 'total_too_large', `${totalBytes} bytes declared`);
    }
    records.push({ name, method, flags, crc, compressedSize, uncompressedSize, localOffset });
  }

  // 第二遍：核对本地头并抽取数据 + CRC
  const entries: ZipEntryData[] = [];
  for (let i: number = 0; i < records.length; i++) {
    const r: CentralRecord = records[i];
    if (r.localOffset + 30 > bytes.length || readU32(bytes, r.localOffset) !== LOCAL_HEADER_SIG) {
      return fail(issues, 'truncated', `entry "${r.name}" local header missing at ${r.localOffset}`);
    }
    if (readU16(bytes, r.localOffset + 8) !== r.method) {
      return fail(issues, 'local_central_mismatch', `entry "${r.name}" method differs from central directory`);
    }
    const lNameLen: number = readU16(bytes, r.localOffset + 26);
    const lExtraLen: number = readU16(bytes, r.localOffset + 28);
    const lName: string = decodeEntryName(bytes, r.localOffset + 30, lNameLen, (r.flags & FLAG_UTF8) !== 0);
    if (lName !== r.name) {
      return fail(issues, 'local_central_mismatch', `entry "${r.name}" local name "${lName}"`);
    }
    const dataStart: number = r.localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd: number = dataStart + r.compressedSize;
    if (dataEnd > bytes.length) {
      return fail(issues, 'truncated', `entry "${r.name}" data [${dataStart}, ${dataEnd}) out of bounds`);
    }
    const data: Uint8Array = bytes.slice(dataStart, dataEnd);
    if (crc32(data) !== r.crc) {
      return fail(issues, 'crc_mismatch', `entry "${r.name}" crc32 mismatch (tampered or corrupted)`);
    }
    entries.push({ name: r.name, data });
  }
  return { ok: true, entries, issues };
}

function decodeEntryName(bytes: Uint8Array, off: number, len: number, _utf8Flag: boolean): string {
  // 本模块写出的包恒为 UTF-8；外来包无论标志位如何都按 UTF-8 解，
  // 非法序列由 utf8Decode 替换为 U+FFFD —— 随后 isSafeRelativePath 兜底。
  return utf8Decode(bytes.slice(off, off + len));
}
