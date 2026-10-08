import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';

import { BlockType, DocumentBlock } from '../../common/src/main/ets/core/model';
import {
  IMarkdownTokenizer,
  parseDocument,
} from '../../common/src/main/ets/core/markdown';
import { MarkdownItTokenizer } from './support/platform';
import { SpeechSegment } from '../../common/src/main/ets/core/speech';
import { FakeTtsDriver } from '../../speech/src/main/ets/core/testing';
import { DriverUtterance } from '../../speech/src/main/ets/core/driver';
import { SystemTtsEngine } from '../../speech/src/main/ets/core/engine';
import { SegmentQueue } from '../../speech/src/main/ets/core/queue';
import { planSpeech, SpeechPlan, SpeechPlanItem } from '../../speech/src/main/ets/core/planner';
import {
  PlaybackCallbacks,
  PlaybackState,
  SpeechPlaybackController,
} from '../../speech/src/main/ets/core/controller';

// ---- 测试台架 ----

/** speak 后自动播完的驱动（自动完成路径：顺序播完/背压窗口断言用） */
class AutoDriver extends FakeTtsDriver {
  override async speak(utterance: DriverUtterance): Promise<void> {
    await super.speak(utterance);
    // FakeTtsDriver 不主动回调（由测试显式推进）；自动完成路径在入队后自行调度
    setTimeout(() => this.simulateComplete(utterance.requestId), 0);
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i: number = 0; i < 200; i++) {
    if (cond()) {
      return;
    }
    await tick();
  }
  throw new Error(`until 超时：${what}`);
}

/** 事件收集器：状态机迁移与段序断言的统一口径 */
function collector() {
  const events: string[] = [];
  const cb: PlaybackCallbacks = {
    onStateChange: (s: PlaybackState): void => {
      events.push(`state:${s}`);
    },
    onSegmentStart: (item: SpeechPlanItem): void => {
      events.push(`start:${item.segment.index}@${item.blockIndex}`);
    },
    onProgress: (item: SpeechPlanItem, chars: number): void => {
      events.push(`progress:${item.segment.index}:${chars}`);
    },
    onSegmentFinish: (item: SpeechPlanItem): void => {
      events.push(`finish:${item.segment.index}`);
    },
    onPlanComplete: (): void => {
      events.push('done');
    },
    onError: (reason: string): void => {
      events.push(`error:${reason}`);
    },
  };
  return { events, cb };
}

function block(index: number, type: BlockType, text: string, range?: { start: number; end: number }): DocumentBlock {
  return {
    id: `1:${index}:0`,
    type,
    level: type === BlockType.HEADING ? 1 : 0,
    range: {
      startLine: 0,
      endLine: 1,
      startOffset: range?.start ?? 0,
      endOffset: range?.end ?? text.length,
    },
    text,
    docRevision: 1,
  };
}

/** 读取控制器状态（独立函数切断 TS 字面量收窄，驱动循环轮询用） */
function stateOf(c: SpeechPlaybackController): PlaybackState {
  return c.state;
}

/**
 * 驱动手动 FakeTtsDriver 直到条件成立：每轮完成「最后一个入驱动且在飞」的请求
 * 并推进一个 tick。完成已结算的请求是 no-op（simulateComplete 按 inflight 判重），
 * 因此可安全盲驱。
 */
async function driveUntil(cond: () => boolean, what: string, driver: FakeTtsDriver): Promise<void> {
  for (let i: number = 0; i < 500; i++) {
    if (cond()) {
      return;
    }
    const req = driver.spoken[driver.spoken.length - 1];
    if (req !== undefined && driver.inflightCount > 0) {
      driver.simulateComplete(req.requestId);
    }
    await tick();
  }
  throw new Error(`driveUntil 超时：${what}`);
}

function spokenTexts(driver: FakeTtsDriver): string[] {
  return driver.spoken.map((u) => u.text);
}

// ---- planner：DocumentBlock → 段计划 ----

test('planner：混合文档可朗读性口径（代码/图片可读，表格/分隔线/RAW 跳过）', () => {
  const md = [
    '# 标题',
    '',
    '正文第一段。',
    '',
    '- 列表项一',
    '- 列表项二',
    '',
    '> 引用一句话。',
    '',
    '```ts',
    'const  a  =  1;',
    '```',
    '',
    '| a | b |',
    '| - | - |',
    '',
    '![示意图](attachment.png)',
    '',
    '---',
  ].join('\n');
  const tokenizer: IMarkdownTokenizer = new MarkdownItTokenizer(new MarkdownIt({ html: true }));
  const blocks: DocumentBlock[] = parseDocument(tokenizer, md, { docRevision: 1 });
  const plan: SpeechPlan = planSpeech(blocks, md);

  const types: string[] = [];
  for (let i: number = 0; i < blocks.length; i++) {
    types.push(blocks[i].type as string);
  }
  assert.ok(types.includes('table'), '前置：解析应产出 table 块');
  assert.ok(types.includes('thematic_break'));

  // 每段都能回映射到块，且锚点是真实块下标
  const spokenBlockTypes = new Set<string>();
  for (let i: number = 0; i < plan.items.length; i++) {
    const item: SpeechPlanItem = plan.items[i];
    assert.ok(item.blockIndex >= 0 && item.blockIndex < blocks.length, 'blockIndex 在块数组内');
    spokenBlockTypes.add(blocks[item.blockIndex].type as string);
  }
  assert.ok(spokenBlockTypes.has('heading'));
  assert.ok(spokenBlockTypes.has('paragraph'));
  assert.ok(spokenBlockTypes.has('list_item'));
  assert.ok(spokenBlockTypes.has('quote'));
  assert.ok(spokenBlockTypes.has('code'));
  assert.ok(spokenBlockTypes.has('image'));
  assert.ok(!spokenBlockTypes.has('table'), '表格不朗读');
  assert.ok(!spokenBlockTypes.has('thematic_break'), '分隔线不朗读');
});

test('planner：代码块围栏剥离且保留内部空白；段不跨块', () => {
  const md = ['```ts', 'const  a  =  1;', '', 'return   a;', '```', '', '下一段。'].join('\n');
  const tokenizer: IMarkdownTokenizer = new MarkdownItTokenizer(new MarkdownIt({ html: true }));
  const blocks: DocumentBlock[] = parseDocument(tokenizer, md, { docRevision: 1 });
  const plan: SpeechPlan = planSpeech(blocks, md);

  const codeItem: SpeechPlanItem | undefined = plan.items.find(
    (it: SpeechPlanItem) => blocks[it.blockIndex].type === BlockType.CODE,
  );
  assert.ok(codeItem !== undefined, '代码块应参与朗读');
  assert.ok(!codeItem.segment.text.includes('```'), '围栏不入朗读文本');
  assert.ok(codeItem.segment.text.includes('const  a  =  1;'), '代码内部空白保留（preserveWhitespace）');

  // 段不跨块：相邻段若块不同，段边界即块边界
  for (let i: number = 1; i < plan.items.length; i++) {
    const prev: SpeechPlanItem = plan.items[i - 1];
    const cur: SpeechPlanItem = plan.items[i];
    if (prev.blockIndex !== cur.blockIndex) {
      assert.equal(cur.segment.startOffset >= prev.segment.endOffset, true);
    }
  }
});

test('planner：超长段落按 ≤300 字切段且全部锚定同一块', () => {
  const longText: string = '这是一句很长的话，'.repeat(60); // 360 字 > 300
  const blocks: DocumentBlock[] = [block(0, BlockType.PARAGRAPH, longText)];
  const plan: SpeechPlan = planSpeech(blocks, longText);
  assert.ok(plan.items.length >= 2, '超长段落应切成多段');
  for (let i: number = 0; i < plan.items.length; i++) {
    assert.ok(plan.items[i].segment.charCount <= 300, `段 ${i} 超过 300 字`);
    assert.equal(plan.items[i].blockIndex, 0);
  }
  // 全文不丢：拼接覆盖原文（规范化后）
  const joined: string = plan.items.map((it: SpeechPlanItem) => it.segment.text).join('');
  assert.equal(joined, longText.trim());
  assert.equal(plan.totalChars > 0, true);
});

test('planner：空文档 / 全文不可朗读 → 空计划', () => {
  const hr: DocumentBlock[] = [block(0, BlockType.THEMATIC_BREAK, '')];
  const plan: SpeechPlan = planSpeech(hr, '');
  assert.equal(plan.items.length, 0);
  assert.equal(plan.totalChars, 0);
});

// ---- SegmentQueue：有界与背压 ----

test('queue：容量校验与满员拒入（背压语义：不扩容，调用方停预取）', () => {
  assert.throws(() => new SegmentQueue(0), /正整数/);
  const q = new SegmentQueue(2);
  const item = (i: number): SpeechPlanItem => ({
    segment: { index: i, text: `t${i}`, startOffset: 0, endOffset: 3, charCount: 3 } as SpeechSegment,
    blockIndex: i,
  });
  assert.equal(q.tryPush(item(0)), true);
  assert.equal(q.tryPush(item(1)), true);
  assert.equal(q.isFull, true);
  assert.equal(q.tryPush(item(2)), false, '满员必须拒绝而非扩容');
  assert.equal(q.size, 2);
  assert.equal(q.peek()?.segment.index, 0);
  assert.equal(q.shift()?.segment.index, 0);
  assert.equal(q.tryPush(item(2)), true, '消费后可再补货（低水位）');
  q.clear();
  assert.equal(q.isEmpty, true);
});

// ---- controller：顺序播放与状态机 ----

test('controller：顺序播完整个计划，状态 ready→playing→completed，段序与计划一致', async () => {
  const driver = new AutoDriver();
  const engine = new SystemTtsEngine(driver);
  const { events, cb } = collector();
  const c = new SpeechPlaybackController(engine, cb);

  const blocks: DocumentBlock[] = [
    block(0, BlockType.HEADING, '标题'),
    block(1, BlockType.PARAGRAPH, '第一段。'),
    block(2, BlockType.PARAGRAPH, '第二段。'),
  ];
  const plan: SpeechPlan = planSpeech(blocks, '标题\n\n第一段。\n\n第二段。');
  assert.equal(plan.items.length, 3);

  await c.load(plan);
  assert.equal(c.state, 'ready');
  await c.play();
  assert.equal(c.state, 'completed');

  assert.deepEqual(spokenTexts(driver), ['标题', '第一段。', '第二段。']);
  assert.deepEqual(
    events.filter((e: string) => e.startsWith('state:')),
    ['state:ready', 'state:playing', 'state:completed'],
  );
  assert.deepEqual(
    events.filter((e: string) => e.startsWith('start:')),
    ['start:0@0', 'start:1@1', 'start:2@2'],
  );
  assert.equal(events[events.length - 1], 'done');
  // 段播完按整段字符数回报（TTS-0 口径）
  assert.ok(events.includes('progress:2:4'));
});

test('controller：预取有界——第 k 段开播时已 speak 数 ≤ k+1（不整篇预合成）', async () => {
  const driver = new AutoDriver();
  const engine = new SystemTtsEngine(driver);
  const { cb } = collector();
  const started: number[] = [];
  const innerCb: PlaybackCallbacks = {
    onStateChange: cb.onStateChange,
    onSegmentStart: (item: SpeechPlanItem): void => {
      started.push(item.segment.index);
      // 开播第 k 段时，引擎至多已收到 k+1 个 speak（当前段 + 之前完成的）：
      // 预取窗口在控制器队列侧（有界），引擎侧不预合成未来段（背压口径）
      assert.ok(
        driver.spoken.length <= item.segment.index + 1,
        `第 ${item.segment.index} 段开播时已 speak ${driver.spoken.length} 个（预取越界）`,
      );
      cb.onSegmentStart(item);
    },
    onProgress: cb.onProgress,
    onSegmentFinish: cb.onSegmentFinish,
    onPlanComplete: cb.onPlanComplete,
    onError: cb.onError,
  };
  const c = new SpeechPlaybackController(engine, innerCb, { windowHigh: 3 });

  const blocks: DocumentBlock[] = [];
  for (let i: number = 0; i < 10; i++) {
    blocks.push(block(i, BlockType.PARAGRAPH, `第 ${i} 段。`));
  }
  const md: string = blocks.map((b: DocumentBlock) => b.text).join('\n\n');
  const plan: SpeechPlan = planSpeech(blocks, md);
  assert.equal(plan.items.length, 10);

  await c.load(plan);
  await c.play();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

// ---- controller：换文 / 快进 / 暂停恢复的 generation 正确性 ----

test('controller：播到一半换文——旧文余段绝不入引擎，新文从头播', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  const { events, cb } = collector();
  const c = new SpeechPlaybackController(engine, cb);

  const planA: SpeechPlan = planSpeech(
    [block(0, BlockType.PARAGRAPH, '甲一。'), block(1, BlockType.PARAGRAPH, '甲二。'), block(2, BlockType.PARAGRAPH, '甲三。')],
    '甲一。\n\n甲二。\n\n甲三。',
  );
  const planB: SpeechPlan = planSpeech(
    [block(0, BlockType.PARAGRAPH, '乙一。'), block(1, BlockType.PARAGRAPH, '乙二。')],
    '乙一。\n\n乙二。',
  );

  await c.load(planA);
  const loopA: Promise<void> = c.play();
  // 等 A 首段真正进入驱动（用 spoken 而非事件：事件与 B 首段同名会撞条件）
  await until(() => driver.spoken.length >= 1, 'A 首段入驱动');
  // 甲一播到一半换文
  await c.load(planB);
  await loopA;
  assert.equal(c.state, 'ready');

  const loopB: Promise<void> = c.play();
  await driveUntil(() => stateOf(c) !== 'playing', 'B 播完', driver);
  await loopB;

  assert.deepEqual(spokenTexts(driver), ['甲一。', '乙一。', '乙二。'], '甲二/甲三绝不被合成');
  assert.equal(c.state, 'completed');
});

test('controller：快进（播放中 seek）——目标段之前的段不再播，从目标段续播', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  const { events, cb } = collector();
  const c = new SpeechPlaybackController(engine, cb);

  const blocks: DocumentBlock[] = [];
  for (let i: number = 0; i < 6; i++) {
    blocks.push(block(i, BlockType.PARAGRAPH, `段${i}。`));
  }
  const plan: SpeechPlan = planSpeech(blocks, blocks.map((b: DocumentBlock) => b.text).join('\n\n'));

  await c.load(plan);
  const loop: Promise<void> = c.play();
  await driveUntil(() => events.includes('start:1@1'), '播到第 2 段', driver);

  const seeked: Promise<void> = c.seekToSegment(4);
  await driveUntil(() => events.includes('start:4@4'), 'seek 后从第 5 段开播', driver);
  await driveUntil(() => stateOf(c) !== 'playing', '播完', driver);
  await loop;
  await seeked;

  assert.deepEqual(spokenTexts(driver), ['段0。', '段1。', '段4。', '段5。'], '被跳过的段 2/3 不入引擎');
  assert.equal(c.state, 'completed');
});

test('controller：暂停=段边界作废，恢复从当前段头重读（TTS-0 整段粒度）', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  const { events, cb } = collector();
  const c = new SpeechPlaybackController(engine, cb);

  const plan: SpeechPlan = planSpeech(
    [block(0, BlockType.PARAGRAPH, '首段。'), block(1, BlockType.PARAGRAPH, '次段。')],
    '首段。\n\n次段。',
  );

  await c.load(plan);
  const loop: Promise<void> = c.play();
  await driveUntil(() => events.includes('start:1@1'), '播到次段', driver);
  await c.pause();

  assert.equal(c.state, 'paused');
  assert.equal(c.currentIndex, 1, '游标回到在播段头');
  assert.equal(driver.stoppedRequestIds.length, 1, 'pause 对在播段发 stop');
  await loop;

  const loop2: Promise<void> = c.play();
  assert.equal(c.state, 'playing');
  await driveUntil(() => stateOf(c) !== 'playing', '恢复后播完', driver);
  await loop2;

  assert.deepEqual(spokenTexts(driver), ['首段。', '次段。', '次段。'], '恢复重读被暂停的段');
  assert.equal(c.state, 'completed');
});

test('controller：中断（来电/焦点抢占）= 段边界暂停并记录原因，恢复后原因清除', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  const { events, cb } = collector();
  const c = new SpeechPlaybackController(engine, cb);

  const plan: SpeechPlan = planSpeech([block(0, BlockType.PARAGRAPH, '一段。')], '一段。');
  await c.load(plan);
  const loop: Promise<void> = c.play();
  await until(() => events.includes('start:0@0'), '开播');

  await c.interrupt('来电');
  assert.equal(c.state, 'paused');
  assert.equal(c.lastInterruptReason, '来电');
  await loop;

  const loop2: Promise<void> = c.play();
  assert.equal(c.lastInterruptReason, undefined, '恢复后中断原因清除');
  while (stateOf(c) === 'playing') {
    const req = driver.spoken[driver.spoken.length - 1];
    if (req !== undefined && driver.inflightCount > 0) {
      driver.simulateComplete(req.requestId);
    }
    await tick();
  }
  await loop2;
  assert.equal(c.state, 'completed');
});

test('controller：段级错误 → failed 并停泵；重试从同段继续，可播完', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  const { events, cb } = collector();
  const c = new SpeechPlaybackController(engine, cb);

  const plan: SpeechPlan = planSpeech(
    [block(0, BlockType.PARAGRAPH, '好段。'), block(1, BlockType.PARAGRAPH, '坏段。'), block(2, BlockType.PARAGRAPH, '尾段。')],
    '好段。\n\n坏段。\n\n尾段。',
  );

  await c.load(plan);
  const loop: Promise<void> = c.play();
  await driveUntil(() => events.includes('start:1@1'), '播到坏段', driver);
  const badReq = driver.spoken[driver.spoken.length - 1];
  driver.simulateError(badReq.requestId, 218000001, '合成失败');
  await loop;

  assert.equal(c.state, 'failed');
  assert.equal(c.lastError, '218000001: 合成失败');
  assert.ok(events.some((e: string) => e.startsWith('error:218000001')));
  assert.deepEqual(spokenTexts(driver), ['好段。', '坏段。'], '失败后不再预播后续段');

  // 重试：从坏段继续
  const retry: Promise<void> = c.play();
  await driveUntil(() => stateOf(c) !== 'playing', '重试后播完', driver);
  await retry;
  assert.deepEqual(spokenTexts(driver), ['好段。', '坏段。', '坏段。', '尾段。']);
  assert.equal(c.state, 'completed');
});

test('controller：stop 回到计划头可直接再播；空计划安全降级', async () => {
  const driver = new AutoDriver();
  const engine = new SystemTtsEngine(driver);
  const { cb } = collector();
  const c = new SpeechPlaybackController(engine, cb);

  const plan: SpeechPlan = planSpeech([block(0, BlockType.PARAGRAPH, '只有一段。')], '只有一段。');
  await c.load(plan);
  await c.play();
  assert.equal(c.state, 'completed');

  await c.play(); // completed 再播 = 从头重播
  assert.equal(c.state, 'completed');
  assert.deepEqual(spokenTexts(driver), ['只有一段。', '只有一段。']);

  await c.stop();
  assert.equal(c.state, 'ready');
  await c.play();
  assert.equal(c.state, 'completed');

  await c.load({ items: [], totalChars: 0, speakableBlocks: 0 });
  assert.equal(c.state, 'idle');
  await c.play(); // 空计划 no-op
  assert.equal(c.state, 'idle');

  await c.release();
  assert.equal(engine.state, 'released');
});

// ---- 真机验收回归：引擎单例 + 阅读页每次新建控制器 → 代际签发器必须进程级 ----

test('controller：跨控制器代际签发——同一引擎上新建控制器不再撞 lastGeneration', async () => {
  const driver = new AutoDriver();
  const engine = new SystemTtsEngine(driver); // 引擎单例（AppServices 语义），跨控制器复用

  const planA: SpeechPlan = planSpeech([block(0, BlockType.PARAGRAPH, '第一篇。')], '第一篇。');
  const planB: SpeechPlan = planSpeech([block(0, BlockType.PARAGRAPH, '第二篇。')], '第二篇。');

  // 第一个控制器（第一篇笔记的阅读页）：播完，引擎 lastGeneration 已推进
  const { cb: cb1 } = collector();
  const c1 = new SpeechPlaybackController(engine, cb1);
  await c1.load(planA);
  await c1.play();
  assert.equal(c1.state, 'completed');

  // 第二个控制器（新阅读页，引擎不变）——修复前必抛「generation 1 未自增（last=N）」
  const { events: events2, cb: cb2 } = collector();
  const c2 = new SpeechPlaybackController(engine, cb2);
  await c2.load(planB);
  await c2.play();
  assert.equal(c2.state, 'completed');

  assert.deepEqual(spokenTexts(driver), ['第一篇。', '第二篇。']);
  assert.ok(events2.includes('start:0@0'));
});
