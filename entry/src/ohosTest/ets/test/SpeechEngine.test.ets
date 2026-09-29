/**
 * S5-1 speech 引擎设备侧用例（设计 §4.6 / G4 探测结论的设备侧复核）。
 *
 * 覆盖：capability 分支 / 生命周期状态机 / generation 取消语义 / 设置持久化。
 * 全部通过注入 speech 导出的 FakeTtsDriver 驱动内核——官方明确模拟器不支持
 * 系统 TTS（G4 探测），真驱动路径只能在真机联验（G4 §5 清单）执行；
 * 本文件与 tools/test/speech-engine.test.ts 跑同一套内核逻辑。
 */
import { describe, it, expect } from '@ohos/hypium';
import { SpeechSegment } from 'common';
import {
  FakeTtsDriver,
  InMemoryTtsSettingsStore,
  SystemTtsEngine,
  TtsCallbacks,
} from 'speech';

function seg(text: string): SpeechSegment {
  return { index: 0, text, startOffset: 0, endOffset: text.length, charCount: text.length };
}

function noopCallbacks(): TtsCallbacks {
  return {
    onReady: (): void => undefined,
    onProgress: (): void => undefined,
    onError: (): void => undefined,
  };
}

/** 让 fire-and-forget 的 speak() 跑过 ensureEngine 前置 await，进入 speaking 态 */
function tick(): Promise<void> {
  return new Promise<void>((resolve: () => void) => {
    setTimeout(resolve, 0);
  });
}

/** 记录回调事件的探针 */
function probeCallbacks(events: string[]): TtsCallbacks {
  return {
    onReady: (g: number): void => {
      events.push(`ready:${g}`);
    },
    onProgress: (g: number, chars: number): void => {
      events.push(`progress:${g}:${chars}`);
    },
    onError: (g: number, reason: string): void => {
      events.push(`error:${g}:${reason}`);
    },
  };
}

export default function speechEngineTest(): void {
  describe('SpeechEngine', () => {
    it('capability 分支：创建失败显式禁用（available=false+reason），init 拒绝', async () => {
      const driver: FakeTtsDriver = new FakeTtsDriver();
      driver.createError = '设备无离线 TTS 引擎';
      const engine: SystemTtsEngine = new SystemTtsEngine(driver);

      const cap = await engine.capability();
      expect(cap.available).assertFalse();
      expect(cap.offline).assertTrue();
      expect(cap.voiceCount).assertEqual(0);
      expect(cap.reason !== undefined && cap.reason.indexOf('无离线') >= 0).assertTrue();
      expect(engine.state).assertEqual('unavailable');

      let threw: boolean = false;
      try {
        await engine.init();
      } catch (e) {
        threw = (e as Error).message.indexOf('系统 TTS 不可用') >= 0;
      }
      expect(threw).assertTrue();
    });

    it('capability 分支：创建成功 → available=true 离线引擎，init 幂等只建一次引擎', async () => {
      const driver: FakeTtsDriver = new FakeTtsDriver();
      const engine: SystemTtsEngine = new SystemTtsEngine(driver);

      const cap = await engine.capability();
      expect(cap.available).assertTrue();
      expect(cap.engineName).assertEqual('system-text-to-speech');
      expect(cap.offline).assertTrue();

      await engine.init();
      await engine.init();
      expect(engine.state).assertEqual('idle');
      expect(driver.createdWith.length).assertEqual(1);
    });

    it('生命周期：idle → speaking → idle，回调 onReady/onProgress 按序到达', async () => {
      const driver: FakeTtsDriver = new FakeTtsDriver();
      const engine: SystemTtsEngine = new SystemTtsEngine(driver);
      const events: string[] = [];

      const done: Promise<void> = engine.speak(
        { segment: seg('第一句。'), generation: 1, speed: 1 },
        probeCallbacks(events),
      );
      await tick();
      expect(engine.state).assertEqual('speaking');
      const requestId: number = driver.spoken[0].requestId;
      driver.simulateStart(requestId);
      driver.simulateComplete(requestId);
      await done;

      expect(engine.state).assertEqual('idle');
      expect(events.length).assertEqual(2);
      expect(events[0]).assertEqual('ready:1');
      expect(events[1]).assertEqual('progress:1:4');
    });

    it('生命周期：pause/resume 方案 A——stop 后以新代际续读同一段，非法转移拒绝', async () => {
      const driver: FakeTtsDriver = new FakeTtsDriver();
      const engine: SystemTtsEngine = new SystemTtsEngine(driver);
      await engine.init();

      const speakDone: Promise<void> = engine.speak(
        { segment: seg('暂停我。'), generation: 1, speed: 1 },
        noopCallbacks(),
      );
      await tick();

      let pauseThrew: boolean = false;
      try {
        await engine.pause(999);
      } catch (e) {
        pauseThrew = (e as Error).message.indexOf('未命中在播代际') >= 0;
      }
      expect(pauseThrew).assertTrue();

      await engine.pause(1);
      expect(engine.state).assertEqual('paused');
      await speakDone;

      let staleResumeThrew: boolean = false;
      try {
        await engine.resume(1); // 旧代际
      } catch (e) {
        staleResumeThrew = (e as Error).message.indexOf('未自增') >= 0;
      }
      expect(staleResumeThrew).assertTrue();

      const resumed: Promise<void> = engine.resume(2);
      await tick();
      expect(engine.state).assertEqual('speaking');
      expect(driver.spoken.length).assertEqual(2);
      expect(driver.spoken[1].text).assertEqual('暂停我。');
      driver.simulateComplete(driver.spoken[1].requestId);
      await resumed;
      expect(engine.state).assertEqual('idle');
    });

    it('生命周期：release 后一切操作拒绝，shutdown 恰好一次', async () => {
      const driver: FakeTtsDriver = new FakeTtsDriver();
      const engine: SystemTtsEngine = new SystemTtsEngine(driver);
      await engine.init();

      let resumeThrew: boolean = false;
      try {
        await engine.resume(1);
      } catch (e) {
        resumeThrew = (e as Error).message.indexOf('必须先 pause') >= 0;
      }
      expect(resumeThrew).assertTrue();

      await engine.release();
      expect(engine.state).assertEqual('released');

      let speakThrew: boolean = false;
      try {
        await engine.speak({ segment: seg('x'), generation: 1, speed: 1 }, noopCallbacks());
      } catch (e) {
        speakThrew = (e as Error).message.indexOf('已 release') >= 0;
      }
      expect(speakThrew).assertTrue();

      await engine.release(); // 幂等
      expect(driver.shutdownCount).assertEqual(1);
    });

    it('取消语义：新代际 speak 废弃旧样本——旧 speak 正常结束，旧回调迟到被丢弃', async () => {
      const driver: FakeTtsDriver = new FakeTtsDriver();
      const engine: SystemTtsEngine = new SystemTtsEngine(driver);
      await engine.init();
      const staleProgress: string[] = [];

      const speak1: Promise<void> = engine.speak(
        { segment: seg('旧段落。'), generation: 1, speed: 1 },
        probeCallbacks(staleProgress),
      );
      await tick();
      const oldRequestId: number = driver.spoken[0].requestId;

      const speak2: Promise<void> = engine.speak(
        { segment: seg('新段落。'), generation: 2, speed: 1 },
        noopCallbacks(),
      );
      await speak1; // 被取代 = 正常取消
      expect(driver.stoppedRequestIds[0]).assertEqual(oldRequestId);

      driver.simulateComplete(oldRequestId); // 旧驱动迟到回调
      await speak2.then(() => undefined);
      expect(staleProgress.length).assertEqual(0);
      expect(engine.state).assertEqual('idle');
    });

    it('取消语义：stop 幂等，只认在播代际；过期 stop 是安全空操作', async () => {
      const driver: FakeTtsDriver = new FakeTtsDriver();
      const engine: SystemTtsEngine = new SystemTtsEngine(driver);
      await engine.init();

      const speakDone: Promise<void> = engine.speak(
        { segment: seg('停止我。'), generation: 1, speed: 1 },
        noopCallbacks(),
      );
      await tick();
      await engine.stop(0); // 旧代际：no-op
      expect(engine.state).assertEqual('speaking');
      await engine.stop(1);
      expect(engine.state).assertEqual('idle');
      await engine.stop(1); // 重复：no-op
      await speakDone;
      expect(driver.stoppedRequestIds.length).assertEqual(1);
    });

    it('取消语义：引擎错误 onError + reject speak，重复迟到错误丢弃', async () => {
      const driver: FakeTtsDriver = new FakeTtsDriver();
      const engine: SystemTtsEngine = new SystemTtsEngine(driver);
      await engine.init();
      const errors: string[] = [];

      const speakDone: Promise<void> = engine.speak(
        { segment: seg('会失败的段。'), generation: 1, speed: 1 },
        probeCallbacks(errors),
      );
      await tick();
      const requestId: number = driver.spoken[0].requestId;
      driver.simulateError(requestId, 218000001, 'text length exceeds limit');

      let rejected: boolean = false;
      try {
        await speakDone;
      } catch (e) {
        rejected = (e as Error).message.indexOf('218000001') >= 0;
      }
      expect(rejected).assertTrue();
      expect(errors.length).assertEqual(1);
      expect(errors[0]).assertEqual('error:1:218000001: text length exceeds limit');
      expect(engine.state).assertEqual('idle');

      driver.simulateError(requestId, 218000001, 'text length exceeds limit'); // 迟到重复
      expect(errors.length).assertEqual(1);
    });

    it('设置持久化：roundtrip + 越界收敛，新实例从同一 store 恢复', async () => {
      const store: InMemoryTtsSettingsStore = new InMemoryTtsSettingsStore();
      const a: SystemTtsEngine = new SystemTtsEngine(new FakeTtsDriver(), store);
      const saved = await a.updateSettings({ person: 0, speed: 1.5 });
      expect(saved.speed).assertEqual(1.5);

      const b: SystemTtsEngine = new SystemTtsEngine(new FakeTtsDriver(), store);
      await b.init();
      const restored = await b.updateSettings({});
      expect(restored.person).assertEqual(0);
      expect(restored.speed).assertEqual(1.5);

      const clamped = await b.updateSettings({ speed: 99 });
      expect(clamped.speed).assertEqual(2);
    });
  });
}
