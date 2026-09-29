/**
 * S2-1 数据层设备侧用例（设计 §4.2 / §8 G5 的设备侧复核）。
 *
 * 覆盖：建表 / 迁移幂等 / 事务回滚 / 外键 / Repository CRUD / 启动恢复扫描。
 * 与 tools/test/data-*.test.ts（本机 node:sqlite）跑同一套内核逻辑 —— 本机绿
 * 不代表设备一致（SQLite 构建差异、RelationalStore 封装的语句限制），
 * 本文件就是用来暴露这类差异的。
 */
import { describe, it, expect, beforeAll, afterAll } from '@ohos/hypium';
import { AbilityDelegatorRegistry } from '@kit.TestKit';
import { common } from '@kit.AbilityKit';
import { relationalStore } from '@kit.ArkData';
import {
  AttachmentRole,
  BlobCas,
  BlobRepository,
  BlobStatus,
  CaptureKind,
  ClipEntry,
  ClipIngestService,
  ClipKind,
  CryptoHasher,
  CryptoRandom,
  DB_SCHEMA_VERSION,
  HilogLogger,
  InboxRepository,
  InboxService,
  InboxState,
  NoteRepository,
  NoteSource,
  RelationalStoreExecutor,
  SandboxFileStore,
  SchemaMigrator,
  Sensitivity,
  SqlRow,
  StartupRecoveryReport,
  SystemClock,
  blobRelativePath,
  runStartupRecovery,
  transact,
} from 'common';

const TEST_DB_NAME: string = 'clipnote_data_layer_test.db';
const TEST_BLOB_ROOT_NAME: string = 'test_recovery_blobs';

interface Fixture {
  context: common.Context;
  db: RelationalStoreExecutor;
  notes: NoteRepository;
  inbox: InboxRepository;
  blobs: BlobRepository;
  blobCas: BlobCas;
  blobRoot: string;
}

let fixture: Fixture | undefined = undefined;

function fx(): Fixture {
  if (fixture === undefined) {
    throw new Error('fixture not initialized');
  }
  return fixture;
}

export default function dataLayerTest(): void {
  describe('DataLayer', () => {
    beforeAll(async () => {
      const context: common.Context =
        AbilityDelegatorRegistry.getAbilityDelegator().getAppContext();
      // 清掉上一轮残留，保证用例可重复执行
      await relationalStore.deleteRdbStore(context, TEST_DB_NAME);

      const logger = new HilogLogger();
      const db: RelationalStoreExecutor = await RelationalStoreExecutor.open(context, logger, TEST_DB_NAME);
      await new SchemaMigrator(db, logger).migrate();

      const clock = new SystemClock();
      const random = new CryptoRandom();
      const blobRoot: string = `${context.filesDir}/${TEST_BLOB_ROOT_NAME}`;
      fixture = {
        context,
        db,
        notes: new NoteRepository({ db, clock, random, logger }),
        inbox: new InboxRepository({ db, logger }),
        blobs: new BlobRepository({ db, logger }),
        blobCas: new BlobCas(blobRoot, new SandboxFileStore(), new CryptoHasher(), logger, random),
        blobRoot,
      };
    });

    afterAll(async () => {
      await relationalStore.deleteRdbStore(fx().context, TEST_DB_NAME);
    });

    it('migrate_creates_all_tables_and_is_idempotent', 0, async () => {
      const db = fx().db;
      // 重复迁移：版本不变、不报错
      const version: number = await new SchemaMigrator(db, new HilogLogger()).migrate();
      expect(version).assertEqual(DB_SCHEMA_VERSION);

      const rows: SqlRow[] = await db.query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('note', 'tag', 'note_tag', 'blob', 'note_attachment', 'clipboard_item', 'note_fts', 'mcp_audit', 'schema_meta')`,
      );
      expect(rows.length).assertEqual(9);
    });

    it('foreign_keys_reject_dangling_attachment', 0, async () => {
      let threw: boolean = false;
      try {
        await fx().db.execute(
          `INSERT INTO note_attachment (note_id, blob_sha256, role, ordinal) VALUES (?, ?, ?, ?)`,
          ['no-such-note', 'a'.repeat(64), 'inline_image', 0],
        );
      } catch (err) {
        threw = true;
      }
      expect(threw).assertTrue();
    });

    it('note_repository_crud_and_revision', 0, async () => {
      const notes = fx().notes;
      const note = await notes.create({ title: '第一篇', contentMd: '# 你好', source: NoteSource.MANUAL });
      expect(note.revision).assertEqual(1);

      const updated = await notes.updateContent(note.id, '# 你好\n\n补充');
      expect(updated.revision).assertEqual(2);

      await notes.softDelete(note.id);
      expect((await notes.getById(note.id)) === undefined).assertTrue();
      const restored = await notes.restore(note.id);
      expect(restored.revision).assertEqual(4);
      expect(restored.deletedAtMs === undefined).assertTrue();

      const tag = await notes.addTag(note.id, '阅读');
      const again = await notes.addTag(note.id, '阅读');
      expect(tag.id).assertEqual(again.id);
      expect((await notes.listTagsOfNote(note.id)).length).assertEqual(1);
    });

    it('transaction_rolls_back_all_writes_on_failure', 0, async () => {
      const f = fx();
      const note = await f.notes.create({ title: 't', contentMd: 'v1', source: NoteSource.MANUAL });
      const sha: string = 'b'.repeat(64);
      await f.blobs.saveRecord({
        sha256: sha,
        relativePath: blobRelativePath(sha),
        mime: 'image/png',
        size: 1,
        status: BlobStatus.ORPHAN_GRACE,
      });

      let threw: boolean = false;
      try {
        await transact(f.db, async () => {
          await f.notes.updateContent(note.id, 'v2');
          await f.blobs.attach(note.id, sha, AttachmentRole.INLINE_IMAGE, 0);
          throw new Error('boom');
        });
      } catch (err) {
        threw = true;
      }
      expect(threw).assertTrue();

      const after = await f.notes.getById(note.id);
      expect(after?.contentMd).assertEqual('v1');
      expect(after?.revision).assertEqual(1);
      expect((await f.blobs.listAttachmentsOf(note.id)).length).assertEqual(0);
    });

    it('inbox_repository_state_and_purge', 0, async () => {
      const f = fx();
      const note = await f.notes.create({ title: 'n', contentMd: 'c', source: NoteSource.CLIPBOARD });
      const put = await f.blobCas.put('收件箱文本');
      const now: number = Date.now();
      await f.inbox.save({
        id: note.id,
        kind: ClipKind.TEXT,
        rawText: '收件箱文本',
        sha256: put.sha256,
        capturedAtMs: now,
        expiresAtMs: now + 60 * 1000,
        sensitivity: Sensitivity.NONE,
        state: InboxState.PENDING,
        entry: ClipEntry.PASTE_BUTTON,
        truncated: false,
        originalByteLength: 15,
      });

      expect(await f.inbox.updateState(note.id, InboxState.ACCEPTED)).assertTrue();
      expect((await f.inbox.getById(note.id))?.state).assertEqual(InboxState.ACCEPTED);
      expect(await f.inbox.purgeExpired(now + 2 * 60 * 1000)).assertEqual(1);
      expect((await f.inbox.getById(note.id)) === undefined).assertTrue();

      // 物理删除单条（S2-2：用户明确删除 / 容量淘汰）
      await f.inbox.save({
        id: 'del-1',
        kind: ClipKind.TEXT,
        rawText: '待删除',
        sha256: put.sha256,
        capturedAtMs: now,
        expiresAtMs: now + 60 * 1000,
        sensitivity: Sensitivity.NONE,
        state: InboxState.PENDING,
        entry: ClipEntry.MANUAL,
        truncated: false,
        originalByteLength: 9,
      });
      expect(await f.inbox.deleteById('del-1')).assertTrue();
      expect(await f.inbox.deleteById('del-1')).assertFalse();
      expect((await f.inbox.getById('del-1')) === undefined).assertTrue();
    });

    it('inbox_service_capture_confirm_accept_capacity', 0, async () => {
      const f = fx();
      const logger = new HilogLogger();
      const clock = new SystemClock();
      const random = new CryptoRandom();
      const ingest = new ClipIngestService({ clock, hasher: new CryptoHasher(), random, logger });
      // 小容量便于验证淘汰；与主机用例同一套内核，跑在 RelationalStore 上
      const svc = new InboxService({
        ingest,
        inbox: f.inbox,
        notes: f.notes,
        clock,
        logger,
        policy: { capacity: 2 },
      });

      // 敏感内容不落盘 → 确认后落盘
      const sensitive = await svc.capture({ text: '您的验证码：654321', entry: ClipEntry.MANUAL });
      expect(sensitive.kind).assertEqual(CaptureKind.PENDING_CONFIRM);
      expect((await f.inbox.getById(sensitive.item.id)) === undefined).assertTrue();
      await svc.confirmSave(sensitive.item);
      expect((await f.inbox.getById(sensitive.item.id))?.state).assertEqual(InboxState.PENDING);

      // 再落两条（容量=2）：最旧的确认条目被淘汰（内容不同即不同摘要，不受幂等窗影响）
      const t1 = await svc.capture({ text: '普通内容甲', entry: ClipEntry.MANUAL });
      expect(t1.kind).assertEqual(CaptureKind.PERSISTED);
      const t2 = await svc.capture({ text: '普通内容乙', entry: ClipEntry.MANUAL });
      expect(t2.kind).assertEqual(CaptureKind.PERSISTED);
      expect(t2.evicted).assertEqual(1);
      expect(await svc.pendingCount()).assertEqual(2);

      // 存为笔记：标题/来源/originHash，条目从收件箱列表消失
      const note = await svc.acceptAsNote(t2.item.id);
      expect(note.title.length > 0).assertTrue();
      expect(note.source).assertEqual(NoteSource.CLIPBOARD);
      expect(note.originHash).assertEqual(t2.item.sha256);
      expect((await f.inbox.getById(t2.item.id))?.state).assertEqual(InboxState.ACCEPTED);
      expect(await svc.pendingCount()).assertEqual(1);

      // 一键清空
      expect(await svc.clearAll()).assertEqual(2); // 1 PENDING + 1 ACCEPTED
      expect(await svc.pendingCount()).assertEqual(0);
    });

    it('startup_recovery_marks_orphans_and_reports_missing', 0, async () => {
      const f = fx();
      const note = await f.notes.create({ title: 'r', contentMd: 'r', source: NoteSource.MANUAL });

      // 独立的 blob 根目录，隔离其他用例写入的文件
      const casRoot: string = `${f.context.filesDir}/test_recovery_case`;
      const fsStore = new SandboxFileStore();
      const cas: BlobCas = new BlobCas(casRoot, fsStore, new CryptoHasher(), new HilogLogger(), new CryptoRandom());

      // 正常协议：文件先落地 → 事务提交引用
      const put = await cas.put('恢复扫描目标');
      await transact(f.db, async () => {
        await f.blobs.saveRecord({
          sha256: put.sha256,
          relativePath: put.relativePath,
          mime: 'text/plain',
          size: put.size,
          status: BlobStatus.ORPHAN_GRACE,
        });
        await f.blobs.attach(note.id, put.sha256, AttachmentRole.FILE, 0);
      });
      // 无引用孤儿（模拟引用事务未提交的崩溃残留）
      const orphan = await cas.put('未提交的附件');

      // 被引用但文件丢失（完整性事故）
      await fsStore.remove(`${casRoot}/${put.relativePath}`);

      const report: StartupRecoveryReport = await runStartupRecovery({
        blobRepository: f.blobs,
        blobCas: cas,
        logger: new HilogLogger(),
      });

      expect(report.missing.length).assertEqual(1);
      expect(report.missing[0]).assertEqual(put.sha256);
      expect(report.scanned).assertEqual(1); // 只剩孤儿文件
      expect(orphan.sha256.length).assertEqual(64);
    });
  });
}
