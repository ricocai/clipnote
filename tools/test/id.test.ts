import { test } from 'node:test';
import assert from 'node:assert/strict';

import { uuidv7, isUuidV7, uuidV7TimestampMs } from '../../common/src/main/ets/core/id';
import { FixedClock, SequentialRandom } from './support/platform';

test('uuidv7 形状正确（版本位 7、变体位 10xx）', () => {
  const clock = new FixedClock(1759000000000);
  const id = uuidv7(clock, new SequentialRandom());
  assert.equal(id.length, 36);
  assert.ok(isUuidV7(id), id);
  assert.equal(id.charAt(14), '7');
  assert.ok(['8', '9', 'a', 'b'].includes(id.charAt(19)), id);
});

test('uuidv7 可反解时间戳（同步场景需要按时间序切分）', () => {
  const ms = 1759000000000;
  const clock = new FixedClock(ms);
  const id = uuidv7(clock, new SequentialRandom());
  assert.equal(uuidV7TimestampMs(id), ms);
});

test('不同时刻的 uuidv7 字典序与时间序一致', () => {
  const clock = new FixedClock(1759000000000);
  const rand = new SequentialRandom();
  const a = uuidv7(clock, rand);
  clock.advance(1);
  const b = uuidv7(clock, rand);
  clock.advance(1000);
  const c = uuidv7(clock, rand);
  assert.ok(a < b, `${a} < ${b}`);
  assert.ok(b < c, `${b} < ${c}`);
});

test('isUuidV7 拒绝 v4 与随机串', () => {
  assert.equal(isUuidV7('123e4567-e89b-42d3-a456-426614174000'), false);
  assert.equal(isUuidV7('not-a-uuid'), false);
  assert.equal(isUuidV7('123E4567-E89B-72D3-A456-426614174000'), false, '必须是小写规范形');
});

test('uuidv7 超出 48 位时间范围时显式失败，而不是静默产出坏 ID', () => {
  assert.throws(() => uuidv7(new FixedClock(2 ** 49), new SequentialRandom()));
});
