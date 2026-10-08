import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ForegroundCheck,
  ForegroundPromptController,
} from '../../common/src/main/ets/core/foreground';
import { ClipboardProbe } from '../../common/src/main/ets/core/ports';

/**
 * 回前台提示状态机（S2-4，WHY-96）。
 * 真值口径 = common/src/main/ets/core/foreground.ts 头注：
 *  - 检测只读布尔，永不读内容（readText 一旦在此路径被调用即视为破口径，故探针里让它抛错）；
 *  - 每个"非空集"只提示一次；出现过"空"即新集。
 */

class QueueProbe implements ClipboardProbe {
  private readonly answers: boolean[];

  constructor(answers: boolean[]) {
    this.answers = answers;
  }

  async hasData(): Promise<boolean> {
    const next: boolean | undefined = this.answers.shift();
    if (next === undefined) {
      throw new Error('QueueProbe exhausted');
    }
    return next;
  }

  async readText(): Promise<string> {
    // 提示状态机绝不允许经由本探针读取内容
    throw new Error('readText must never be called by ForegroundPromptController');
  }

  async changeCount(): Promise<number> {
    return 0;
  }
}

function throwingProbe(): ClipboardProbe {
  return {
    async hasData(): Promise<boolean> {
      throw new Error('201 Permission verification failed');
    },
    async readText(): Promise<string> {
      throw new Error('unreachable');
    },
    async changeCount(): Promise<number> {
      throw new Error('unreachable');
    },
  };
}

test('首次回前台且剪贴板有内容 → 弹提示条', async () => {
  const c = new ForegroundPromptController();
  const res = await c.checkOnForeground(new QueueProbe([true]));
  assert.equal(res, ForegroundCheck.SHOW);
  assert.ok(c.isPromptOpen);
});

test('同一集内用户未处理：继续保留（KEEP），不重复"新弹"', async () => {
  const c = new ForegroundPromptController();
  await c.checkOnForeground(new QueueProbe([true]));
  const res2 = await c.checkOnForeground(new QueueProbe([true]));
  assert.equal(res2, ForegroundCheck.KEEP);
  const res3 = await c.checkOnForeground(new QueueProbe([true]));
  assert.equal(res3, ForegroundCheck.KEEP);
  assert.ok(c.isPromptOpen);
});

test('用户忽略后同内容反复回前台 → 不再弹（拒绝后不得反复打扰）', async () => {
  const c = new ForegroundPromptController();
  await c.checkOnForeground(new QueueProbe([true]));
  c.dismiss();
  assert.ok(!c.isPromptOpen);
  for (let i = 0; i < 3; i++) {
    const res = await c.checkOnForeground(new QueueProbe([true]));
    assert.equal(res, ForegroundCheck.NONE);
  }
});

test('用户点"查看并保存"后本集不再弹；内容转空再转非空 → 新集再弹', async () => {
  const c = new ForegroundPromptController();
  await c.checkOnForeground(new QueueProbe([true]));
  c.accept();
  assert.equal(await c.checkOnForeground(new QueueProbe([true])), ForegroundCheck.NONE);
  // 集边界：出现过一次"空"（无论用户手动清空还是自然失效）
  assert.equal(await c.checkOnForeground(new QueueProbe([false])), ForegroundCheck.NONE);
  assert.ok(!c.isPromptOpen);
  // 新复制 → 新集，提示恢复
  assert.equal(await c.checkOnForeground(new QueueProbe([true])), ForegroundCheck.SHOW);
});

test('无内容 → 不弹且清除抑制（下次非空按新集处理）', async () => {
  const c = new ForegroundPromptController();
  assert.equal(await c.checkOnForeground(new QueueProbe([false])), ForegroundCheck.NONE);
  assert.ok(!c.isPromptOpen);
  assert.equal(await c.checkOnForeground(new QueueProbe([true])), ForegroundCheck.SHOW);
});

test('探测失败（如 201）按"无内容"处理：不弹、不抛', async () => {
  const c = new ForegroundPromptController();
  const res = await c.checkOnForeground(throwingProbe());
  assert.equal(res, ForegroundCheck.NONE);
  assert.ok(!c.isPromptOpen);
});

test('提示条停留中内容被清空 → 回前台复查自动收条', async () => {
  const c = new ForegroundPromptController();
  await c.checkOnForeground(new QueueProbe([true]));
  assert.ok(c.isPromptOpen);
  assert.equal(await c.checkOnForeground(new QueueProbe([false])), ForegroundCheck.NONE);
  assert.ok(!c.isPromptOpen);
});

test('reset 清空集记忆（供未来"关闭/重开采集"开关）', async () => {
  const c = new ForegroundPromptController();
  await c.checkOnForeground(new QueueProbe([true]));
  c.accept();
  assert.ok(c.isEpisodeSuppressed);
  c.reset();
  assert.ok(!c.isEpisodeSuppressed);
  assert.ok(!c.isPromptOpen);
});
