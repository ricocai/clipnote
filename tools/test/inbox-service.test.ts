import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import { InboxRepository } from '../../common/src/main/ets/core/data/inbox-repository';
import { ClipIngestService, sensitivityReasonLabel } from '../../common/src/main/ets/core/clip';
import {
  CaptureKind,
  InboxService,
  deriveTitle,
  noteSourceOf,
} from '../../common/src/main/ets/core/inbox';
import {
  ClipEntry,
  InboxState,
  NoteSource,
} from '../../common/src/main/ets/core/model';
import { NodeSqliteExecutor } from './support/sqlite-executor';
import { CapturingLogger, FixedClock, NodeHasher, SequentialRandom } from './support/platform';

const BASE_MS = 1759000000000;

interface Fixture {
  db: NodeSqliteExecutor;
  clock: FixedClock;
  svc: InboxService;
  inbox: InboxRepository;
  notes: NoteRepository;
  logger: CapturingLogger;
}

async function makeFixture(capacity?: number): Promise<Fixture> {
  const db = NodeSqliteExecutor.openMemory();
  const logger = new CapturingLogger();
  await new SchemaMigrator(db, logger).migrate();
  const clock = new FixedClock(BASE_MS);
  const rand = new SequentialRandom();
  const ingest = new ClipIngestService({ clock, hasher: new NodeHasher(), random: rand, logger });
  const inbox = new InboxRepository({ db, logger });
  const notes = new NoteRepository({ db, clock, random: rand, logger });
  const svc = new InboxService({
    ingest,
    inbox,
    notes,
    clock,
    logger,
    policy: capacity === undefined ? undefined : { capacity },
  });
  return { db, clock, svc, inbox, notes, logger };
}

test('InboxService: 普通内容落盘，重启（重建仓储）后不丢', async () => {
  const f = await makeFixture();
  const r = await f.svc.capture({ text: '第一条保存的内容', entry: ClipEntry.MANUAL });
  assert.equal(r.kind, CaptureKind.PERSISTED);
  assert.equal(r.evicted, 0);

  // 模拟重启：同一库文件上重建仓储与服务，内存（含幂等表）全部丢弃
  const logger2 = new CapturingLogger();
  const inbox2 = new InboxRepository({ db: f.db, logger: logger2 });
  const pending = await inbox2.listByState(InboxState.PENDING, 10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].rawText, '第一条保存的内容');
  assert.equal(pending[0].entry, ClipEntry.MANUAL);
});

test('InboxService: 敏感内容不落盘，确认后才写入；放弃则永不落盘', async () => {
  const f = await makeFixture();

  const r = await f.svc.capture({ text: '您的验证码：123456', entry: ClipEntry.FOREGROUND_WATCH });
  assert.equal(r.kind, CaptureKind.PENDING_CONFIRM);
  assert.equal(r.item.state, InboxState.AWAITING_CONFIRM);
  // 落盘前拦截：库中查不到
  assert.equal(await f.inbox.getById(r.item.id), undefined);
  assert.equal(await f.svc.pendingCount(), 0);
  // reasons 携带命中规则，供 UI 展示
  assert.ok(r.reasons.some((x) => x === 'sensitive:otp_code'));

  // 重复复制同一敏感内容：仍要再次给出确认（不能因幂等合并静默跳过提示）
  const r2 = await f.svc.capture({ text: '您的验证码：123456', entry: ClipEntry.FOREGROUND_WATCH });
  assert.equal(r2.kind, CaptureKind.PENDING_CONFIRM);

  // 用户明确保存 → 此刻才落盘
  assert.equal(await f.svc.confirmSave(r.item), 0);
  const saved = await f.inbox.getById(r.item.id);
  assert.equal(saved?.state, InboxState.PENDING);
  assert.equal(await f.svc.pendingCount(), 1);

  // 另一条敏感内容选择放弃 → 永不落盘
  const r3 = await f.svc.capture({ text: '您的验证码：999999', entry: ClipEntry.MANUAL });
  assert.equal(r3.kind, CaptureKind.PENDING_CONFIRM);
  f.svc.decline(r3.item);
  assert.equal(await f.inbox.getById(r3.item.id), undefined);
  assert.ok(f.logger.has('inbox_sensitive_declined'));

  // 非待确认状态不允许 confirmSave
  await assert.rejects(() => f.svc.confirmSave(saved!), /not awaiting confirm/);
});

test('InboxService: 容量上限淘汰最旧 PENDING', async () => {
  const f = await makeFixture(3);
  for (let i = 1; i <= 4; i++) {
    f.clock.advance(4000); // 越过 3s 幂等窗
    const r = await f.svc.capture({ text: `第 ${i} 条内容`, entry: ClipEntry.MANUAL });
    assert.equal(r.kind, CaptureKind.PERSISTED);
    assert.equal(r.evicted, i <= 3 ? 0 : 1);
  }
  assert.equal(await f.svc.pendingCount(), 3);
  const items = await f.svc.listPending(10);
  assert.deepEqual(items.map((x) => x.rawText), ['第 4 条内容', '第 3 条内容', '第 2 条内容']);
  assert.ok(f.logger.has('inbox_capacity_evicted'));
});

test('InboxService: 保留期清理在落盘时连带执行', async () => {
  const f = await makeFixture();
  await f.svc.capture({ text: '会过期的内容', entry: ClipEntry.MANUAL });
  assert.equal(await f.svc.pendingCount(), 1);

  // 时钟推进超过 7 天保留期，下一次落盘触发清理
  f.clock.advance(8 * 24 * 60 * 60 * 1000);
  const r = await f.svc.capture({ text: '新的内容', entry: ClipEntry.MANUAL });
  assert.equal(r.kind, CaptureKind.PERSISTED);
  assert.equal(r.evicted, 1);
  const items = await f.svc.listPending(10);
  assert.deepEqual(items.map((x) => x.rawText), ['新的内容']);
});

test('InboxService: 存为笔记（标题/来源/originHash/状态迁移），列表排除', async () => {
  const f = await makeFixture();
  const r = await f.svc.capture({ text: '会议纪要\n\n第二条行内容', entry: ClipEntry.SHARE });
  assert.equal(r.kind, CaptureKind.PERSISTED);

  const note = await f.svc.acceptAsNote(r.item.id);
  assert.equal(note.title, '会议纪要');
  assert.equal(note.contentMd, '会议纪要\n\n第二条行内容');
  assert.equal(note.source, NoteSource.SHARE);
  assert.equal(note.originHash, r.item.sha256);

  // 笔记已落库；条目标记 ACCEPTED，从收件箱列表消失
  assert.equal((await f.notes.getById(note.id))?.contentMd, '会议纪要\n\n第二条行内容');
  assert.equal((await f.inbox.getById(r.item.id))?.state, InboxState.ACCEPTED);
  assert.equal(await f.svc.pendingCount(), 0);
  assert.deepEqual(await f.svc.listPending(10), []);

  // 重复转存与不存在条目均报错
  await assert.rejects(() => f.svc.acceptAsNote(r.item.id), /not pending/);
  await assert.rejects(() => f.svc.acceptAsNote('no-such-id'), /not found/);
});

test('InboxService: 单条删除（物理）与一键清空', async () => {
  const f = await makeFixture();
  const a = await f.svc.capture({ text: '内容甲', entry: ClipEntry.MANUAL });
  f.clock.advance(4000);
  await f.svc.capture({ text: '内容乙', entry: ClipEntry.MANUAL });

  assert.equal(await f.svc.remove(a.item.id), true);
  assert.equal(await f.svc.remove(a.item.id), false);
  assert.equal(await f.inbox.getById(a.item.id), undefined);
  assert.equal(await f.svc.pendingCount(), 1);

  assert.equal(await f.svc.clearAll(), 1);
  assert.equal(await f.svc.pendingCount(), 0);
});

test('InboxService: 空内容与幂等合并如实上报', async () => {
  const f = await makeFixture();
  const rejected = await f.svc.capture({ text: '   ', entry: ClipEntry.MANUAL });
  assert.equal(rejected.kind, CaptureKind.REJECTED);

  const first = await f.svc.capture({ text: '重复内容', entry: ClipEntry.MANUAL });
  assert.equal(first.kind, CaptureKind.PERSISTED);
  const again = await f.svc.capture({ text: '重复内容', entry: ClipEntry.MANUAL });
  assert.equal(again.kind, CaptureKind.MERGED);
  assert.equal(await f.svc.pendingCount(), 1);
});

test('标题派生与入口来源映射', () => {
  assert.equal(deriveTitle('  \n  首个非空行  \n次行'), '首个非空行');
  assert.equal(deriveTitle('x'.repeat(60)).length, 51); // 50 字 + 省略号
  assert.equal(deriveTitle('\n \n'), '未命名笔记');

  assert.equal(noteSourceOf(ClipEntry.SHARE), NoteSource.SHARE);
  assert.equal(noteSourceOf(ClipEntry.MANUAL), NoteSource.CLIPBOARD);
  assert.equal(noteSourceOf(ClipEntry.PASTE_BUTTON), NoteSource.CLIPBOARD);
  assert.equal(noteSourceOf(ClipEntry.FOREGROUND_WATCH), NoteSource.CLIPBOARD);
});

test('敏感命中规则的用户可读说明', () => {
  assert.equal(sensitivityReasonLabel('otp_code'), '验证码/动态口令');
  assert.equal(sensitivityReasonLabel('pem_private_key'), '私钥块（PEM）');
  assert.equal(sensitivityReasonLabel('cn_id_card'), '身份证号');
  // 未知 id 原样返回，不静默吞掉
  assert.equal(sensitivityReasonLabel('some_future_rule'), 'some_future_rule');
});
