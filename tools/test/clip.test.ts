import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, ClipIngestService, HARD_REJECT_BYTES, SensitivityDetector } from '../../common/src/main/ets/core/clip';
import {
  ClipEntry,
  ClipKind,
  IngestDecision,
  InboxState,
  Sensitivity,
} from '../../common/src/main/ets/core/model';
import {
  CapturingLogger,
  FixedClock,
  NodeHasher,
  SequentialRandom,
} from './support/platform';

const T0 = 1759000000000;

function makeService(clock: FixedClock, maxTextBytes = 1024 * 1024) {
  const logger = new CapturingLogger();
  const deps = {
    clock,
    hasher: new NodeHasher(),
    random: new SequentialRandom(),
    logger,
    policy: { maxTextBytes, inboxTtlMs: 7 * 24 * 3600 * 1000, dedupeWindowMs: 3000 },
  };
  return { svc: new ClipIngestService(deps), logger };
}

// ---------------------------------------------------------------------------
// 类型识别
// ---------------------------------------------------------------------------

test('classify 识别 URL / 表格 / 代码 / 图片 / 纯文本', () => {
  assert.equal(classify('https://www.harmonyos.com/next').kind, ClipKind.URL);
  const mdTable = '| 指标 | 2026H1 |\n|---|---|\n| 营收 | 100 |';
  assert.equal(classify(mdTable).kind, ClipKind.TABLE);
  const tsv = 'a\tb\tc\nd\te\tf';
  assert.equal(classify(tsv).kind, ClipKind.TABLE);
  const code = "import { foo } from './bar';\nfunction baz() {\n  return 1;\n}";
  assert.equal(classify(code).kind, ClipKind.CODE);
  assert.equal(classify('screenshot.png').kind, ClipKind.IMAGE);
  assert.equal(classify('今天开了个会，讨论了明年的排期。').kind, ClipKind.TEXT);
});

test('classify 返回结构化结果时保留原始单元格边界，不做规范化', () => {
  const mdTable = '| a  b |  c |\n|---|---|\n| 1 |  2 |';
  const r = classify(mdTable);
  assert.equal(r.kind, ClipKind.TABLE);
  const parsed = JSON.parse(r.structuredJson as string) as { header: string; rows: string[] };
  assert.equal(parsed.header, '| a  b |  c |');
  assert.deepEqual(parsed.rows, ['| 1 |  2 |']);
});

test('classify 对单行中文不误判为代码（阈值保守）', () => {
  assert.equal(classify('const 会议纪要，明天同步一下').kind, ClipKind.TEXT);
});

// ---------------------------------------------------------------------------
// 敏感特征检测
// ---------------------------------------------------------------------------

test('SensitivityDetector 命中强特征凭证', () => {
  const d = new SensitivityDetector();
  const cases: string[] = [
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'sk-abcdefghijklmnopqrstuvwx',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij',
    '11010119900307721X',
  ];
  for (const c of cases) {
    const v = d.detect(c);
    assert.equal(v.level, Sensitivity.HIGH, `应判 HIGH: ${c}`);
    assert.ok(v.reasons.length > 0);
  }
});

test('SensitivityDetector 需要上下文才判弱特征，避免把普通数字判成验证码', () => {
  const d = new SensitivityDetector();
  assert.equal(d.detect('123456').level, Sensitivity.NONE, '裸 6 位数字不得判敏感');
  assert.equal(d.detect('订单号 1234567890').level, Sensitivity.NONE);
  assert.equal(d.detect('验证码：839201').level, Sensitivity.SUSPECTED);
  assert.equal(d.detect('password = hunter2').level, Sensitivity.SUSPECTED);
  assert.equal(d.detect('Authorization: Bearer abcdefghijklmnopqrstuvwxyz').level, Sensitivity.SUSPECTED);
});

test('检测器是降噪而非安全保证：含"密钥"字样的普通讨论也会被标为疑似', () => {
  const d = new SensitivityDetector();
  // 这是有意的保守偏向：宁可多问一次，也不静默落盘。测试固化该行为以便后续评审。
  assert.equal(d.detect('把 API key 放到环境变量里，不要提交到仓库').level, Sensitivity.SUSPECTED);
});

// ---------------------------------------------------------------------------
// 采集与幂等
// ---------------------------------------------------------------------------

test('普通内容自动落盘并进入收件箱', async () => {
  const clock = new FixedClock(T0);
  const { svc } = makeService(clock);
  const out = await svc.ingest({ text: '明天 10 点评审', entry: ClipEntry.FOREGROUND_WATCH });
  assert.equal(out.merged, false);
  assert.equal(out.decision, IngestDecision.AUTO_PERSIST);
  assert.equal(out.item.state, InboxState.PENDING);
  assert.equal(out.item.sha256.length, 64);
  assert.equal(out.item.expiresAtMs - out.item.capturedAtMs, 7 * 24 * 3600 * 1000);
});

test('同一次操作的多个入口在时间窗内被合并为一条（幂等）', async () => {
  const clock = new FixedClock(T0);
  const { svc } = makeService(clock);
  const text = '同一次复制触发了分享与前台回调';
  const a = await svc.ingest({ text, entry: ClipEntry.SHARE });
  clock.advance(500);
  const b = await svc.ingest({ text, entry: ClipEntry.FOREGROUND_WATCH });
  clock.advance(500);
  const c = await svc.ingest({ text, entry: ClipEntry.RETURN_TO_FOREGROUND });
  assert.equal(a.merged, false);
  assert.equal(b.merged, true);
  assert.equal(c.merged, true);
  assert.equal(a.item.id, b.item.id);
  assert.equal(a.item.id, c.item.id);
  assert.ok(b.reasons.includes('dedupe:merged_within_window'));
  assert.equal(svc.dedupeMemorySize, 1);
});

test('超出时间窗后再次复制产生新条目，但"用户主动再次保存"必须能强制新建', async () => {
  const clock = new FixedClock(T0);
  const { svc } = makeService(clock);
  const text = '同一段文本';
  const a = await svc.ingest({ text, entry: ClipEntry.MANUAL });
  clock.advance(3001);
  const b = await svc.ingest({ text, entry: ClipEntry.MANUAL });
  assert.equal(b.merged, false);
  assert.notEqual(a.item.id, b.item.id);

  const c = await svc.ingest({ text, entry: ClipEntry.MANUAL }, { forceNew: true });
  assert.equal(c.merged, false);
  assert.notEqual(b.item.id, c.item.id);
});

test('幂等记忆有界（不会随会话无限增长）', async () => {
  const clock = new FixedClock(T0);
  const { svc } = makeService(clock);
  for (let i = 0; i < 300; i++) {
    await svc.ingest({ text: `内容-${i}`, entry: ClipEntry.MANUAL });
  }
  assert.ok(svc.dedupeMemorySize <= 128, `实际 ${svc.dedupeMemorySize}`);
});

test('敏感内容在落盘前被拦截：决策为 REQUIRE_CONFIRM 且状态为待确认', async () => {
  const clock = new FixedClock(T0);
  const { svc, logger } = makeService(clock);
  const out = await svc.ingest({
    text: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
    entry: ClipEntry.SHARE,
  });
  assert.equal(out.decision, IngestDecision.REQUIRE_CONFIRM);
  assert.equal(out.item.state, InboxState.AWAITING_CONFIRM);
  assert.equal(out.item.sensitivity, Sensitivity.HIGH);
  assert.ok(out.reasons.includes('policy:no_auto_persist'));
  assert.ok(logger.has('clip_ingest'));
});

test('超限内容截断而不静默丢弃', async () => {
  const clock = new FixedClock(T0);
  const { svc } = makeService(clock, 32);
  const text = '中文内容'.repeat(50);
  const out = await svc.ingest({ text, entry: ClipEntry.MANUAL });
  assert.equal(out.item.truncated, true);
  assert.ok(out.item.rawText.length < text.length);
  assert.equal(out.item.originalByteLength, Buffer.byteLength(text, 'utf8'));
  assert.ok(Buffer.byteLength(out.item.rawText, 'utf8') <= 32);
  assert.ok(out.reasons.includes('truncated_to_32_bytes'));
  assert.equal(out.decision, IngestDecision.AUTO_PERSIST);
});

test('空内容被拒绝', async () => {
  const clock = new FixedClock(T0);
  const { svc } = makeService(clock);
  const out = await svc.ingest({ text: '   \n\t ', entry: ClipEntry.MANUAL });
  assert.equal(out.decision, IngestDecision.REJECT);
  assert.ok(out.reasons.includes('empty_content'));
});

test('超大内容（超过 16MB 硬上限）拒绝落盘，不截断不驻留正文', async () => {
  const clock = new FixedClock(T0);
  const { svc, logger } = makeService(clock);
  const text = 'a'.repeat(HARD_REJECT_BYTES + 1);
  const out = await svc.ingest({ text, entry: ClipEntry.MANUAL });
  assert.equal(out.decision, IngestDecision.REJECT);
  assert.equal(out.item.state, InboxState.DISCARDED);
  assert.equal(out.item.rawText, '', '硬拒绝不得携带正文');
  assert.equal(out.item.originalByteLength, HARD_REJECT_BYTES + 1);
  assert.ok(out.reasons.includes('exceeds_hard_limit'));
  assert.ok(logger.has('clip_ingest_rejected'));
});

test('摘要基于原始正文，规范化不参与摘要', async () => {
  const clock = new FixedClock(T0);
  const { svc } = makeService(clock);
  const crlf = await svc.ingest({ text: 'a\r\nb', entry: ClipEntry.MANUAL });
  const lf = await svc.ingest({ text: 'a\nb', entry: ClipEntry.MANUAL });
  assert.notEqual(crlf.item.sha256, lf.item.sha256);
  assert.equal(crlf.item.rawText, 'a\r\nb', '持久化正文必须保留原始行尾');
});

test('originApp 允许为空，且不参与幂等键（同一操作的不同入口来源不同）', async () => {
  const clock = new FixedClock(T0);
  const { svc } = makeService(clock);
  const text = '来源不确定的内容';
  const a = await svc.ingest({ text, entry: ClipEntry.SHARE, originApp: 'com.example.a' });
  clock.advance(100);
  const b = await svc.ingest({ text, entry: ClipEntry.SHARE });
  assert.equal(a.item.originApp, 'com.example.a');
  assert.equal(b.merged, true, '来源不同不应破坏幂等（origin 不参与幂等键）');
  assert.equal(b.item.id, a.item.id, '合并后返回既有条目，不产生重复记录');
});
