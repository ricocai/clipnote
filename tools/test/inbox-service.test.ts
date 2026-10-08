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

test('InboxService: 存为笔记按正文判定 contentType（HTML 文档 → text/html，只读口径）', async () => {
  const f = await makeFixture();
  // 普通文本：保持 markdown 口径（S3-3 不改动存量行为）
  const md = await f.svc.capture({ text: '会议纪要\n\n第二条行内容', entry: ClipEntry.MANUAL });
  const mdNote = await f.svc.acceptAsNote(md.item.id);
  assert.equal(mdNote.contentType, 'text/markdown');

  // HTML 文档（doctype 前缀）：contentType 记 text/html，正文原样保留、不清洗
  const htmlDoc = '<!DOCTYPE html><html><body><h1>标题</h1><p>正文</p></body></html>';
  const html = await f.svc.capture({ text: htmlDoc, entry: ClipEntry.SHARE });
  const htmlNote = await f.svc.acceptAsNote(html.item.id);
  assert.equal(htmlNote.contentType, 'text/html');
  assert.equal(htmlNote.contentMd, htmlDoc);
  assert.equal(htmlNote.source, NoteSource.SHARE);

  // 含 ≥2 块级标签的片段同样认定；单标签/散文不误判
  const frag = await f.svc.capture({ text: '<div><table><tr><td>x</td></tr></table></div>', entry: ClipEntry.MANUAL });
  assert.equal((await f.svc.acceptAsNote(frag.item.id)).contentType, 'text/html');
  const prose = await f.svc.capture({ text: '讨论 a<b 与 c>d 的大小', entry: ClipEntry.MANUAL });
  assert.equal((await f.svc.acceptAsNote(prose.item.id)).contentType, 'text/markdown');
});

test('InboxService: 单条删除进垃圾桶（DISCARDED）、一键清空只清时间线', async () => {
  const f = await makeFixture();
  const a = await f.svc.capture({ text: '内容甲', entry: ClipEntry.MANUAL });
  f.clock.advance(4000);
  await f.svc.capture({ text: '内容乙', entry: ClipEntry.MANUAL });

  assert.equal(await f.svc.remove(a.item.id), true);
  assert.equal(await f.svc.remove(a.item.id), false); // 幂等：已在垃圾桶
  const discarded = await f.inbox.getById(a.item.id);
  assert.equal(discarded?.state, InboxState.DISCARDED); // 进垃圾桶不物理删
  assert.equal(await f.svc.pendingCount(), 1);

  assert.equal(await f.svc.clearAll(), 1); // 只清 PENDING，垃圾桶保留
  assert.equal(await f.svc.pendingCount(), 0);
  assert.equal((await f.svc.listDiscarded(10)).length, 1); // 甲仍在垃圾桶
});

test('InboxService: 垃圾桶生命周期 —— 恢复回时间线 / 彻底删除 / 弃置条目不参与去重', async () => {
  const f = await makeFixture();
  const a = await f.svc.capture({ text: '弃置又恢复的内容', entry: ClipEntry.MANUAL });

  // 弃置 → 垃圾桶可见
  assert.equal(await f.svc.remove(a.item.id), true);
  const trashed = await f.svc.listDiscarded(10);
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0].id, a.item.id);

  // 同内容再采集：弃置条目不参与去重，正常入库（与笔记软删同口径）
  f.clock.advance(4000);
  const again = await f.svc.capture({ text: '弃置又恢复的内容', entry: ClipEntry.MANUAL });
  assert.equal(again.kind, CaptureKind.PERSISTED);
  assert.equal(await f.svc.pendingCount(), 1);

  // 恢复 → 回 PENDING 时间线
  assert.equal(await f.svc.restoreDiscarded(a.item.id), true);
  assert.equal(await f.svc.pendingCount(), 2);
  assert.equal((await f.svc.listDiscarded(10)).length, 0);

  // 恢复后再弃置，彻底删除 → 物理消失
  assert.equal(await f.svc.remove(a.item.id), true);
  assert.equal(await f.svc.permanentlyDelete(a.item.id), true);
  assert.equal(await f.inbox.getById(a.item.id), undefined);
  // 非 DISCARDED 条目拒绝彻底删除（防误删活体时间线）
  await assert.rejects(() => f.svc.permanentlyDelete(again.item.id), /not discarded/);
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

// ---------------------------------------------------------------------------
// 真机验收 Q4：持久化去重只对最近 2 日内的条目/笔记生效
// ---------------------------------------------------------------------------

/** 在同一库上重建服务（模拟重启：内存幂等表丢弃，持久化数据保留） */
async function rebuildService(f: Fixture): Promise<InboxService> {
  const ingest = new ClipIngestService({
    clock: f.clock,
    hasher: new NodeHasher(),
    random: new SequentialRandom(),
    logger: f.logger,
  });
  return new InboxService({ ingest, inbox: f.inbox, notes: f.notes, clock: f.clock, logger: f.logger });
}

test('Q4: 越过 3 秒内存窗后，近 2 日内同内容仍合并（持久化去重），不产生新条目', async () => {
  const f = await makeFixture();
  const first = await f.svc.capture({ text: '节后第一天晨读', entry: ClipEntry.MANUAL });
  assert.equal(first.kind, CaptureKind.PERSISTED);

  // 越过 3 秒内存窗：合并依据只能来自持久化去重
  f.clock.advance(4000);
  const again = await f.svc.capture({ text: '节后第一天晨读', entry: ClipEntry.MANUAL });
  assert.equal(again.kind, CaptureKind.MERGED);
  assert.ok(again.reasons.includes('dedupe:persisted_within_2d'));
  assert.equal(again.item.id, first.item.id); // 合并到既有条目
  assert.equal(await f.svc.pendingCount(), 1);

  // 模拟重启（内存幂等表清空）：次日再复制同内容，依然合并
  f.clock.advance(24 * 60 * 60 * 1000);
  const svc2 = await rebuildService(f);
  const day2 = await svc2.capture({ text: '节后第一天晨读', entry: ClipEntry.FOREGROUND_WATCH });
  assert.equal(day2.kind, CaptureKind.MERGED);
  assert.ok(day2.reasons.includes('dedupe:persisted_within_2d'));
  assert.equal(await svc2.pendingCount(), 1);
});

test('Q4: 超过 2 日窗口的同内容视为新内容，正常入库', async () => {
  const f = await makeFixture();
  const first = await f.svc.capture({ text: '三日前复制过的内容', entry: ClipEntry.MANUAL });
  assert.equal(first.kind, CaptureKind.PERSISTED);

  f.clock.advance(3 * 24 * 60 * 60 * 1000); // 3 天，超出 2 日去重窗
  const svc2 = await rebuildService(f);
  const again = await svc2.capture({ text: '三日前复制过的内容', entry: ClipEntry.MANUAL });
  assert.equal(again.kind, CaptureKind.PERSISTED);
  assert.notEqual(again.item.id, first.item.id);
  assert.equal(await svc2.pendingCount(), 2);
});

test('Q4: 已存为笔记的内容（收件箱条目已清理）再采集 → 命中笔记侧去重，不再进收件箱', async () => {
  const f = await makeFixture();
  const r = await f.svc.capture({ text: '已转存为笔记的内容', entry: ClipEntry.SHARE });
  assert.equal(r.kind, CaptureKind.PERSISTED);
  await f.svc.acceptAsNote(r.item.id);
  // 收件箱条目被用户物理清理（笔记仍在）——去重只能命中笔记侧 origin_hash
  // （svc.remove 现为 DISCARDED 软删口径；本场景需要物理移除，直走仓储）
  await f.inbox.deleteById(r.item.id);

  f.clock.advance(4000);
  const svc2 = await rebuildService(f);
  const again = await svc2.capture({ text: '已转存为笔记的内容', entry: ClipEntry.MANUAL });
  assert.equal(again.kind, CaptureKind.MERGED);
  assert.ok(again.reasons.includes('dedupe:note_within_2d'));
  assert.equal(await svc2.pendingCount(), 0); // 未产生新条目
});

test('Q4: 笔记已移入回收站（软删）则不参与去重，同内容重新入库', async () => {
  const f = await makeFixture();
  const r = await f.svc.capture({ text: '删掉后又会复制的内容', entry: ClipEntry.MANUAL });
  const note = await f.svc.acceptAsNote(r.item.id);
  // 物理清掉收件箱行，隔离笔记侧去重变量（svc.remove 现为 DISCARDED 软删口径）
  await f.inbox.deleteById(r.item.id);
  await f.notes.softDelete(note.id); // 用户把笔记移入回收站

  f.clock.advance(4000);
  const svc2 = await rebuildService(f);
  const again = await svc2.capture({ text: '删掉后又会复制的内容', entry: ClipEntry.MANUAL });
  assert.equal(again.kind, CaptureKind.PERSISTED);
  assert.equal(await svc2.pendingCount(), 1);
});

test('Q4: 图片摄取同样适用 2 日持久化去重', async () => {
  const f = await makeFixture();
  const sha: string = 'a'.repeat(64);
  const first = await f.svc.captureImage({
    sha256: sha, sizeBytes: 100, mime: 'image/png', entry: ClipEntry.SHARE,
  });
  assert.equal(first.kind, CaptureKind.PERSISTED);

  f.clock.advance(4000);
  const svc2 = await rebuildService(f);
  const again = await svc2.captureImage({
    sha256: sha, sizeBytes: 100, mime: 'image/png', entry: ClipEntry.SHARE,
  });
  assert.equal(again.kind, CaptureKind.MERGED);
  assert.ok(again.reasons.includes('dedupe:persisted_within_2d'));
  assert.equal(await svc2.pendingCount(), 1);
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

// ---------------------------------------------------------------------------
// Feature 4：收件箱批量操作（acceptMany / discardMany）
// ---------------------------------------------------------------------------

test('acceptMany：非敏感条目批量转存到指定笔记本，敏感条目跳过且逐条列出', async () => {
  const f = await makeFixture();
  // 造数据：2 条普通 + 1 条已确认保存的敏感（验证码）
  const a = await f.svc.capture({ text: '批量条目 A', entry: ClipEntry.MANUAL });
  const b = await f.svc.capture({ text: '批量条目 B', entry: ClipEntry.SHARE });
  f.clock.advance(1000);
  const s = await f.svc.capture({ text: '您的验证码：123456', entry: ClipEntry.MANUAL });
  assert.equal(s.kind, CaptureKind.PENDING_CONFIRM);
  await f.svc.confirmSave(s.item);

  // 建第二个笔记本（V5 后 default nb-default 已存在）
  const nbId = 'nb-test-batch';
  await f.db.execute(
    `INSERT INTO notebook (id, name, built_in, is_default, created_at) VALUES (?, ?, 0, 0, ?)`,
    [nbId, '批量测试本', f.clock.nowMs()],
  );

  const r = await f.svc.acceptMany([a.item.id, b.item.id, s.item.id, 'no-such-id'], nbId);
  assert.deepEqual(r.acceptedIds, [a.item.id, b.item.id]);
  assert.equal(r.notes.length, 2);
  assert.equal(r.skippedSensitive.length, 1);
  assert.equal(r.skippedSensitive[0], s.item.id);
  assert.deepEqual(r.skippedNotPending, ['no-such-id']);
  assert.equal(r.failed.length, 0);

  // 转存的笔记落在指定笔记本；条目转 ACCEPTED 离开时间线
  assert.equal(r.notes[0].notebookId, nbId);
  assert.equal(r.notes[0].source, NoteSource.CLIPBOARD); // MANUAL 入口
  assert.equal(r.notes[1].notebookId, nbId);
  assert.equal(r.notes[1].source, NoteSource.SHARE); // SHARE 入口
  assert.equal(await f.svc.pendingCount(), 1); // 只剩敏感条目
  assert.ok(f.logger.has('inbox_batch_accepted'));
});

test('acceptMany：不指定笔记本落默认笔记本；acceptAsNote 单条语义保持不变', async () => {
  const f = await makeFixture();
  const a = await f.svc.capture({ text: '默认本条目', entry: ClipEntry.MANUAL });
  const b = await f.svc.capture({ text: '单条转存', entry: ClipEntry.MANUAL });

  const r = await f.svc.acceptMany([a.item.id]);
  assert.equal(r.acceptedIds.length, 1);
  assert.equal(r.notes[0].notebookId, 'nb-default');

  const single = await f.svc.acceptAsNote(b.item.id);
  assert.equal(single.notebookId, 'nb-default');
  assert.equal(single.contentMd, '单条转存');
  assert.equal(await f.svc.pendingCount(), 0);
});

test('discardMany：PENDING → DISCARDED 进垃圾桶，可恢复；非 PENDING 幂等跳过', async () => {
  const f = await makeFixture();
  const a = await f.svc.capture({ text: '批量删 A', entry: ClipEntry.MANUAL });
  const b = await f.svc.capture({ text: '批量删 B', entry: ClipEntry.MANUAL });
  const c = await f.svc.capture({ text: '批量删 C', entry: ClipEntry.MANUAL });

  // c 先单条转存（ACCEPTED），再进批量删除名单应被跳过
  await f.svc.acceptAsNote(c.item.id);

  const n = await f.svc.discardMany([a.item.id, b.item.id, c.item.id, 'no-such-id']);
  assert.equal(n, 2);
  assert.equal(await f.svc.pendingCount(), 0);
  const discarded = await f.svc.listDiscarded(10);
  assert.equal(discarded.length, 2);

  // 垃圾桶可恢复（回 PENDING 时间线）
  assert.equal(await f.svc.restoreDiscarded(discarded[0].id), true);
  assert.equal(await f.svc.pendingCount(), 1);
  assert.ok(f.logger.has('inbox_batch_discarded'));
});
