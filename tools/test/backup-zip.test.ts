import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildZip, crc32, readZip, ZipEntryInput } from '../../common/src/main/ets/core/zip';
import { utf8Decode, utf8Encode } from '../../common/src/main/ets/core/bytes';
import { MAX_SINGLE_BLOB_BYTES } from '../../common/src/main/ets/core/backup';

function entry(name: string, text: string): ZipEntryInput {
  return { name, data: utf8Encode(text) };
}

/** 打字节补丁：把 zip 中所有 from 串出现处改写为 to 串（要求等长） */
function patchAll(zip: Uint8Array, from: string, to: string): Uint8Array {
  const f: Uint8Array = utf8Encode(from);
  const t: Uint8Array = utf8Encode(to);
  assert.equal(f.length, t.length, 'patch strings must be same length');
  const out: Uint8Array = new Uint8Array(zip);
  let hits: number = 0;
  for (let i: number = 0; i + f.length <= out.length; i++) {
    let match: boolean = true;
    for (let j: number = 0; j < f.length; j++) {
      if (out[i + j] !== f[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      out.set(t, i);
      hits++;
    }
  }
  assert.ok(hits > 0, `patch target "${from}" not found`);
  return out;
}

function patchU16(zip: Uint8Array, off: number, v: number): void {
  zip[off] = v & 0xff;
  zip[off + 1] = (v >>> 8) & 0xff;
}

function patchU32(zip: Uint8Array, off: number, v: number): void {
  zip[off] = v & 0xff;
  zip[off + 1] = (v >>> 8) & 0xff;
  zip[off + 2] = (v >>> 16) & 0xff;
  zip[off + 3] = (v >>> 24) & 0xff;
}

test('utf8 编解码往返（含中文、emoji、孤立代理项替换）', () => {
  const samples: string[] = ['', 'ascii', '中文标题', 'emoji 🚀 混合', '```code```\n换行'];
  for (const s of samples) {
    assert.equal(utf8Decode(utf8Encode(s)), s);
    assert.equal(utf8Encode(s).length, Buffer.from(s, 'utf8').length);
  }
  // 与 Node 编解码逐字节一致
  assert.deepEqual(Buffer.from(utf8Encode('中文 🚀')), Buffer.from('中文 🚀', 'utf8'));
  // 孤立代理项 → U+FFFD，且与 utf8ByteLength 口径一致
  assert.equal(utf8Decode(utf8Encode('a\ud800b')), 'a\uFFFDb');
});

test('crc32 与已知向量一致', () => {
  assert.equal(crc32(utf8Encode('')), 0);
  assert.equal(crc32(utf8Encode('123456789')), 0xcbf43926);
});

test('buildZip/readZip 往返（UTF-8 名 + 嵌套路径）', () => {
  const zip: Uint8Array = buildZip([
    entry('manifest.json', '{"a":1}'),
    entry('blobs/ab/cd/中文-附件', '图像字节假装是文本'),
  ]);
  const r = readZip(zip);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].name, 'manifest.json');
  assert.equal(utf8Decode(r.entries[0].data), '{"a":1}');
  assert.equal(utf8Decode(r.entries[1].data), '图像字节假装是文本');
});

test('buildZip 拒绝不安全条目名（写出侧不产生非法包）', () => {
  assert.throws(() => buildZip([entry('../evil', 'x')]));
  assert.throws(() => buildZip([entry('/abs/path', 'x')]));
});

test('readZip 拒绝路径越界条目（Zip Slip）', () => {
  const zip: Uint8Array = buildZip([entry('safex1x', 'payload'), entry('ok.txt', 'y')]);
  const patched: Uint8Array = patchAll(zip, 'safex1x', '../evil');
  const r = readZip(patched);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'unsafe_entry_path'));
});

test('readZip 拒绝被篡改的条目数据（CRC32 不符）', () => {
  const zip: Uint8Array = buildZip([entry('a.txt', 'original-content')]);
  const idx: number = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength).indexOf('original-content');
  assert.ok(idx > 0);
  zip[idx] = zip[idx] ^ 0xff;
  const r = readZip(zip);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'crc_mismatch'));
});

test('readZip 拒绝截断的包（坏 ZIP）', () => {
  const zip: Uint8Array = buildZip([entry('a.txt', 'data'), entry('b.txt', 'more')]);
  const r1 = readZip(zip.slice(0, zip.length - 10));
  assert.equal(r1.ok, false);
  assert.ok(r1.issues.some((i) => i.code === 'bad_eocd' || i.code === 'bad_central_dir' || i.code === 'truncated'));
  const r2 = readZip(zip.slice(0, 10));
  assert.equal(r2.ok, false);
});

test('readZip 拒绝压缩/加密条目（只接受 STORE，结构上消除 zip bomb）', () => {
  const zip: Uint8Array = buildZip([entry('a.txt', 'data')]);
  // 中央目录在尾部：EOCD 前最后 46+nameLen 字节的 method 字段（+10）
  const deflated: Uint8Array = new Uint8Array(zip);
  patchU16(deflated, zip.length - 22 - 46 - 5 + 10, 8);
  const r1 = readZip(deflated);
  assert.equal(r1.ok, false);
  assert.ok(r1.issues.some((i) => i.code === 'unsupported_method'));

  const encrypted: Uint8Array = new Uint8Array(zip);
  patchU16(encrypted, zip.length - 22 - 46 - 5 + 8, 0x0801);
  const r2 = readZip(encrypted);
  assert.equal(r2.ok, false);
  assert.ok(r2.issues.some((i) => i.code === 'encrypted_entry'));
});

test('readZip 拒绝声明超大条目（防超大解压的中央目录闸）', () => {
  const zip: Uint8Array = buildZip([entry('a.txt', 'tiny')]);
  const patched: Uint8Array = new Uint8Array(zip);
  const centralOff: number = zip.length - 22 - 46 - 5;
  patchU32(patched, centralOff + 20, MAX_SINGLE_BLOB_BYTES + 1); // compressed
  patchU32(patched, centralOff + 24, MAX_SINGLE_BLOB_BYTES + 1); // uncompressed
  const r = readZip(patched);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'entry_too_large'));
});

test('readZip 拒绝条目数超限与 ZIP64 占位', () => {
  const zip: Uint8Array = buildZip([entry('a.txt', 'x')]);
  const tooMany: Uint8Array = new Uint8Array(zip);
  patchU16(tooMany, zip.length - 22 + 8, 60000);
  patchU16(tooMany, zip.length - 22 + 10, 60000);
  const r1 = readZip(tooMany);
  assert.equal(r1.ok, false);
  assert.ok(r1.issues.some((i) => i.code === 'too_many_entries'));

  const z64: Uint8Array = new Uint8Array(zip);
  const centralOff: number = zip.length - 22 - 46 - 5;
  patchU32(z64, centralOff + 24, 0xffffffff);
  const r2 = readZip(z64);
  assert.equal(r2.ok, false);
  assert.ok(r2.issues.some((i) => i.code === 'zip64_unsupported'));
});

test('readZip 拒绝重名条目', () => {
  // buildZip 允许重名写出（写出侧只查路径安全），读入侧必须拒绝
  const dupZip: Uint8Array = buildZip([entry('same.txt', 'a'), entry('same.txt', 'b')]);
  const r = readZip(dupZip);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'duplicate_entry'));
});
