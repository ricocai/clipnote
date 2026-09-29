import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BlobCas, blobRelativePath } from '../../common/src/main/ets/core/blob-cas';
import { ClipIngestService } from '../../common/src/main/ets/core/clip';
import { CaptureKind, InboxService } from '../../common/src/main/ets/core/inbox';
import { BlobRepository } from '../../common/src/main/ets/core/data/blob-repository';
import { InboxRepository } from '../../common/src/main/ets/core/data/inbox-repository';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { BlobStatus, ClipEntry, ClipKind, InboxState } from '../../common/src/main/ets/core/model';
import {
  ShareIntakeService,
  SharePolicy,
  ShareRejectReason,
  isShareAction,
  isSupportedImageMime,
  sniffImageMime,
} from '../../common/src/main/ets/core/share';
import { NodeSqliteExecutor } from './support/sqlite-executor';
import {
  CapturingLogger,
  FixedClock,
  MemoryFileStore,
  NodeHasher,
  SequentialRandom,
} from './support/platform';

const BASE_MS = 1759000000000;

/** 最小 PNG 头（魔数 + 填充），够嗅探与内容寻址用 */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);

interface Fixture {
  clock: FixedClock;
  svc: ShareIntakeService;
  inbox: InboxRepository;
  blobRepo: BlobRepository;
  blobs: BlobCas;
  fs: MemoryFileStore;
  logger: CapturingLogger;
  hasher: NodeHasher;
}

async function makeFixture(policy?: SharePolicy): Promise<Fixture> {
  const db = NodeSqliteExecutor.openMemory();
  const logger = new CapturingLogger();
  await new SchemaMigrator(db, logger).migrate();
  const clock = new FixedClock(BASE_MS);
  const rand = new SequentialRandom();
  const hasher = new NodeHasher();
  const ingest = new ClipIngestService({ clock, hasher, random: rand, logger });
  const inbox = new InboxRepository({ db, logger });
  const notes = new NoteRepository({ db, clock, random: rand, logger });
  const blobRepo = new BlobRepository({ db, logger });
  const fs = new MemoryFileStore();
  const blobs = new BlobCas('/sandbox', fs, hasher, logger, rand);
  const inboxSvc = new InboxService({ ingest, inbox, notes, clock, logger });
  const svc = new ShareIntakeService({
    inbox: inboxSvc,
    blobs,
    blobRepo,
    fs,
    logger,
    policy,
  });
  return { clock, svc, inbox, blobRepo, blobs, fs, logger, hasher };
}

test('ShareIntake: 非分享 action 不处理（handled=false，不产生任何副作用）', async () => {
  const f = await makeFixture();
  const r = await f.svc.handleShare({ action: 'action.system.home', texts: ['x'], files: [] });
  assert.equal(r.handled, false);
  assert.equal(await f.inbox.countByState(InboxState.PENDING), 0);
  assert.equal(isShareAction('ohos.want.action.sendData'), true);
  assert.equal(isShareAction('ohos.want.action.sendMultipleData'), true);
  assert.equal(isShareAction(undefined), false);
});

test('ShareIntake: 文本分享与手动粘贴同路径落盘（entry=share，类型识别生效）', async () => {
  const f = await makeFixture();
  const r = await f.svc.handleShare({
    action: 'ohos.want.action.sendData',
    texts: ['https://example.com/article'],
    files: [],
  });
  assert.equal(r.handled, true);
  assert.equal(r.persisted, 1);
  assert.equal(r.merged, 0);
  assert.equal(r.rejections.length, 0);

  const items = await f.inbox.listByState(InboxState.PENDING, 10);
  assert.equal(items.length, 1);
  assert.equal(items[0].entry, ClipEntry.SHARE);
  assert.equal(items[0].kind, ClipKind.URL); // 类型识别在管线内生效
  assert.equal(items[0].rawText, 'https://example.com/article');
});

test('ShareIntake: 时间窗内重复分享被幂等合并，不产生重复条目', async () => {
  const f = await makeFixture();
  const first = await f.svc.handleShare({
    action: 'ohos.want.action.sendData',
    texts: ['同一段分享文本'],
    files: [],
  });
  assert.equal(first.persisted, 1);
  const second = await f.svc.handleShare({
    action: 'ohos.want.action.sendData',
    texts: ['同一段分享文本'],
    files: [],
  });
  assert.equal(second.merged, 1);
  assert.equal(second.persisted, 0);
  assert.equal(await f.inbox.countByState(InboxState.PENDING), 1);

  // 越过幂等窗（3s）后再分享：是新条目（保留用户"再次保存"语义）
  f.clock.advance(4000);
  const third = await f.svc.handleShare({
    action: 'ohos.want.action.sendData',
    texts: ['同一段分享文本'],
    files: [],
  });
  assert.equal(third.persisted, 1);
  assert.equal(await f.inbox.countByState(InboxState.PENDING), 2);
});

test('ShareIntake: 敏感内容不自动落盘，交用户确认（与粘贴同口径）', async () => {
  const f = await makeFixture();
  const r = await f.svc.handleShare({
    action: 'ohos.want.action.sendData',
    texts: ['您的验证码：123456'],
    files: [],
  });
  assert.equal(r.persisted, 0);
  assert.equal(r.pendingConfirm.length, 1);
  assert.equal(r.pendingConfirm[0].item.state, InboxState.AWAITING_CONFIRM);
  assert.ok(r.pendingConfirm[0].reasons.some((x) => x === 'sensitive:otp_code'));
  assert.equal(await f.inbox.countByState(InboxState.PENDING), 0);
});

test('ShareIntake: 图片分享复制入 blob CAS，收件箱条目只存引用不存外部 URI', async () => {
  const f = await makeFixture();
  const srcUri = 'file://docs/storage/Users/currentUser/photo.png';
  f.fs.seedBytes(srcUri, PNG_BYTES);

  const r = await f.svc.handleShare({
    action: 'ohos.want.action.sendData',
    texts: [],
    files: [{ uri: srcUri, mime: 'image/png' }],
  });
  assert.equal(r.persisted, 1);
  assert.equal(r.rejections.length, 0);

  const sha = await f.hasher.sha256HexBytes(PNG_BYTES);
  // ① 字节在 CAS 临时区（内容寻址路径）且内容一致
  assert.equal(await f.blobs.exists(sha), true);
  const stored = await f.fs.readBytes(`/sandbox/${blobRelativePath(sha)}`);
  assert.deepEqual([...stored], [...PNG_BYTES]);
  // ② blob 记录登记为 orphan_grace（收件箱引用非 note_attachment，GC 有宽限期保护）
  const rec = await f.blobRepo.get(sha);
  assert.equal(rec?.status, BlobStatus.ORPHAN_GRACE);
  assert.equal(rec?.mime, 'image/png');
  assert.equal(rec?.size, PNG_BYTES.length);
  // ③ 收件箱条目：kind=image，structured_json 只带内容摘要引用，绝不保存外部临时 URI
  const items = await f.inbox.listByState(InboxState.PENDING, 10);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, ClipKind.IMAGE);
  assert.equal(items[0].entry, ClipEntry.SHARE);
  assert.equal(items[0].sha256, sha);
  const structured = JSON.parse(items[0].structuredJson!) as Record<string, unknown>;
  assert.equal(structured['ref'], sha);
  assert.equal(items[0].structuredJson!.indexOf(srcUri), -1);
});

test('ShareIntake: 同一图片重复分享 —— CAS 物理去重 + 收件箱幂等合并', async () => {
  const f = await makeFixture();
  const uri1 = 'file://docs/storage/a.png';
  const uri2 = 'file://docs/storage/b.png'; // 不同 URI、同一内容
  f.fs.seedBytes(uri1, PNG_BYTES);
  f.fs.seedBytes(uri2, PNG_BYTES);

  const r1 = await f.svc.handleShare({
    action: 'ohos.want.action.sendData',
    texts: [],
    files: [{ uri: uri1, mime: 'image/png' }],
  });
  const r2 = await f.svc.handleShare({
    action: 'ohos.want.action.sendData',
    texts: [],
    files: [{ uri: uri2, mime: 'image/png' }],
  });
  assert.equal(r1.persisted, 1);
  assert.equal(r2.merged, 1);
  assert.equal(await f.inbox.countByState(InboxState.PENDING), 1);

  // CAS 中只有一份字节
  const sha = await f.hasher.sha256HexBytes(PNG_BYTES);
  const all = f.fs.allPaths().filter((p) => p.indexOf('/sandbox/blobs/') === 0);
  assert.deepEqual(all, [`/sandbox/${blobRelativePath(sha)}`]);
});

test('ShareIntake: 超大文件拒绝（先 stat 闸门，字节不进内存）', async () => {
  const f = await makeFixture({ maxFileBytes: 64 });
  const big = new Uint8Array(128).fill(0x61);
  const uri = 'file://docs/storage/big.png';
  f.fs.seedBytes(uri, big);

  const r = await f.svc.handleShare({
    action: 'ohos.want.action.sendData',
    texts: [],
    files: [{ uri, mime: 'image/png' }],
  });
  assert.equal(r.persisted, 0);
  assert.equal(r.rejections.length, 1);
  assert.equal(r.rejections[0].reason, ShareRejectReason.FILE_TOO_LARGE);
  // 未写入任何内容
  assert.equal(await f.inbox.countByState(InboxState.PENDING), 0);
  assert.equal(f.fs.allPaths().filter((p) => p.indexOf('/sandbox/blobs/') === 0).length, 0);
});

test('ShareIntake: 无权限/失效 URI 拒绝并如实上报（授权过期场景）', async () => {
  const f = await makeFixture();

  // ① URI 根本不存在
  const missing = await f.svc.handleShare({
    action: 'ohos.want.action.sendData',
    texts: [],
    files: [{ uri: 'file://docs/storage/gone.png', mime: 'image/png' }],
  });
  assert.equal(missing.rejections[0]?.reason, ShareRejectReason.URI_UNREADABLE);

  // ② 存在但读取被系统拒绝（授权被撤销）
  const uri = 'file://docs/storage/revoked.png';
  f.fs.seedBytes(uri, PNG_BYTES);
  f.fs.failNextReadBytes = 1;
  const revoked = await f.svc.handleShare({
    action: 'ohos.want.action.sendData',
    texts: [],
    files: [{ uri, mime: 'image/png' }],
  });
  assert.equal(revoked.rejections[0]?.reason, ShareRejectReason.URI_UNREADABLE);
  assert.equal(await f.inbox.countByState(InboxState.PENDING), 0);
  assert.ok(f.logger.has('share_intake'));
});

test('ShareIntake: 类型不支持拒绝（声明了非图片类型则不读字节）', async () => {
  const f = await makeFixture();
  const uri = 'file://docs/storage/clip.mp4';
  f.fs.seedBytes(uri, new Uint8Array([0, 1, 2, 3]));

  const r = await f.svc.handleShare({
    action: 'ohos.want.action.sendData',
    texts: [],
    files: [{ uri, mime: 'video/mp4' }],
  });
  assert.equal(r.persisted, 0);
  assert.equal(r.rejections[0]?.reason, ShareRejectReason.UNSUPPORTED_TYPE);
  assert.equal(await f.inbox.countByState(InboxState.PENDING), 0);
});

test('ShareIntake: MIME 缺失时按魔数嗅探；非图片内容拒绝', async () => {
  const f = await makeFixture();
  const pngUri = 'file://docs/storage/no-mime-a';
  const binUri = 'file://docs/storage/no-mime-b';
  f.fs.seedBytes(pngUri, PNG_BYTES);
  f.fs.seedBytes(binUri, new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 5, 6])); // MZ 头（exe）

  const r = await f.svc.handleShare({
    action: 'ohos.want.action.sendMultipleData',
    texts: [],
    files: [{ uri: pngUri }, { uri: binUri }],
  });
  assert.equal(r.persisted, 1);
  assert.equal(r.rejections.length, 1);
  assert.equal(r.rejections[0].target, binUri);
  assert.equal(r.rejections[0].reason, ShareRejectReason.UNSUPPORTED_TYPE);

  const sha = await f.hasher.sha256HexBytes(PNG_BYTES);
  const rec = await f.blobRepo.get(sha);
  assert.equal(rec?.mime, 'image/png'); // 嗅探结果入库
});

test('ShareIntake: 空分享如实上报（EMPTY_SHARE）', async () => {
  const f = await makeFixture();
  const r = await f.svc.handleShare({ action: 'ohos.want.action.sendData', texts: [], files: [] });
  assert.equal(r.handled, true);
  assert.equal(r.persisted, 0);
  assert.deepEqual(r.rejections.map((x) => x.reason), [ShareRejectReason.EMPTY_SHARE]);
});

test('ShareIntake: 混合载荷（文本 + 图片）逐项有确定去向', async () => {
  const f = await makeFixture();
  const uri = 'file://docs/storage/pic.jpg';
  f.fs.seedBytes(uri, JPEG_BYTES);

  const r = await f.svc.handleShare({
    action: 'ohos.want.action.sendMultipleData',
    texts: ['配图说明文字'],
    files: [{ uri, mime: 'image/jpeg' }],
  });
  assert.equal(r.persisted, 2);
  assert.equal(r.rejections.length, 0);
  const items = await f.inbox.listByState(InboxState.PENDING, 10);
  const kinds = items.map((x) => x.kind).sort();
  assert.deepEqual(kinds, [ClipKind.IMAGE, ClipKind.TEXT]);
});

test('ShareIntake: 空文本条目被管线拒绝（不静默吞掉）', async () => {
  const f = await makeFixture();
  const r = await f.svc.handleShare({ action: 'ohos.want.action.sendData', texts: ['   '], files: [] });
  assert.equal(r.persisted, 0);
  assert.equal(r.rejectedContent.length, 1);
  assert.equal(r.rejectedContent[0].kind, CaptureKind.REJECTED);
  assert.equal(await f.inbox.countByState(InboxState.PENDING), 0);
});

test('图片 MIME 白名单与魔数嗅探', () => {
  assert.equal(isSupportedImageMime('image/png'), true);
  assert.equal(isSupportedImageMime('IMAGE/JPEG'), true);
  assert.equal(isSupportedImageMime('video/mp4'), false);
  assert.equal(isSupportedImageMime('application/pdf'), false);

  assert.equal(sniffImageMime(PNG_BYTES), 'image/png');
  assert.equal(sniffImageMime(JPEG_BYTES), 'image/jpeg');
  assert.equal(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif');
  assert.equal(sniffImageMime(new Uint8Array([0x42, 0x4d, 1, 2])), 'image/bmp');
  assert.equal(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'image/webp');
  assert.equal(sniffImageMime(new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])), 'image/heic');
  assert.equal(sniffImageMime(new Uint8Array([1, 2, 3])), undefined);
  assert.equal(sniffImageMime(new Uint8Array([])), undefined);
});
