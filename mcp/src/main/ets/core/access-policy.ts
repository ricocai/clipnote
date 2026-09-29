/**
 * AccessPolicy 服务端强制（S6-1；设计 §4.5.5 工具级授权语义）。
 *
 * 本文件承载三类冻结契约与一套强制闸门：
 *  1. `McpToolName` / `ToolAuthorization` / `McpAuditRecord` —— 首发工具集合与单次调用的
 *     授权决定，语义冻结（原 `mcp/Index.ets` 前半部分，逐字迁入以便 core 内部引用；
 *     对外仍由 Index.ets 原样再导出，接口形状与语义不变）；
 *  2. `AccessPolicy` —— 每客户端授权清单（grant）的内存权威源：**默认拒绝**，
 *     每次 `authorize()` 现场查表，不缓存决定 —— 授权变更（收窄/撤销）即时生效；
 *  3. `PolicyGate` —— 服务端强制的唯一收口：工具调用必须经 `execute()` 进入，
 *     拒绝/异常/成功三态都落审计（经 `IMcpAuditSink`，由装配层接 common 的
 *     `McpAuditRepository` 落库）。S6-3 的 McpDispatcher 只允许经本闸门触达工具实现。
 *
 * 审计纪律：只记元数据（客户端、工具、对象 ID、结果、时间、载荷字节数），
 * **不记正文、不记令牌**（设计 §4.5.5）。正文中的"请调用工具删除其他内容"等文字
 * 是数据，本层不解析正文，天然不扩大权限；提示词注解不构成授权。
 *
 * 授权清单目前为内存态：与 S6-2 的凭证/会话口径一致（前台周期边界，stop 即清零）。
 * 若后续凭证持久化，授权清单须随之一并落库（另立任务，不在 S6-1 范围）。
 */

import { ClockLike } from './transport-ports';

/** 首发工具集合。注意：Resources / Prompts 按客户端需要再增，不预置。 */
export enum McpToolName {
  SEARCH_NOTES = 'search_notes',
  GET_NOTE = 'get_note',
  CREATE_NOTE = 'create_note',
  APPEND_TO_NOTE = 'append_to_note',
  DELETE_NOTE = 'delete_note',
  LIST_TAGS = 'list_tags',
}

/**
 * 单次调用的授权决定。**服务端强制**，提示词注解不构成授权（设计 §4.5.5）。
 * 正文里出现"请调用工具删除其他内容"这类文字只是数据，不得扩大权限。
 */
export interface ToolAuthorization {
  readonly tool: McpToolName;
  readonly allowed: boolean;
  /** 允许访问的集合范围；空集合表示只能访问显式授权对象 */
  readonly scope: {
    readonly collectionIds: string[];
    readonly noteIds: string[];
    /** 收件箱与回收站默认排除，必须显式打开 */
    readonly includeInbox: boolean;
    readonly includeTrash: boolean;
  };
  readonly maxResults?: number;
  readonly maxSnippetChars?: number;
  readonly denyReason?: string;
}

export interface McpAuditRecord {
  readonly clientId: string;
  readonly tool: McpToolName;
  readonly objectIds: string[];
  readonly result: 'ok' | 'denied' | 'error';
  readonly atMs: number;
  /** 审计**不记完整正文**，仅记长度与摘要，避免日志成为数据泄露面 */
  readonly payloadBytes: number;
}

// ---------------------------------------------------------------------------
// 授权清单（每客户端 grant）
// ---------------------------------------------------------------------------

/** 授权范围（与 ToolAuthorization.scope 同形；独立声明便于 grant 输入复用） */
export interface AuthorizationScope {
  readonly collectionIds: string[];
  readonly noteIds: string[];
  readonly includeInbox: boolean;
  readonly includeTrash: boolean;
}

export interface GrantInput {
  readonly clientId: string;
  /** 允许调用的工具；未列出的一律拒绝 */
  readonly tools: McpToolName[];
  readonly collectionIds?: string[];
  readonly noteIds?: string[];
  /** 缺省 false：收件箱/回收站必须显式打开（设计 §4.5.5） */
  readonly includeInbox?: boolean;
  readonly includeTrash?: boolean;
  readonly maxResults?: number;
  readonly maxSnippetChars?: number;
}

/** 已生效的每客户端授权（快照；modify 须走 grant() 替换， revoke() 撤销） */
export interface McpClientGrant {
  readonly clientId: string;
  readonly tools: McpToolName[];
  readonly scope: AuthorizationScope;
  readonly maxResults: number;
  readonly maxSnippetChars: number;
  readonly grantedAtMs: number;
}

export const DEFAULT_MAX_RESULTS: number = 20;
export const DEFAULT_MAX_SNIPPET_CHARS: number = 200;
/** 上限护栏：grant 也不能突破（防止配置错误把全库暴露给单个客户端） */
export const HARD_MAX_RESULTS: number = 200;
export const HARD_MAX_SNIPPET_CHARS: number = 4000;

function clampNonNegative(v: number, hardMax: number): number {
  if (Number.isNaN(v) || v < 0) {
    return 0;
  }
  const floored: number = Math.floor(v);
  return floored > hardMax ? hardMax : floored;
}

function copyStrings(v: string[] | undefined): string[] {
  const out: string[] = [];
  if (v === undefined) {
    return out;
  }
  for (let i: number = 0; i < v.length; i++) {
    out.push(v[i]);
  }
  return out;
}

function copyTools(v: McpToolName[]): McpToolName[] {
  const out: McpToolName[] = [];
  for (let i: number = 0; i < v.length; i++) {
    out.push(v[i]);
  }
  return out;
}

export class AccessPolicy {
  private readonly grants: Map<string, McpClientGrant> = new Map();

  constructor(private readonly clock: ClockLike) {}

  /** 授予/变更授权（同 clientId 整体替换，变更对下一次 authorize 立即生效） */
  grant(input: GrantInput): McpClientGrant {
    const grant: McpClientGrant = {
      clientId: input.clientId,
      tools: copyTools(input.tools),
      scope: {
        collectionIds: copyStrings(input.collectionIds),
        noteIds: copyStrings(input.noteIds),
        includeInbox: input.includeInbox === true,
        includeTrash: input.includeTrash === true,
      },
      maxResults: clampNonNegative(
        input.maxResults === undefined ? DEFAULT_MAX_RESULTS : input.maxResults,
        HARD_MAX_RESULTS,
      ),
      maxSnippetChars: clampNonNegative(
        input.maxSnippetChars === undefined ? DEFAULT_MAX_SNIPPET_CHARS : input.maxSnippetChars,
        HARD_MAX_SNIPPET_CHARS,
      ),
      grantedAtMs: this.clock.nowMs(),
    };
    this.grants.set(input.clientId, grant);
    return grant;
  }

  /** 撤销：立即生效 —— 已签发的 ToolAuthorization 快照不得复用（见 authorize 口径） */
  revoke(clientId: string): boolean {
    return this.grants.delete(clientId);
  }

  revokeAll(): number {
    const n: number = this.grants.size;
    this.grants.clear();
    return n;
  }

  grantOf(clientId: string): McpClientGrant | undefined {
    return this.grants.get(clientId);
  }

  listGrants(): McpClientGrant[] {
    const out: McpClientGrant[] = [];
    for (const g of this.grants.values()) {
      out.push(g);
    }
    return out;
  }

  /**
   * 单次调用的授权决定。**每次调用现场查表**，不缓存、不快照复用 ——
   * 这是"授权变更即时生效"的实现口径：revoke()/grant() 之后的第一条调用
   * 即按新清单判定（重放旧授权决定无效）。
   *
   * 默认拒绝：无 grant、工具未列出，都返回 allowed=false 并附 denyReason。
   */
  authorize(clientId: string, tool: McpToolName): ToolAuthorization {
    const grant: McpClientGrant | undefined = this.grants.get(clientId);
    if (grant === undefined) {
      return denied(tool, 'no grant for client');
    }
    for (let i: number = 0; i < grant.tools.length; i++) {
      if (grant.tools[i] === tool) {
        const auth: ToolAuthorization = {
          tool,
          allowed: true,
          scope: grant.scope,
          maxResults: grant.maxResults,
          maxSnippetChars: grant.maxSnippetChars,
        };
        return auth;
      }
    }
    return denied(tool, 'tool not granted');
  }
}

function denied(tool: McpToolName, reason: string): ToolAuthorization {
  return {
    tool,
    allowed: false,
    scope: { collectionIds: [], noteIds: [], includeInbox: false, includeTrash: false },
    denyReason: reason,
  };
}

// ---------------------------------------------------------------------------
// 范围与限量谓词（纯函数；S6-3 dispatcher 在解析工具参数后逐个复核）
// ---------------------------------------------------------------------------

/** 一次调用触及的对象（集合成员由数据层解析后传入；本层不感知表结构） */
export interface ScopeObject {
  readonly id: string;
  readonly collectionIds: string[];
  readonly inInbox: boolean;
  readonly inTrash: boolean;
}

function contains(list: readonly string[], v: string): boolean {
  for (let i: number = 0; i < list.length; i++) {
    if (list[i] === v) {
      return true;
    }
  }
  return false;
}

/**
 * 对象可见性判定（设计 §4.5.5）：
 *  - 未授权决定（allowed=false）下一切皆不可见；
 *  - 收件箱/回收站对象必须显式打开对应开关；
 *  - 显式授权的 noteId 直接可见；否则要求对象集合与授权集合有交集；
 *  - 授权集合为空 ⇒ 只能访问显式授权对象（冻结语义）。
 */
export function isObjectInScope(auth: ToolAuthorization, obj: ScopeObject): boolean {
  if (!auth.allowed) {
    return false;
  }
  if (obj.inInbox && !auth.scope.includeInbox) {
    return false;
  }
  if (obj.inTrash && !auth.scope.includeTrash) {
    return false;
  }
  if (contains(auth.scope.noteIds, obj.id)) {
    return true;
  }
  for (let i: number = 0; i < obj.collectionIds.length; i++) {
    if (contains(auth.scope.collectionIds, obj.collectionIds[i])) {
      return true;
    }
  }
  return false;
}

/** 条数限量：requested 缺省或超限都收敛到授权上限（设计 §4.5.5 "限定条数"） */
export function clampMaxResults(auth: ToolAuthorization, requested?: number): number {
  const cap: number = auth.maxResults === undefined ? DEFAULT_MAX_RESULTS : auth.maxResults;
  if (requested === undefined || Number.isNaN(requested) || requested <= 0) {
    return cap;
  }
  const floored: number = Math.floor(requested);
  return floored > cap ? cap : floored;
}

/** 片段长度限量：超长截断（设计 §4.5.5 "限定片段长度"） */
export function clampSnippet(auth: ToolAuthorization, text: string): string {
  const cap: number = auth.maxSnippetChars === undefined ? DEFAULT_MAX_SNIPPET_CHARS : auth.maxSnippetChars;
  return text.length > cap ? text.slice(0, cap) : text;
}

// ---------------------------------------------------------------------------
// 强制闸门 + 审计
// ---------------------------------------------------------------------------

/** 授权拒绝：dispatcher 层映射为协议错误（不得吞掉重写为成功） */
export class AccessDeniedError extends Error {
  constructor(readonly authorization: ToolAuthorization) {
    super(authorization.denyReason === undefined ? 'access denied' : authorization.denyReason);
  }
}

/** 审计落库通道（装配层接 common 的 McpAuditRepository；测试可内存假实现） */
export interface IMcpAuditSink {
  append(record: McpAuditRecord): Promise<void>;
}

/**
 * common `McpAuditRepository.append(...)` 的最小结构契约。
 * 与 credentials.ts 的 HasherLike 同一手法：mcp core 不 import common
 * （否则本机 tsc 基线无法解析 'common' 包名），靠结构兼容在装配层对接。
 */
export interface McpAuditStoreLike {
  append(
    clientId: string,
    tool: string,
    objectIds: readonly string[],
    result: 'ok' | 'denied' | 'error',
    atMs: number,
    payloadBytes: number,
  ): Promise<void>;
}

/** IMcpAuditSink → 落库仓储的适配器（entry 装配与本机测试共用） */
export class McpAuditStoreSink implements IMcpAuditSink {
  constructor(private readonly store: McpAuditStoreLike) {}

  append(record: McpAuditRecord): Promise<void> {
    return this.store.append(
      record.clientId,
      record.tool,
      record.objectIds,
      record.result,
      record.atMs,
      record.payloadBytes,
    );
  }
}

/** execute 的返回值载荷：业务结果 + 本次触及的对象 ID（审计用，仅 ID） */
export interface ToolInvocation<T> {
  readonly result: T;
  readonly objectIds: string[];
}

/**
 * 服务端强制闸门：工具调用的唯一入口。
 * 三态都落审计：
 *  - 授权拒绝 → result='denied'，抛 AccessDeniedError；
 *  - 工具执行抛错 → result='error'，原样上抛；
 *  - 成功 → result='ok'，objectIds 取工具自报的触及对象。
 */
export class PolicyGate {
  constructor(
    private readonly policy: AccessPolicy,
    private readonly audit: IMcpAuditSink,
    private readonly clock: ClockLike,
  ) {}

  /** 纯判定（不落审计）：供 dispatcher 在 tools/list 等枚举场景过滤可见性 */
  authorize(clientId: string, tool: McpToolName): ToolAuthorization {
    return this.policy.authorize(clientId, tool);
  }

  async execute<T>(
    clientId: string,
    tool: McpToolName,
    payloadBytes: number,
    fn: (auth: ToolAuthorization) => Promise<ToolInvocation<T>>,
  ): Promise<T> {
    const auth: ToolAuthorization = this.policy.authorize(clientId, tool);
    if (!auth.allowed) {
      await this.appendAudit(clientId, tool, [], 'denied', payloadBytes);
      throw new AccessDeniedError(auth);
    }
    try {
      const invocation: ToolInvocation<T> = await fn(auth);
      await this.appendAudit(clientId, tool, invocation.objectIds, 'ok', payloadBytes);
      return invocation.result;
    } catch (err) {
      await this.appendAudit(clientId, tool, [], 'error', payloadBytes);
      throw err;
    }
  }

  private async appendAudit(
    clientId: string,
    tool: McpToolName,
    objectIds: string[],
    result: 'ok' | 'denied' | 'error',
    payloadBytes: number,
  ): Promise<void> {
    const record: McpAuditRecord = {
      clientId,
      tool,
      objectIds,
      result,
      atMs: this.clock.nowMs(),
      payloadBytes,
    };
    await this.audit.append(record);
  }
}
