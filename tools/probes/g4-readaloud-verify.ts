/**
 * G4 离线朗读验收 · 主机侧逻辑验证台架（S5-3；不进 321 测试基线，手动执行）。
 *
 * 场景：
 *  S1 长文连续朗读（≈2.2 万字符 / 100+ 段，按 275 字/分折算 ≥10 分钟量级）——
 *     全段恰好各播一次、顺序与计划一致、高亮锚点（blockIndex）恒合法且文本属于锚定块。
 *  S2 长文中途打断/恢复（外部事件模式，同 AVSession 焦点回调派发形态）——
 *     段边界暂停对在播段发出 stop；恢复从在播段头重读并播完。
 *  S3 中断竞态探针（与段下发同一调用栈的同步派发形态）——只观察输出 finding：
 *     检验「interrupt 在引擎登记 active 之前到达」时，已下发样本是否漏发 stop
 *     （真机上可能表现为幽灵音频 + 恢复重读；主机无音频链路，仅验证派发事实）。
 *  S4 音色/语速切换回归：idle 时改设置 → 引擎以新参数重建；越界语速收敛为 2。
 *
 * ⚠️ 不替代真机联验：播放由无时钟 Fake 驱动推进，实际欠载、断网可用性、锁屏播控、
 * 焦点抢占与 onComplete 时序语义仍属 tools/report/g4-tts-probe.md §5 真机项。
 *
 * 运行：npm run probe:g4
 *      （= tsc -p tsconfig.json && node dist/tools/probes/g4-readaloud-verify.js）
 */

import assert from 'node:assert/strict';
import { BlockType, DocumentBlock } from '../../common/src/main/ets/core/model';
import { FakeTtsDriver } from '../../speech/src/main/ets/core/testing';
import { SystemTtsEngine } from '../../speech/src/main/ets/core/engine';
import { planSpeech, SpeechPlan, SpeechPlanItem } from '../../speech/src/main/ets/core/planner';
import {
  PlaybackCallbacks,
  PlaybackState,
  SpeechPlaybackController,
} from '../../speech/src/main/ets/core/controller';

// ---- 台架 ----

class TimedDriver extends FakeTtsDriver {
  override async speak(utterance: { requestId: number; text: string }): Promise<void> {
    await super.speak(utterance);
    setTimeout(() => this.simulateStart(utterance.requestId), 0);
    setTimeout(() => this.simulateComplete(utterance.requestId), 0);
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 读取控制器状态（独立函数切断 TS 字面量收窄，驱动手动推进循环的轮询用） */
function stateOf(c: SpeechPlaybackController): PlaybackState {
  return c.state;
}

function block(index: number, text: string): DocumentBlock {
  return {
    id: `1:${index}:0`,
    type: BlockType.PARAGRAPH,
    level: 0,
    range: { startLine: 0, endLine: 1, startOffset: 0, endOffset: text.length },
    text,
    docRevision: 1,
  };
}

/** 约 2.2 万字符的纯中文长文（40 段 × 546 字），无数字/英文，规范化改写不生效 */
function buildLongDoc(): { blocks: DocumentBlock[]; md: string } {
  const sentence = '云边协同的推理链路需要离线可用作为前提约束，这是设计文档中反复核验过的结论。';
  const blocks: DocumentBlock[] = [];
  for (let i: number = 0; i < 40; i++) {
    blocks.push(block(i, sentence.repeat(14)));
  }
  return { blocks, md: blocks.map((b: DocumentBlock) => b.text).join('\n\n') };
}

function buildShortDoc(texts: string[]): { blocks: DocumentBlock[]; md: string } {
  const blocks: DocumentBlock[] = texts.map((t: string, i: number) => block(i, t));
  return { blocks, md: texts.join('\n\n') };
}

function silentCollector(onSegmentStart?: (item: SpeechPlanItem) => void): PlaybackCallbacks {
  return {
    onStateChange: (_state: PlaybackState): void => undefined,
    onSegmentStart: (item: SpeechPlanItem): void => {
      if (onSegmentStart !== undefined) {
        onSegmentStart(item);
      }
    },
    onProgress: (): void => undefined,
    onSegmentFinish: (): void => undefined,
    onPlanComplete: (): void => undefined,
    onError: (): void => undefined,
  };
}

// ---- S1 长文连续 ----

async function s1LongContinuous(): Promise<void> {
  const { blocks, md } = buildLongDoc();
  const plan: SpeechPlan = planSpeech(blocks, md);
  const n: number = plan.items.length;
  assert.ok(n >= 100, `S1 前置：段数不足，got ${n}`);
  assert.ok(plan.totalChars / 275 >= 10, `S1 前置：时长折算 <10 分钟（${plan.totalChars} 字）`);

  for (const item of plan.items) {
    assert.ok(item.blockIndex >= 0 && item.blockIndex < blocks.length, `段 ${item.segment.index} 锚点越界`);
    assert.ok(
      blocks[item.blockIndex].text.includes(item.segment.text),
      `段 ${item.segment.index} 文本不属于锚定块 ${item.blockIndex}`,
    );
  }

  const driver = new TimedDriver();
  const engine = new SystemTtsEngine(driver);
  const starts: number[] = [];
  const c = new SpeechPlaybackController(
    engine,
    silentCollector((item: SpeechPlanItem): void => {
      starts.push(item.segment.index);
    }),
    { windowHigh: 2 },
  );
  await c.load(plan);
  const t0: number = Date.now();
  await c.play();
  const dur: number = Date.now() - t0;

  assert.equal(c.state, 'completed', 'S1：应完整播完');
  assert.deepEqual(
    starts,
    Array.from({ length: n }, (_v: number, i: number): number => i),
    'S1：段序必须与计划一致且每段恰好开播一次',
  );
  assert.equal(driver.spoken.length, n, 'S1：speak 次数 = 段数（串行无双播）');
  assert.equal(driver.stoppedRequestIds.length, 0, 'S1：无打断时不应有 stop');
  console.log(`S1 PASS 长文连续：${n} 段 / ${plan.totalChars} 字（≥10 分钟量级），串行单播，全段序+高亮锚点校验通过（台架 ${dur}ms）`);
}

// ---- S2 长文打断/恢复（外部事件模式）----

async function s2PauseResume(): Promise<void> {
  const { blocks, md } = buildLongDoc();
  const plan: SpeechPlan = planSpeech(blocks, md);
  const n: number = plan.items.length;
  const driver = new TimedDriver();
  const engine = new SystemTtsEngine(driver);

  const ctlRef: { c?: SpeechPlaybackController } = {};
  let armed: boolean = false;
  let fired: boolean = false;
  const cb: PlaybackCallbacks = silentCollector((item: SpeechPlanItem): void => {
    if (!armed && item.segment.index === n - 6) {
      armed = true;
      return;
    }
    if (armed && !fired && item.segment.index === n - 3) {
      fired = true;
      // 外部事件模式：0ms 定时器 = 下一个宏任务派发（焦点中断事件的典型派发形态）
      setTimeout(() => {
        void (ctlRef.c as SpeechPlaybackController).interrupt('来电（模拟）');
      }, 0);
    }
  });
  const c = new SpeechPlaybackController(engine, cb, { windowHigh: 2 });
  ctlRef.c = c;

  await c.load(plan);
  await c.play();
  assert.equal(c.state, 'paused', 'S2：外部中断应进入 paused');
  assert.equal(c.lastInterruptReason, '来电（模拟）');
  assert.ok(driver.stoppedRequestIds.length >= 1, 'S2：外部中断必须对在播段发出 stop');
  const idxBefore: number = c.currentIndex;
  const textBefore: string = plan.items[idxBefore].segment.text;
  const spokenSnapshot: number = driver.spoken.length;

  await c.play(); // 恢复
  assert.equal(c.state, 'completed', 'S2：恢复后应播完');
  assert.equal(c.lastInterruptReason, undefined, 'S2：恢复后中断原因应清除');
  const after: string[] = driver.spoken.slice(spokenSnapshot).map((u) => u.text);
  assert.ok(after.length >= 1 && after[0] === textBefore, 'S2：恢复必须从在播段头重读（TTS-0 整段粒度）');
  console.log(`S2 PASS 长文打断/恢复：${n} 段计划，外部中断进入 paused 并对在播段发 stop，恢复重读当前段头后播完`);
}

// ---- S3 中断竞态探针（同步同栈模式，只观察不断言 ghost）----

async function s3SyncInterruptProbe(): Promise<string> {
  const doc = buildShortDoc(['第一段。', '第二段。', '第三段。']);
  const plan: SpeechPlan = planSpeech(doc.blocks, doc.md);
  assert.ok(plan.items.length >= 3, `S3 前置：期望 3 段（短文各一段），got ${plan.items.length}`);

  const driver = new FakeTtsDriver(); // 手动推进：可精确判定「漏发 stop」
  const engine = new SystemTtsEngine(driver);
  const ctlRef: { c?: SpeechPlaybackController } = {};
  const ghostTarget = plan.items[1].segment.text;
  let hookDone: boolean = false;

  const cb: PlaybackCallbacks = silentCollector((item: SpeechPlanItem): void => {
    if (!hookDone && item.segment.text === ghostTarget) {
      hookDone = true;
      // 同步同栈：模拟「中断回调恰在段下发的同一调用栈内到达」的窄窗口（真机派发模型未知）
      void (ctlRef.c as SpeechPlaybackController).interrupt('同步同栈（探针）');
    }
  });
  const c = new SpeechPlaybackController(engine, cb, { windowHigh: 3 });
  ctlRef.c = c;
  await c.load(plan);

  const loop1: Promise<void> = c.play();
  for (let i: number = 0; i < 60; i++) {
    const last = driver.spoken[driver.spoken.length - 1];
    if (last !== undefined && driver.inflightCount > 0) {
      driver.simulateComplete(last.requestId);
    }
    await tick();
    if (driver.inflightCount === 0 && stateOf(c) !== 'playing') {
      break;
    }
  }
  await loop1;
  assert.equal(c.state, 'paused', 'S3：同步中断后应进入 paused');

  const ghostFirst = driver.spoken.findIndex((u) => u.text === ghostTarget);
  const ghost = driver.spoken[ghostFirst];
  const stopIssued: boolean = driver.stoppedRequestIds.includes(ghost.requestId);
  const dispatchesBeforeResume: number = driver.spoken.filter((u) => u.text === ghostTarget).length;

  const loop2: Promise<void> = c.play();
  for (let i: number = 0; i < 60; i++) {
    const last = driver.spoken[driver.spoken.length - 1];
    if (last !== undefined && driver.inflightCount > 0) {
      driver.simulateComplete(last.requestId);
    }
    await tick();
    if (driver.inflightCount === 0 && stateOf(c) !== 'playing') {
      break;
    }
  }
  await loop2;
  assert.equal(c.state, 'completed', 'S3：恢复后应播完');

  const totalGhost: number = driver.spoken.filter((u) => u.text === ghostTarget).length;
  assert.ok(totalGhost > dispatchesBeforeResume, 'S3：恢复应重读被暂停段');

  if (!stopIssued) {
    return (
      'FINDING[竞态窗口] 中断与段下发同栈时，引擎 stop 在登记前扑空：被暂停段的样本已入驱动且未收到 stop' +
      '（主机表现=恢复重读；真机 playType=1 单通道下可能出现暂停后仍闻旧音、或恢复 speak 与残留样本冲突）。' +
      '外部事件派发路径经 S2 验证是干净的，该窗口仅在「回调与泵循环同调用栈」时触发。建议加固：pause 同步段记录待废弃代际，' +
      '引擎登记时校验；并把「onComplete=播放完毕（非合成完毕）」列入真机核对。'
    );
  }
  return 'OK 同步同栈中断也正确发出 stop（未复现漏 stop 窗口）';
}

// ---- S4 音色/语速切换回归 ----

async function s4VoiceSpeed(): Promise<void> {
  const doc = buildShortDoc(['第一段测试文本。', '第二段测试文本。']);
  const plan: SpeechPlan = planSpeech(doc.blocks, doc.md);
  const driver = new TimedDriver();
  const engine = new SystemTtsEngine(driver);
  const c = new SpeechPlaybackController(engine, silentCollector());

  await c.load(plan);
  await c.play();
  assert.equal(c.state, 'completed');
  assert.equal(driver.createdWith.length, 1);
  assert.deepEqual(driver.createdWith[0], {
    language: 'zh-CN',
    person: 0,
    speed: 1,
    volume: 1,
    pitch: 1,
  });

  await engine.updateSettings({ person: 2, speed: 1.5 });
  await c.play();
  assert.equal(c.state, 'completed');
  assert.equal(driver.createdWith.length, 2, '音色变更应在 idle 废弃旧引擎并重建');
  assert.equal(driver.createdWith[1].person, 2, '重建应携带新音色');
  assert.equal(driver.createdWith[1].speed, 1.5, '重建应携带新语速');

  await engine.updateSettings({ speed: 5 });
  await c.play();
  assert.equal(c.state, 'completed');
  assert.equal(driver.createdWith.length, 3);
  assert.equal(driver.createdWith[2].speed, 2, '越界语速 5 应收敛为上限 2');
  assert.equal(driver.createdWith[2].person, 2, '未改动字段应保留');
  console.log('S4 PASS 音色/语速：默认参数 → (person=2, speed=1.5) 重建生效 → 越界语速收敛为 2');
}

// ---- main ----

async function main(): Promise<void> {
  const t0: number = Date.now();
  await s1LongContinuous();
  await s2PauseResume();
  const raceResult: string = await s3SyncInterruptProbe();
  console.log(`S3 ${raceResult.startsWith('OK') ? 'PASS' : 'OBSERVE'} 同步同栈中断探针：${raceResult}`);
  await s4VoiceSpeed();
  console.log(`TOTAL ${Date.now() - t0}ms`);
}

main().then(
  (): void => process.exit(0),
  (err: unknown): void => {
    console.error('G4 验证台架 FAIL：', err);
    process.exit(1);
  },
);