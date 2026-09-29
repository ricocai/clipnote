/**
 * S4-3 关键链路设备侧回归套件（设计 §8 可测试性：采集→落库→搜索→备份恢复）。
 *
 * 与 tools/test（本机 node:sqlite）跑同一套领域内核，但本文件在真机/模拟器上
 * 用 RelationalStore + SandboxFileStore 全链路复跑 —— 本机绿不代表设备一致
 * （SQLite 构建差异、RelationalStore 语句限制、文件系统语义），这就是暴露差异的套件。
 *
 * 覆盖：敏感采集不落盘→确认落盘→转存笔记→图片附件入库→搜索命中→备份打包→
 *      破坏性改动→恢复→数据/附件/搜索全部还原 + 负向（损坏备份包被拒且库不动）。
 */
import { describe, it, expect, beforeAll, afterAll } from '@ohos/hypium';
import { AbilityDelegatorRegistry } from '@kit.TestKit';
import { common } from '@kit.AbilityKit';
import { relationalStore } from '@kit.ArkData';
import {
  AttachmentRole,
  BackupService,
  BlobCas,
  BlobRepository,
  CaptureKind,
  ClipEntry,
  ClipIngestService,
  ClipKind,
  CryptoHasher,
  CryptoRandom,
  HilogLogger,
  InboxRepository,
  InboxService,
  InboxState,
  NoteRepository,
  NoteSource,
  NoteService,
  RelationalStoreExecutor,
  SandboxFileStore,
  SchemaMigrator,
  SearchRepository,
  Sensitivity,
  SystemClock,
} from 'common';

const TEST_DB_NAME: string = 'clipnote_key_chain_test.db';
const TEST_ROOT_NAME: string = 'key_chain_test_root';
const APP_VERSION: string = '0.1.0-keychain';

interface Fixture {
  context: common.Context;
  db: RelationalStoreExecutor;
  inbox: InboxRepository;
  inboxSvc: InboxService;
  notes: NoteRepository;
  noteSvc: NoteService;
  search: SearchRepository;
  blobs: BlobRepository;
  blobCas: BlobCas;
  backup: BackupService;
  root: string;
}

let fixture: Fixture | undefined = undefined;

function fx(): Fixture {
  if (fixture === undefined) {
    throw new Error('fixture not initialized');
  }
  return fixture;
}

/** 真实 PNG 头 + 截断字节：非 UTF-8 二进制，字节级往返的看护素材 */
function pngLikeBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x42, 0x43]);
}

export default function keyChainTest(): void {
  describe('KeyChain', () => {
    beforeAll(async () => {
      const context: common.Context =
        AbilityDelegatorRegistry.getAbilityDelegator().getAppContext();
      await relationalStore.deleteRdbStore(context, TEST_DB_NAME);

      const logger = new HilogLogger();
      const db: RelationalStoreExecutor = await RelationalStoreExecutor.open(context, logger, TEST_DB_NAME);
      await new SchemaMigrator(db, logger).migrate();

      const clock = new SystemClock();
      const random = new CryptoRandom();
      const hasher = new CryptoHasher();
      const root: string = `${context.filesDir}/${TEST_ROOT_NAME}`;
      const notes = new NoteRepository({ db, clock, random, logger });
      const inbox = new InboxRepository({ db, logger });
      const blobs = new BlobRepository({ db, logger });
      const blobCas = new BlobCas(root, new SandboxFileStore(), hasher, logger, random);
      const ingest = new ClipIngestService({ clock, hasher, random, logger });
      fixture = {
        context,
        db,
        inbox,
        inboxSvc: new InboxService({ ingest, inbox, notes, clock, logger }),
        notes,
        noteSvc: new NoteService({ db, notes, search: new SearchRepository({ db }), blobs, blobCas, hasher, logger }),
        search: new SearchRepository({ db }),
        blobs,
        blobCas,
        backup: new BackupService({ db, fs: new SandboxFileStore(), hasher, clock, random, logger, root, appVersion: APP_VERSION }),
        root,
      };
    });

    afterAll(async () => {
      await relationalStore.deleteRdbStore(fx().context, TEST_DB_NAME);
    });

    it('key_chain_capture_to_restore', 0, async () => {
      const f = fx();
      const binary = pngLikeBytes();

      // ① 采集：敏感内容不自动落盘，确认后才进收件箱
      const captured = await f.inboxSvc.capture({
        text: '季度复盘结论：现金流健康，验证码 654321',
        entry: ClipEntry.MANUAL,
      });
      expect(captured.kind).assertEqual(CaptureKind.PENDING_CONFIRM);
      expect((await f.inbox.getById(captured.item.id)) === undefined).assertTrue();
      await f.inboxSvc.confirmSave(captured.item);
      const stored = await f.inbox.getById(captured.item.id);
      expect(stored?.state).assertEqual(InboxState.PENDING);
      expect(stored?.sensitivity).assertEqual(Sensitivity.SUSPECTED);

      // ② 落库：转存为笔记 + 图片附件原子入库（二进制字节）
      const note = await f.inboxSvc.acceptAsNote(captured.item.id);
      expect(note.source).assertEqual(NoteSource.CLIPBOARD);
      const edited = await f.noteSvc.save({ id: note.id, title: '季度复盘', contentMd: '# 季度复盘\n\n现金流健康' });
      expect(edited.revision).assertEqual(2);
      const img = await f.noteSvc.importImage(note.id, binary, 'image/png', '复盘图表');
      expect(img.deduped).assertFalse();
      const attachments = await f.noteSvc.listAttachmentsOf(note.id);
      expect(attachments.length).assertEqual(1);
      expect(attachments[0].role).assertEqual(AttachmentRole.INLINE_IMAGE);
      const roundtrip = await f.blobCas.readBytes(img.sha256);
      expect(roundtrip.length).assertEqual(binary.length);
      expect(roundtrip[0]).assertEqual(0x89);

      // ③ 搜索：重建索引后命中（标题加权排前）
      await f.search.rebuildIndex();
      const hits = await f.search.search('现金流');
      expect(hits.length).assertEqual(1);
      expect(hits[0].id).assertEqual(note.id);
      expect(hits[0].title).assertEqual('季度复盘');

      // ④ 备份：打包成功且包含笔记与 blob
      const exported = await f.backup.exportBackup();
      expect(exported.noteCount).assertEqual(1);
      expect(exported.blobCount).assertEqual(1);

      // 破坏性改动：改笔记、再加一篇噪声笔记 —— 恢复后必须整体还原
      await f.noteSvc.save({ id: note.id, title: '被污染', contentMd: '# 被污染' });
      const noise = await f.noteSvc.save({ title: '噪声笔记', contentMd: '不应存在' });
      await f.search.rebuildIndex();
      expect((await f.search.search('噪声')).length).assertEqual(1);

      // ⑤ 恢复：原子替换，数据/附件/检索全部还原
      const restored = await f.backup.restoreBackup(exported.zipPath);
      expect(restored.ok).assertTrue();
      expect(restored.restored?.notes).assertEqual(1);
      expect(restored.recovery?.missing.length).assertEqual(0);
      expect(restored.recovery?.mismatched.length).assertEqual(0);

      const after = await f.notes.getById(note.id);
      expect(after?.title).assertEqual('季度复盘');
      expect(after?.contentMd).assertEqual('# 季度复盘\n\n现金流健康');
      expect((await f.notes.getById(noise.id)) === undefined).assertTrue();
      const afterAttachments = await f.noteSvc.listAttachmentsOf(note.id);
      expect(afterAttachments.length).assertEqual(1);
      const afterBytes = await f.blobCas.readBytes(afterAttachments[0].blobSha256);
      expect(afterBytes.length).assertEqual(binary.length);
      expect(afterBytes[8]).assertEqual(0xff);

      // 恢复后索引随整库替换失效，重建后检索必须再次命中（恢复 ≠ 半新半旧）
      await f.search.rebuildIndex();
      const rehits = await f.search.search('现金流');
      expect(rehits.length).assertEqual(1);
      expect(rehits[0].id).assertEqual(note.id);
    });

    it('key_chain_restore_rejects_corrupted_zip_and_keeps_db', 0, async () => {
      const f = fx();
      const note = await f.notes.create({ title: '存量笔记', contentMd: '恢复前内容', source: NoteSource.MANUAL });
      // 构造一个结构非法的"备份包"（不是 ZIP）
      const badPath = `${f.root}/backups/fake-backup.zip`;
      const fsStore = new SandboxFileStore();
      await fsStore.mkdirp(`${f.root}/backups`);
      await fsStore.writeRaw(badPath, 'this is not a zip archive at all');

      const result = await f.backup.restoreBackup(badPath);
      expect(result.ok).assertFalse();
      expect(result.issues.length > 0).assertTrue();

      const after = await f.notes.getById(note.id);
      expect(after?.contentMd).assertEqual('恢复前内容');
      expect(after?.revision).assertEqual(1);
    });
  });
}
