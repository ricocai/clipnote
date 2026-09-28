import { IClock } from '../core/ports';

/** 系统时钟。显式注入而非直接调用 Date.now()，使领域层时间相关逻辑可在单测中固定。 */
export class SystemClock implements IClock {
  nowMs(): number {
    return Date.now();
  }
}
