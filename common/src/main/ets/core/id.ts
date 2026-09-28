/**
 * 实体稳定身份：UUID v7（设计 §4.8 —— 云同步预留要求"实体稳定身份 UUID v7"）。
 *
 * 为什么自实现而不调 `util.generateRandomUUID`：
 *  ① 后者产出 v4（无时间序），未来同步需要按时间单调排序的 ID，避免索引碎片；
 *  ② 自实现才能注入 IClock / IRandom，单测可复现（设计 §5 可测试性）。
 * 平台适配层仍可提供原生实现，但默认路径走这里，保证两端 ID 语义一致。
 */

import { IClock, IRandom } from './ports';
import { toHex } from './bytes';

const RAND_A_BYTES: number = 2;
const RAND_B_BYTES: number = 8;

/** RFC 9562 UUID v7：48 位毫秒时间戳 + 12 位 rand_a + 62 位 rand_b */
export function uuidv7(clock: IClock, random: IRandom): string {
  const ms: number = clock.nowMs();
  if (!Number.isFinite(ms) || ms < 0 || ms > 0xffffffffffff) {
    throw new Error('uuidv7: clock out of 48-bit range');
  }
  const timeHex: string = ms.toString(16).padStart(12, '0');

  const randA: Uint8Array = random.nextBytes(RAND_A_BYTES);
  const randB: Uint8Array = random.nextBytes(RAND_B_BYTES);

  const a: number = randA[0] & 0x0f; // 高 4 位留给版本号
  const b: number = randA[1];
  const randAHex: string = ((a << 8) | b).toString(16).padStart(3, '0');

  const randBHex: string = toHex(randB);
  const variantNibble: number = (parseInt(randBHex.charAt(0), 16) & 0x03) | 0x08; // 10xx
  const randBHex2: string = variantNibble.toString(16) + randBHex.slice(1);

  return (
    timeHex.slice(0, 8) +
    '-' +
    timeHex.slice(8, 12) +
    '-7' +
    randAHex +
    '-' +
    randBHex2.slice(0, 4) +
    '-' +
    randBHex2.slice(4)
  );
}

const UUID_V7_RE: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 校验是否为合法 UUID v7 小写串；备份/恢复导入必须校验（防伪造与脏数据） */
export function isUuidV7(value: string): boolean {
  return UUID_V7_RE.test(value);
}

/** 从 UUID v7 反解时间戳（毫秒）；非法输入返回 undefined */
export function uuidV7TimestampMs(value: string): number | undefined {
  if (!isUuidV7(value)) {
    return undefined;
  }
  const parsed: number = parseInt(value.slice(0, 8) + value.slice(9, 13), 16);
  return Number.isFinite(parsed) ? parsed : undefined;
}
