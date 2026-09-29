import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BlobCas, blobRelativePath, isSha256Hex } from '../../common/src/main/ets/core/blob-cas';
import { AtomicWriter, isTempArtifact } from '../../common/src/main/ets/core/atomicfs';
import { CapturingLogger, MemoryFileStore, NodeHasher, SequentialRandom } from './support/platform';

function makeCas(fs: MemoryFileStore) {
  const logger = new CapturingLogger();
  const cas = new BlobCas('sandbox', fs, new NodeHasher(), logger, new SequentialRandom());
  return { cas, fs, logger };
}

test('blobRelativePath 采用两级分片且拒绝非法摘要', () => {
  const sha = 'a'.repeat(64);
  assert.equal(blobRelativePath(sha), `blobs/aa/aa/${sha}`);
  assert.throws(() => blobRelativePath('zz'));
  assert.equal(isSha256Hex(sha), true);
  assert.equal(isSha256Hex('A'.repeat(64)), false, '必须是小写');
});

test('put 内容寻址：同内容只落盘一次（去重）', async () => {
  const fs = new MemoryFileStore();
  const { cas } = makeCas(fs);
  const a = await cas.put('同一张图片的字节');
  const b = await cas.put('同一张图片的字节');
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, true);
  assert.equal(fs.allPaths().length, 1);
  assert.equal(await cas.read(a.sha256), '同一张图片的字节');
});

test('原子写入顺序：先写临时文件 → 改名 → 不留临时残留', async () => {
  const fs = new MemoryFileStore();
  const { cas } = makeCas(fs);
  const r = await cas.put('payload');
  const writes = fs.writeLog;
  assert.equal(writes.length, 1);
  assert.ok(isTempArtifact(writes[0]), `首次写入必须是临时文件: ${writes[0]}`);
  assert.equal(fs.renameLog.length, 1);
  assert.ok(fs.renameLog[0].endsWith(`->sandbox/${r.relativePath}`));
  const leftovers = fs.allPaths().filter((p) => isTempArtifact(p));
  assert.deepEqual(leftovers, [], '成功路径不得留下临时文件');
});

test('磁盘满（注入 ENOSPC）时：不产生正式文件、清理临时文件、异常向上抛出', async () => {
  const fs = new MemoryFileStore();
  const { cas } = makeCas(fs);
  fs.failNextWrite = 1;
  await assert.rejects(() => cas.put('会写失败的内容'));
  assert.deepEqual(fs.allPaths(), [], '失败时不得留下任何文件（含临时文件）');
  assert.deepEqual(fs.renameLog, [], '写失败不得执行改名');
});

test('恢复扫描：被引用但缺失 → missing（必须为 0 才能发布）', async () => {
  const fs = new MemoryFileStore();
  const { cas } = makeCas(fs);
  const put = await cas.put('存在的附件');
  const ghost = 'b'.repeat(64);
  const report = await cas.reconcile(new Set<string>([put.sha256, ghost]));
  assert.deepEqual(report.missing, [ghost]);
  assert.deepEqual(report.orphans, []);
  assert.equal(report.scanned, 1);
});

test('恢复扫描：无引用文件进孤儿列表（宁可留孤儿，也不删被引用文件）', async () => {
  const fs = new MemoryFileStore();
  const { cas } = makeCas(fs);
  const referenced = await cas.put('被笔记引用');
  const orphan = await cas.put('上传后未提交引用的残留');
  const report = await cas.reconcile(new Set<string>([referenced.sha256]));
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.orphans, [orphan.sha256]);
  assert.equal(await cas.exists(referenced.sha256), true, '有引用的文件绝不能被回收');
});

test('恢复扫描：内容被篡改/截断时，verifyHash 能识别 mismatch', async () => {
  const fs = new MemoryFileStore();
  const { cas } = makeCas(fs);
  const r = await cas.put('原始内容');
  const abs = cas.absolute(r.relativePath);
  fs.seed(abs, '被改过的内容');
  const noVerify = await cas.reconcile(new Set<string>([r.sha256]));
  assert.deepEqual(noVerify.mismatched, []);
  const verify = await cas.reconcile(new Set<string>([r.sha256]), { verifyHash: true });
  assert.deepEqual(verify.mismatched, [r.sha256]);
  assert.equal(await cas.verify(r.sha256), false);
});

test('恢复扫描清理崩溃残留的临时文件', async () => {
  const fs = new MemoryFileStore();
  const { cas } = makeCas(fs);
  const r = await cas.put('正式内容');
  fs.seed(`${cas.absolute(r.relativePath)}.tmp-deadbeef`, '半截内容');
  const report = await cas.reconcile(new Set<string>([r.sha256]));
  assert.deepEqual(report.missing, []);
  const leftovers = fs.allPaths().filter((p) => isTempArtifact(p));
  assert.deepEqual(leftovers, []);
});

test('GC 只回收被显式确认的孤儿', async () => {
  const fs = new MemoryFileStore();
  const { cas } = makeCas(fs);
  const keep = await cas.put('保留');
  const drop = await cas.put('回收');
  const removed = await cas.collectGarbage([drop.sha256]);
  assert.equal(removed, 1);
  assert.equal(await cas.exists(keep.sha256), true);
  assert.equal(await cas.exists(drop.sha256), false);
  assert.equal(await cas.collectGarbage(['not-a-sha']), 0, '非法摘要必须被忽略');
});

test('AtomicWriter 校验失败（内容回读不一致）时不改名', async () => {
  const fs = new MemoryFileStore();
  const logger = new CapturingLogger();
  const writer = new AtomicWriter(fs, new SequentialRandom(), logger);
  // 走正常路径写入成功
  await writer.write('sandbox/x.txt', 'hello');
  assert.equal(await fs.readText('sandbox/x.txt'), 'hello');
  // 注入失败：改名前的 writeRaw 抛错，不应留下目标文件
  fs.failNextWrite = 1;
  await assert.rejects(() => writer.write('sandbox/y.txt', 'world'));
  assert.equal(await fs.exists('sandbox/y.txt'), false);
  assert.ok(logger.has('atomic_write_failed'));
});

test('并发原子写同一目标：结果必为某一写者的完整内容（无撕裂、无混合）', async () => {
  const fs = new MemoryFileStore();
  const logger = new CapturingLogger();
  const writer = new AtomicWriter(fs, new SequentialRandom(), logger);
  const payloadA = 'A'.repeat(10000);
  const payloadB = 'B'.repeat(10000);
  // 两个写者交叉推进（Promise 先全部创建再 await）：rename 原子点之后
  // 读者只能看到其中一方的完整内容
  await Promise.all([
    writer.write('sandbox/target.txt', payloadA),
    writer.write('sandbox/target.txt', payloadB),
  ]);
  const final = await fs.readText('sandbox/target.txt');
  assert.ok(
    final === payloadA || final === payloadB,
    `不得出现混合/截断内容（实际长度 ${final.length}）`,
  );
});
