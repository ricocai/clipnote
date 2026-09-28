/**
 * 每客户端凭证存储（Bearer token）。
 * 设计 §4.5.3：配对后签发每客户端独立高熵凭证，支持过期、撤销与最小权限；
 * 凭证绑定证书代际 —— 证书轮换后旧凭证全部拒绝（"更新后重建信任"）。
 * token 明文只在签发瞬间出现一次；存储与日志只留 SHA-256 摘要。
 */

import { AuthenticatedClient, ClockLike, IssuedCredential, RandomLike } from './transport-ports';

export interface HasherLike {
  /** 与 common IHasher 同契约：小写 64 位十六进制 SHA-256 */
  sha256Hex(data: string): Promise<string>;
}

export interface CredentialRecord {
  readonly clientId: string;
  readonly label: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly revoked: boolean;
  readonly certGeneration: number;
}

/** 内部可变存储形态；对外只暴露 CredentialRecord 快照 */
interface StoredCredentialRecord {
  clientId: string;
  label: string;
  tokenHash: string;
  issuedAtMs: number;
  expiresAtMs: number;
  revoked: boolean;
  certGeneration: number;
}

const B64URL: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64UrlEncode(bytes: Uint8Array): string {
  let out: string = '';
  let i: number = 0;
  while (i + 2 < bytes.length) {
    const n: number = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL.charAt((n >> 18) & 63) + B64URL.charAt((n >> 12) & 63) + B64URL.charAt((n >> 6) & 63) + B64URL.charAt(n & 63);
    i += 3;
  }
  if (i + 1 < bytes.length) {
    const n: number = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL.charAt((n >> 18) & 63) + B64URL.charAt((n >> 12) & 63) + B64URL.charAt((n >> 6) & 63);
  } else if (i < bytes.length) {
    const n: number = bytes[i] << 16;
    out += B64URL.charAt((n >> 18) & 63) + B64URL.charAt((n >> 12) & 63);
  }
  return out;
}

const CLIENT_ID_BYTES: number = 16;
const TOKEN_BYTES: number = 32;

export interface CredentialStoreOptions {
  readonly tokenTtlMs: number;
}

export class ClientCredentialStore {
  private readonly records: Map<string, StoredCredentialRecord> = new Map();

  constructor(
    private readonly random: RandomLike,
    private readonly hasher: HasherLike,
    private readonly clock: ClockLike,
    private readonly options: CredentialStoreOptions,
  ) {}

  async issue(label: string, certGeneration: number): Promise<IssuedCredential> {
    const clientId: string = base64UrlEncode(this.random.nextBytes(CLIENT_ID_BYTES));
    const token: string = base64UrlEncode(this.random.nextBytes(TOKEN_BYTES));
    const now: number = this.clock.nowMs();
    const record = {
      clientId,
      label,
      tokenHash: await this.hasher.sha256Hex(token),
      issuedAtMs: now,
      expiresAtMs: now + this.options.tokenTtlMs,
      revoked: false,
      certGeneration,
    };
    this.records.set(clientId, record);
    return { clientId, token, expiresAtMs: record.expiresAtMs, certGeneration };
  }

  /** 校验 token：存在、未过期、未撤销、证书代际匹配。任一不满足返回 undefined。 */
  async authenticate(token: string, currentCertGeneration: number): Promise<AuthenticatedClient | undefined> {
    const tokenHash: string = await this.hasher.sha256Hex(token);
    const now: number = this.clock.nowMs();
    for (const record of this.records.values()) {
      if (record.tokenHash !== tokenHash) {
        continue;
      }
      if (record.revoked || now > record.expiresAtMs || record.certGeneration !== currentCertGeneration) {
        return undefined;
      }
      return { clientId: record.clientId, certGeneration: record.certGeneration };
    }
    return undefined;
  }

  /** 撤销：立即失效（已撤销凭证不再出现在 list 之外，也不可再生） */
  revoke(clientId: string): boolean {
    const record = this.records.get(clientId);
    if (record === undefined) {
      return false;
    }
    record.revoked = true;
    return true;
  }

  /** 续期：换发新 token 并顺延过期时间（旧 token 即刻失效） */
  async renew(clientId: string, certGeneration: number): Promise<IssuedCredential | undefined> {
    const record = this.records.get(clientId);
    if (record === undefined || record.revoked) {
      return undefined;
    }
    const token: string = base64UrlEncode(this.random.nextBytes(TOKEN_BYTES));
    const now: number = this.clock.nowMs();
    record.tokenHash = await this.hasher.sha256Hex(token);
    record.issuedAtMs = now;
    record.expiresAtMs = now + this.options.tokenTtlMs;
    record.certGeneration = certGeneration;
    return { clientId, token, expiresAtMs: record.expiresAtMs, certGeneration };
  }

  list(): CredentialRecord[] {
    const out: CredentialRecord[] = [];
    for (const record of this.records.values()) {
      if (!record.revoked) {
        out.push({
          clientId: record.clientId,
          label: record.label,
          issuedAtMs: record.issuedAtMs,
          expiresAtMs: record.expiresAtMs,
          revoked: record.revoked,
          certGeneration: record.certGeneration,
        });
      }
    }
    return out;
  }
}
