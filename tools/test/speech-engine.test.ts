import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SpeechSegment } from '../../common/src/main/ets/core/speech';
import { FakeTtsDriver } from '../../speech/src/main/ets/core/testing';
import { SystemTtsEngine } from '../../speech/src/main/ets/core/engine';
import {
  DEFAULT_TTS_SETTINGS,
  InMemoryTtsSettingsStore,
  SPEED_MAX,
  SPEED_MIN,
  clampSpeed,
  sanitizeTtsVoiceSettings,
} from '../../speech/src/main/ets/core/settings';

function seg(text: string, index: number = 0): SpeechSegment {
  return { index, text, startOffset: 0, endOffset: text.length, charCount: text.length };
}

function noopCallbacks() {
  return {
    onReady: (): void => undefined,
    onProgress: (): void => undefined,
    onError: (): void => undefined,
  };
}

/** 让 fire-and-forget 的 speak() 跑过 ensureEngine 前置 await，进入 speaking 态 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---- capability 分支 ----

test('capability：引擎创建失败 → available=false + reason，init 拒绝（显式禁用，不静默转在线）', async () => {
  const driver = new FakeTtsDriver();
  driver.createError = '设备无离线 TTS 引擎';
  const engine = new SystemTtsEngine(driver);

  const cap = await engine.capability();
  assert.equal(cap.available, false);
  assert.equal(cap.offline, true);
  assert.equal(cap.voiceCount, 0);
  assert.match(cap.reason ?? '', /无离线/);
  assert.equal(engine.state, 'unavailable');

  await assert.rejects(() => engine.init(), /系统 TTS 不可用/);
});

test('capability：创建成功 → available=true/offline=true，init 幂等', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);

  const cap = await engine.capability();
  assert.equal(cap.available, true);
  assert.equal(cap.engineName, 'system-text-to-speech');
  assert.equal(cap.voiceCount, 1);

  await engine.init();
  await engine.init(); // 幂等
  assert.equal(engine.state, 'idle');
  assert.equal(driver.createdWith.length, 1); // 只创建一次
});

// ---- 生命周期状态机 ----

test('生命周期：uninitialized → idle → speaking → idle（段播完），回调 onReady/onProgress 按序', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  const events: string[] = [];

  const done = engine.speak(
    { segment: seg('第一句。'), generation: 1, speed: 1 },
    {
      onReady: (g: number): void => {
        events.push(`ready:${g}`);
      },
      onProgress: (g: number, chars: number): void => {
        events.push(`progress:${g}:${chars}`);
      },
      onError: (): void => undefined,
    },
  );
  await tick();
  assert.equal(engine.state, 'speaking');
  const requestId = driver.spoken[0].requestId;
  driver.simulateStart(requestId);
  driver.simulateComplete(requestId);
  await done;

  assert.equal(engine.state, 'idle');
  assert.deepEqual(events, ['ready:1', 'progress:1:4']);
});

test('生命周期：pause 仅允许命中在播代际，resume 须新代际续读同一段', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  await engine.init();

  const speakDone = engine.speak({ segment: seg('暂停我。'), generation: 1, speed: 1 }, noopCallbacks());
  await tick();
  assert.equal(engine.state, 'speaking');

  await assert.rejects(() => engine.pause(999), /未命中在播代际/);
  await engine.pause(1);
  assert.equal(engine.state, 'paused');
  await speakDone; // 取消视为正常完成

  await assert.rejects(() => engine.resume(1), /未自增/); // 旧代际拒绝
  const resumed = engine.resume(2);
  await tick();
  assert.equal(engine.state, 'speaking');
  assert.equal(driver.spoken.length, 2);
  assert.equal(driver.spoken[1].text, '暂停我。'); // 续读同一段
  driver.simulateComplete(driver.spoken[1].requestId);
  await resumed;
  assert.equal(engine.state, 'idle');
});

test('生命周期：非法转移被拒绝——未暂停不能 resume，release 后一切操作拒绝', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  await engine.init();

  await assert.rejects(() => engine.resume(1), /必须先 pause/);
  await engine.release();
  assert.equal(engine.state, 'released');
  await assert.rejects(() => engine.speak({ segment: seg('x'), generation: 1, speed: 1 }, noopCallbacks()), /已 release/);
  await assert.rejects(() => engine.stop(1), /已 release/);
  await engine.release(); // 幂等
  assert.equal(driver.shutdownCount, 1);
});

// ---- 取消语义（generation 代际取消） ----

test('取消：新代际 speak 废弃旧样本——旧 speak 正常 resolve，旧回调迟到被丢弃', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  await engine.init();

  const staleProgress: string[] = [];
  const speak1 = engine.speak(
    { segment: seg('旧段落。'), generation: 1, speed: 1 },
    {
      onReady: (): void => undefined,
      onProgress: (g: number): void => {
        staleProgress.push(`progress:${g}`);
      },
      onError: (): void => undefined,
    },
  );
  await tick();
  const oldRequestId = driver.spoken[0].requestId;

  const speak2 = engine.speak({ segment: seg('新段落。'), generation: 2, speed: 1 }, noopCallbacks());
  await speak1; // 被取代 = 正常取消，不 reject
  assert.deepEqual(driver.stoppedRequestIds, [oldRequestId]);

  // 旧驱动的迟到回调：不得触发旧代际 onProgress，不得干扰新代际
  driver.simulateComplete(oldRequestId);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(staleProgress, []);

  driver.simulateComplete(driver.spoken[1].requestId);
  await speak2;
  assert.equal(engine.state, 'idle');
});

test('取消：stop 幂等且只认在播代际——过期代际 stop 是安全空操作', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  await engine.init();

  const speakDone = engine.speak({ segment: seg('停止我。'), generation: 1, speed: 1 }, noopCallbacks());
  await tick();
  await engine.stop(0); // 旧代际：no-op
  assert.equal(engine.state, 'speaking');
  await engine.stop(1);
  assert.equal(engine.state, 'idle');
  await engine.stop(1); // 重复 stop：no-op
  await speakDone;
  assert.deepEqual(driver.stoppedRequestIds, [driver.spoken[0].requestId]);
});

test('取消：引擎错误上报 onError 并 reject speak，迟到错误丢弃', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  await engine.init();

  const errors: string[] = [];
  const speak1 = engine.speak(
    { segment: seg('会失败的段。'), generation: 1, speed: 1 },
    {
      onReady: (): void => undefined,
      onProgress: (): void => undefined,
      onError: (g: number, reason: string): void => {
        errors.push(`${g}:${reason}`);
      },
    },
  );
  await tick();
  const requestId = driver.spoken[0].requestId;
  driver.simulateError(requestId, 218000001, 'text length exceeds limit');
  await assert.rejects(speak1, /218000001/);
  assert.deepEqual(errors, ['1:218000001: text length exceeds limit']);
  assert.equal(engine.state, 'idle');

  // 同 requestId 的迟到重复错误：无 pending 可结算，静默丢弃
  driver.simulateError(requestId, 218000001, 'text length exceeds limit');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(errors, ['1:218000001: text length exceeds limit']);
});

test('取消：speak 代际未自增直接拒绝（契约保护）', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  await engine.init();

  const first = engine.speak({ segment: seg('一。'), generation: 1, speed: 1 }, noopCallbacks());
  await tick();
  await assert.rejects(
    engine.speak({ segment: seg('二。'), generation: 1, speed: 1 }, noopCallbacks()),
    /未自增/,
  );
  driver.simulateComplete(driver.spoken[0].requestId);
  await first;
});

// ---- requestId 一次性（G4 探测常见坑②） ----

test('requestId 单调自增、绝不复用', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  await engine.init();

  const s1 = engine.speak({ segment: seg('一。'), generation: 1, speed: 1 }, noopCallbacks());
  await tick();
  driver.simulateComplete(driver.spoken[0].requestId);
  await s1;
  const s2 = engine.speak({ segment: seg('二。'), generation: 2, speed: 1 }, noopCallbacks());
  await tick();
  driver.simulateComplete(driver.spoken[1].requestId);
  await s2;

  assert.deepEqual(driver.spoken.map((u) => u.requestId), [1, 2]);
});

// ---- 音色/语速持久化 ----

test('设置：持久化 roundtrip，损坏值回退默认，越界收敛', async () => {
  const store = new InMemoryTtsSettingsStore();
  const a = new SystemTtsEngine(new FakeTtsDriver(), store);
  await a.updateSettings({ person: 0, speed: 1.5 });
  assert.deepEqual(await store.load(), { person: 0, speed: 1.5 });

  // 新引擎实例从同一 store 恢复（updateSettings({}) 合并空补丁并回读当前值）
  const b = new SystemTtsEngine(new FakeTtsDriver(), store);
  await b.init();
  assert.deepEqual(await b.updateSettings({}), { person: 0, speed: 1.5 });

  assert.deepEqual(sanitizeTtsVoiceSettings({ person: -3, speed: Number.NaN }), DEFAULT_TTS_SETTINGS);
  assert.equal(clampSpeed(0.1), SPEED_MIN);
  assert.equal(clampSpeed(99), SPEED_MAX);
});

test('设置：音色变更在 idle 时废弃旧引擎，下次 speak 用新参数重建', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  await engine.init();
  assert.equal(driver.createdWith.length, 1);

  await engine.updateSettings({ person: 13, speed: 1.25 });
  const done = engine.speak({ segment: seg('换音色。'), generation: 1, speed: 1.25 }, noopCallbacks());
  await tick();
  assert.equal(driver.createdWith.length, 2);
  assert.equal(driver.createdWith[1].person, 13);
  assert.equal(driver.createdWith[1].speed, 1.25);
  driver.simulateComplete(driver.spoken[0].requestId);
  await done;
});

test('Q2a：播报参数随每次 speak 透传，倍速以用户设置为准（控制器缺省 1 不参与）', async () => {
  const driver = new FakeTtsDriver();
  const engine = new SystemTtsEngine(driver);
  await engine.init();
  await engine.updateSettings({ speed: 1.5 });

  // 控制器侧恒传缺省 speed=1（SpeechPlaybackOptions 未配速时）；实际播报必须取设置值 1.5
  const done = engine.speak({ segment: seg('倍速验证。'), generation: 1, speed: 1 }, noopCallbacks());
  await tick();
  assert.equal(driver.spoken.length, 1);
  assert.equal(driver.spoken[0].speed, 1.5);
  assert.equal(driver.spoken[0].volume, 1);
  assert.equal(driver.spoken[0].pitch, 1);
  driver.simulateComplete(driver.spoken[0].requestId);
  await done;

  // 段间换倍速：下一段立即用新值（段落边界生效语义，无需重建引擎）
  await engine.updateSettings({ speed: 0.75 });
  const done2 = engine.speak({ segment: seg('第二段。'), generation: 2, speed: 1 }, noopCallbacks());
  await tick();
  assert.equal(driver.spoken[1].speed, 0.75);
  driver.simulateComplete(driver.spoken[1].requestId);
  await done2;
});
