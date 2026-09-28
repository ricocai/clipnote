/**
 * 配对管理（设计 §4.5.3 验证点 3 + design/mcp-传输选型.md §4.3）：
 * 6 位配对码（短时有效、尝试限速、退后台即失效）+ 配对请求挂起队列
 * （等待手机端配对确认 UI 人工确认/拒绝）。
 *
 * 本类只做配对码与挂起状态机；凭证签发在调用方（server 用
 * ClientCredentialStore.issue 绑定证书代际），token 不出现在本层。
 */

import { ClockLike, PendingPairingView, RandomLike } from './transport-ports';

export interface PairingCodeView {
  readonly code: string;
  readonly expiresAtMs: number;
  readonly remainingAttempts: number;
}

export interface PairingManagerOptions {
  /** 配对码有效期（默认 5 分钟） */
  readonly codeTtlMs: number;
  /** 连续错误尝试上限，超限作废当前码（默认 5 次） */
  readonly maxAttempts: number;
}

/** attempt 结果三态：进入挂起 / 码错（附剩余次数）/ 无可用码 */
export type PairAttemptOutcome =
  | { kind: 'pending'; view: PendingPairingView }
  | { kind: 'invalid-code'; remainingAttempts: number }
  | { kind: 'no-active-code' };

/** UI 确认后交 server 签发凭证的载荷 */
export interface ConfirmedPairing {
  readonly id: string;
  /** 客户端自报名称，作为凭证 label */
  readonly label: string;
  readonly remoteAddress: string;
}

interface PendingEntry {
  readonly id: string;
  readonly clientName: string;
  readonly remoteAddress: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  state: 'waiting' | 'confirmed' | 'rejected' | 'expired';
}

const HEX: string = '0123456789abcdef';

export class PairingManager {
  private activeCode: { code: string; expiresAtMs: number; attempts: number } | undefined;
  private readonly pendings: Map<string, PendingEntry> = new Map();

  constructor(
    private readonly random: RandomLike,
    private readonly clock: ClockLike,
    private readonly options: PairingManagerOptions,
  ) {}

  /** 生成新配对码；旧码立即作废（已挂起的请求保留各自有效期，不受影响） */
  newCode(): PairingCodeView {
    const code: string = this.drawCode();
    this.activeCode = { code, expiresAtMs: this.clock.nowMs() + this.options.codeTtlMs, attempts: 0 };
    return this.currentCode() as PairingCodeView;
  }

  /** 当前有效码视图；已过期返回 undefined 并清除 */
  currentCode(): PairingCodeView | undefined {
    if (this.activeCode === undefined) {
      return undefined;
    }
    if (this.clock.nowMs() > this.activeCode.expiresAtMs) {
      this.activeCode = undefined;
      return undefined;
    }
    return {
      code: this.activeCode.code,
      expiresAtMs: this.activeCode.expiresAtMs,
      remainingAttempts: this.options.maxAttempts - this.activeCode.attempts,
    };
  }

  /**
   * Host 侧 POST /pair 的入口：校验配对码，正确则创建挂起请求等 UI 确认。
   * 错码累计尝试次数，达到上限即作废当前码（限速防爆破）。
   */
  attempt(code: string, clientName: string, remoteAddress: string): PairAttemptOutcome {
    const view: PairingCodeView | undefined = this.currentCode();
    if (view === undefined) {
      return { kind: 'no-active-code' };
    }
    if (code !== view.code) {
      if (this.activeCode !== undefined) {
        this.activeCode.attempts++;
        if (this.activeCode.attempts >= this.options.maxAttempts) {
          this.activeCode = undefined;
          return { kind: 'no-active-code' };
        }
      }
      return { kind: 'invalid-code', remainingAttempts: view.remainingAttempts - 1 };
    }
    const now: number = this.clock.nowMs();
    const entry: PendingEntry = {
      id: this.drawId(),
      clientName: clientName.slice(0, 64),
      remoteAddress,
      requestedAtMs: now,
      expiresAtMs: view.expiresAtMs,
      state: 'waiting',
    };
    this.pendings.set(entry.id, entry);
    return { kind: 'pending', view: toView(entry) };
  }

  /** UI 待确认列表 */
  pending(): PendingPairingView[] {
    this.sweepExpired();
    const out: PendingPairingView[] = [];
    for (const entry of this.pendings.values()) {
      if (entry.state === 'waiting') {
        out.push(toView(entry));
      }
    }
    return out;
  }

  /** UI 确认：仅 waiting 状态可确认，返回签发凭证所需载荷 */
  markConfirmed(id: string): ConfirmedPairing | undefined {
    const entry: PendingEntry | undefined = this.pendings.get(id);
    if (entry === undefined || entry.state !== 'waiting') {
      return undefined;
    }
    entry.state = 'confirmed';
    return { id: entry.id, label: entry.clientName, remoteAddress: entry.remoteAddress };
  }

  /** UI 拒绝 */
  markRejected(id: string): boolean {
    const entry: PendingEntry | undefined = this.pendings.get(id);
    if (entry === undefined || entry.state !== 'waiting') {
      return false;
    }
    entry.state = 'rejected';
    return true;
  }

  /** 挂起请求的当前状态（server 长轮询解析用） */
  stateOf(id: string): 'waiting' | 'confirmed' | 'rejected' | 'expired' | undefined {
    const entry: PendingEntry | undefined = this.pendings.get(id);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.state === 'waiting' && this.clock.nowMs() > entry.expiresAtMs) {
      entry.state = 'expired';
    }
    return entry.state;
  }

  /** 清扫过期挂起请求，返回本次转为 expired 的 id（server 据此唤醒长轮询） */
  sweepExpired(): string[] {
    const now: number = this.clock.nowMs();
    const out: string[] = [];
    for (const [id, entry] of this.pendings) {
      if (entry.state === 'waiting' && now > entry.expiresAtMs) {
        entry.state = 'expired';
        out.push(id);
      }
    }
    return out;
  }

  /**
   * 退后台/停止服务：配对码与全部挂起请求即刻失效（设计：配对码退后台即失效，
   * 控制滥用面）。已确认/拒绝的记录一并清出，前台周期内不留配对状态。
   */
  invalidateAll(): void {
    this.activeCode = undefined;
    for (const entry of this.pendings.values()) {
      if (entry.state === 'waiting') {
        entry.state = 'expired';
      }
    }
    this.pendings.clear();
  }

  /** 6 位数字码：按位拒绝采样（256 % 10 的偏差不接受） */
  private drawCode(): string {
    const bytes: Uint8Array = this.random.nextBytes(12);
    let code: string = '';
    for (let i: number = 0; i < 6; i++) {
      let b: number = bytes[i];
      while (b >= 250) {
        b = this.nextByte();
      }
      code += String(b % 10);
    }
    return code;
  }

  private nextByte(): number {
    return this.random.nextBytes(1)[0];
  }

  private drawId(): string {
    const bytes: Uint8Array = this.random.nextBytes(16);
    let out: string = '';
    for (let i: number = 0; i < 16; i++) {
      out += HEX.charAt((bytes[i] >> 4) & 0x0f) + HEX.charAt(bytes[i] & 0x0f);
    }
    return out;
  }
}

function toView(entry: PendingEntry): PendingPairingView {
  return {
    id: entry.id,
    clientName: entry.clientName,
    remoteAddress: entry.remoteAddress,
    requestedAtMs: entry.requestedAtMs,
    expiresAtMs: entry.expiresAtMs,
  };
}
