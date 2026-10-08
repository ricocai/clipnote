import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AutoCaptureCheck,
  ClipboardAutoCaptureController,
} from '../../common/src/main/ets/core/foreground';
import { ClipboardProbe } from '../../common/src/main/ets/core/ports';

/**
 * 剪贴板直写采集门（第二批 Feature 6 真机实测修复）。
 * 真值口径 = common/src/main/ets/core/foreground.ts ClipboardAutoCaptureController 头注：
 *  - 首检基线化不补采（§4.1「不是历史补采」边界）；
 *  - 变更计数自增 → CAPTURE；不变 → SKIP；
 *  - 计数回零（剪贴板服务重启）→ 重新基线化，不采集；
 *  - 探测失败 → SKIP 且不污染基线；
 *  - syncAfterRead 抬基线防同内容二次抓取。
 * 真机回归背景：提示态的「非空集只处理一次」语义被直写复用导致连续复制
 * （剪贴板从不为空）只有第一次进收件箱——本采集门取代该口径。
 */

class CountProbe implements ClipboardProbe {
  private count: number;
  private fail: boolean;

  constructor(count: number) {
    this.count = count;
    this.fail = false;
  }

  set(count: number): void {
    this.count = count;
    this.fail = false;
  }

  failNext(): void {
    this.fail = true;
  }

  async hasData(): Promise<boolean> {
    return this.count > 0;
  }

  async readText(): Promise<string> {
    throw new Error('readText must never be called by ClipboardAutoCaptureController');
  }

  async changeCount(): Promise<number> {
    if (this.fail) {
      throw new Error('probe unavailable');
    }
    return this.count;
  }
}

test('首检基线化：不采集（不是历史补采）', async () => {
  const c = new ClipboardAutoCaptureController();
  const probe = new CountProbe(7);
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.SKIP);
});

test('基线后计数不变 → SKIP（同内容回前台不重复抓）', async () => {
  const c = new ClipboardAutoCaptureController();
  const probe = new CountProbe(7);
  await c.checkOnForeground(probe);
  probe.set(7);
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.SKIP);
});

test('连续复制（剪贴板从未为空）逐次 CAPTURE——真机回归用例', async () => {
  const c = new ClipboardAutoCaptureController();
  const probe = new CountProbe(7);
  await c.checkOnForeground(probe); // 基线 7
  probe.set(8); // 复制 A
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.CAPTURE);
  probe.set(9); // 复制 B（此前旧口径在此被吞掉）
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.CAPTURE);
  probe.set(10); // 复制 C
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.CAPTURE);
});

test('探测失败 → SKIP 且不污染基线，恢复后仍能判新', async () => {
  const c = new ClipboardAutoCaptureController();
  const probe = new CountProbe(7);
  await c.checkOnForeground(probe); // 基线 7
  probe.failNext();
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.SKIP);
  probe.set(8); // 失败未动基线（仍 7）→ 计 8 判为新
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.CAPTURE);
});

test('计数回零（剪贴板服务重启）→ 重新基线化不采集，随后新复制恢复判定', async () => {
  const c = new ClipboardAutoCaptureController();
  const probe = new CountProbe(100);
  await c.checkOnForeground(probe); // 基线 100
  probe.set(0); // 服务重启归零
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.SKIP); // 不误抓
  probe.set(1); // 重启后新复制
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.CAPTURE);
});

test('syncAfterRead 抬基线：显式读取后回前台不二次抓取同一内容', async () => {
  const c = new ClipboardAutoCaptureController();
  const probe = new CountProbe(7);
  await c.checkOnForeground(probe); // 基线 7
  probe.set(8); // 新复制，手动入口（安全控件）读取了它
  await c.syncAfterRead(probe); // 基线抬到 8
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.SKIP);
  probe.set(9); // 下一次复制恢复判定
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.CAPTURE);
});

test('syncAfterRead 探测失败不改变基线', async () => {
  const c = new ClipboardAutoCaptureController();
  const probe = new CountProbe(7);
  await c.checkOnForeground(probe);
  probe.set(8);
  probe.failNext();
  await c.syncAfterRead(probe); // 抛错被吞
  probe.set(8); // 恢复探测（set 同时清除 fail）
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.CAPTURE); // 基线仍 7
});

test('reset 后回到首检基线化语义', async () => {
  const c = new ClipboardAutoCaptureController();
  const probe = new CountProbe(7);
  await c.checkOnForeground(probe);
  c.reset();
  probe.set(9);
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.SKIP); // 重新基线化
  probe.set(10);
  assert.equal(await c.checkOnForeground(probe), AutoCaptureCheck.CAPTURE);
});
