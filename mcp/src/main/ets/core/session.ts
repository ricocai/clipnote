/**
 * MCP 协议级会话（2025-11-25 语义，见协议锁定决议）：
 * 服务端在 initialize 成功后签发 `Mcp-Session-Id`，客户端后续请求必须携带；
 * 未知会话一律 404（规范：客户端必须重新 initialize）。
 * 会话 ID 为随机 UUID（版本 4 变体），无时间排序需求，会话本身前台周期内临时存在。
 */

import { ClockLike, RandomLike } from './transport-ports';

export interface McpSession {
  readonly id: string;
  /** 协商锁定的协议版本（MCP-Protocol-Version 头校验基准） */
  readonly protocolVersion: string;
  readonly createdAtMs: number;
  lastSeenMs: number;
}

const HEX: string = '0123456789abcdef';

function randomSessionId(random: RandomLike): string {
  const bytes: Uint8Array = random.nextBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let out: string = '';
  for (let i: number = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) {
      out += '-';
    }
    out += HEX.charAt((bytes[i] >> 4) & 0x0f) + HEX.charAt(bytes[i] & 0x0f);
  }
  return out;
}

export interface SessionManagerOptions {
  /** 空闲过期（滑动）；过期后访问按未知会话处理（404） */
  readonly idleTtlMs: number;
}

export class McpSessionManager {
  private readonly sessions: Map<string, McpSession> = new Map();

  constructor(
    private readonly clock: ClockLike,
    private readonly random: RandomLike,
    private readonly options: SessionManagerOptions,
  ) {}

  create(protocolVersion: string): McpSession {
    const now: number = this.clock.nowMs();
    const session: McpSession = {
      id: randomSessionId(this.random),
      protocolVersion,
      createdAtMs: now,
      lastSeenMs: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** 命中则刷新空闲时间；未命中/已过期返回 undefined 并清除尸体 */
  touch(id: string): McpSession | undefined {
    const session: McpSession | undefined = this.sessions.get(id);
    if (session === undefined) {
      return undefined;
    }
    const now: number = this.clock.nowMs();
    if (now - session.lastSeenMs > this.options.idleTtlMs) {
      this.sessions.delete(id);
      return undefined;
    }
    session.lastSeenMs = now;
    return session;
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  /** 清理全部过期会话（server 每次接受连接时顺手执行） */
  sweep(): number {
    const now: number = this.clock.nowMs();
    let removed: number = 0;
    this.sessions.forEach((session: McpSession, id: string) => {
      if (now - session.lastSeenMs > this.options.idleTtlMs) {
        this.sessions.delete(id);
        removed++;
      }
    });
    return removed;
  }

  size(): number {
    return this.sessions.size;
  }

  /** 服务停止/退后台时清空（前台服务边界：会话不跨前台周期保留） */
  clear(): void {
    this.sessions.clear();
  }
}
