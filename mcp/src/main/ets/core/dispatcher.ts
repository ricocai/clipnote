/**
 * 协议适配层（S6-3；设计 §4.5.5 工具语义 + 协议锁定决议）。
 *
 * ClipNoteMcpDispatcher 实现 endpoint.ts 声明的 McpDispatcher：
 *  - initialize：按 2025-11-25 lifecycle 回退协商 —— 无论客户端声明什么版本，
 *    一律返回我方锁定版本 `2025-11-25`（锁定决议：首发 Host 均为该代际）；
 *  - dispatch：ping / tools/list / tools/call 分发；tools/call 是唯一触达
 *    工具实现的路径，且**只能经 PolicyGate.execute 进入**（access-policy.ts
 *    头注释口径）：授权拒绝（AccessDeniedError）映射为 -32002，不得吞掉
 *    重写为成功；工具自身语义错误（not found / conflict / 参数校验）
 *    走 tools/call 的 isError 结果。
 *
 * 纪律：本文件属 mcp core —— 零 @kit.*、零 @ohos.*、零 Node 内建，只用 ArkTS 1.1
 * 与 TS 公共语法子集；跨模块依赖（笔记仓储）经 NoteStoreLike 结构端口注入，
 * 不 import 'common'（装配层用 NoteService 适配）。错误码只用规范内码
 * （-32700/-32600/-32601/-32602/-32603 与 -32002）。
 */

import {
  JsonRpcMethodError,
  McpDispatcher,
} from './endpoint';
import { McpSession } from './session';
import { AuthenticatedClient, ClockLike } from './transport-ports';
import {
  AccessDeniedError,
  McpToolName,
  PolicyGate,
  ScopeObject,
  ToolAuthorization,
  ToolInvocation,
  clampMaxResults,
  clampSnippet,
  isObjectInScope,
} from './access-policy';
import { asRecord } from './jsonrpc';

/** 锁定协议版本（协议锁定决议；endpoint 用它建会话并校验后续请求头） */
export const LOCKED_PROTOCOL_VERSION: string = '2025-11-25';
export const SERVER_NAME: string = 'clipnote';
export const SERVER_VERSION: string = '0.2.0';

/** 新建笔记正文上限（UTF-8 字节；与 common model.ts MAX_CLIP_TEXT_BYTES 同语义，core 内自定义常量避免跨模块依赖） */
export const MAX_NOTE_CONTENT_BYTES: number = 1024 * 1024;

/** 应用级幂等键有效期（设计 §4.5.5 扩展项；ClockLike 驱动） */
export const IDEMPOTENCY_TTL_MS: number = 24 * 60 * 60 * 1000;

const JSONRPC_INVALID_PARAMS: number = -32602;
const RATE_LIMIT_EXCEEDED: number = -32002;

// ---------------------------------------------------------------------------
// NoteStoreLike：笔记仓储结构端口（不 import common；装配层用 NoteService 适配）
// ---------------------------------------------------------------------------

export interface NoteSearchRow {
  readonly id: string;
  readonly title: string;
  readonly snippetText: string;
}

export interface NoteDetail {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly revision: number;
  /** 回收站口径：deletedAtMs 非 undefined 即已软删（inTrash） */
  readonly deletedAtMs?: number;
  /** 授权范围的集合成员当前映射为笔记的标签 id 集合（数据模型无 collection 实体） */
  readonly tagIds: string[];
}

export interface NoteCreateResult {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
}

export interface NoteAppendResult {
  readonly id: string;
  readonly revision: number;
}

export interface NoteTagRow {
  readonly id: string;
  readonly name: string;
}

export interface NoteStoreLike {
  search(query: string, limit: number): Promise<NoteSearchRow[]>;
  getById(id: string): Promise<NoteDetail | undefined>;
  create(input: { title: string; content: string }): Promise<NoteCreateResult>;
  /** 正文追加（"\n\n" 连接由适配层或仓储约定；本层只要求 revision+1 语义） */
  append(id: string, content: string): Promise<NoteAppendResult>;
  /** 软删除（可恢复口径） */
  remove(id: string): Promise<void>;
  listTags(): Promise<NoteTagRow[]>;
}

// ---------------------------------------------------------------------------
// 限流参数（每 clientId 滑动窗；超限 -32002，先于授权判定）
// ---------------------------------------------------------------------------

export interface DispatcherRateLimit {
  /** 滑动窗时长（毫秒） */
  readonly windowMs: number;
  /** 窗内 tools/call 次数上限 */
  readonly maxCalls: number;
}

export const DEFAULT_RATE_LIMIT: DispatcherRateLimit = { windowMs: 60_000, maxCalls: 60 };

// ---------------------------------------------------------------------------
// 工具描述（中文 description；inputSchema 与参数校验一致）
// ---------------------------------------------------------------------------

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

function descriptor(name: McpToolName, description: string, properties: Record<string, unknown>, required: string[]): ToolDescriptor {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required },
  };
}

function buildToolCatalog(): ToolDescriptor[] {
  const str: Record<string, unknown> = { type: 'string' };
  return [
    descriptor(
      McpToolName.SEARCH_NOTES,
      '搜索已授权集合内的笔记，返回条数与片段长度受授权上限收敛；收件箱与回收站默认排除。',
      {
        query: { ...str, description: '搜索关键词（必填，非空）' },
        limit: { type: 'number', description: '期望返回条数上限（会被授权上限收敛）' },
      },
      ['query'],
    ),
    descriptor(
      McpToolName.GET_NOTE,
      '读取单篇已授权笔记的完整正文（授权语义=校验单篇/集合授权）；越权或不存在一律报 not found，不泄露存在性。',
      {
        note_id: { ...str, description: '笔记 ID（必填）' },
      },
      ['note_id'],
    ),
    descriptor(
      McpToolName.CREATE_NOTE,
      '新建一篇笔记（来源标记为 MCP）；collection_ids 必须在授权集合范围内，否则拒绝。',
      {
        title: { ...str, description: '标题（缺省取正文首行）' },
        content: { ...str, description: 'Markdown 正文（必填，UTF-8 ≤ 1MB）' },
        collection_ids: { type: 'array', items: { type: 'string' }, description: '目标集合（当前映射为标签 id，须在授权范围内）' },
      },
      ['content'],
    ),
    descriptor(
      McpToolName.APPEND_TO_NOTE,
      '向已授权笔记追加正文（"\n\n" 连接，revision+1）；支持预期版本冲突检测与应用级幂等键重放。',
      {
        note_id: { ...str, description: '笔记 ID（必填）' },
        content: { ...str, description: '追加内容（必填）' },
        expected_revision: { type: 'number', description: '预期当前版本；不符返回冲突结果' },
        idempotency_key: { ...str, description: '应用级幂等键；同键重放直接返回首次结果，不重复追加' },
      },
      ['note_id', 'content'],
    ),
    descriptor(
      McpToolName.DELETE_NOTE,
      '软删除已授权笔记（可恢复口径）；支持预期版本冲突检测。',
      {
        note_id: { ...str, description: '笔记 ID（必填）' },
        expected_revision: { type: 'number', description: '预期当前版本；不符返回冲突结果' },
      },
      ['note_id'],
    ),
    descriptor(
      McpToolName.LIST_TAGS,
      '列出该客户端可见的标签（与授权集合求交；空授权集合返回空列表）。',
      {},
      [],
    ),
  ];
}

const TOOL_CATALOG: ToolDescriptor[] = buildToolCatalog();

const ALL_TOOL_NAMES: McpToolName[] = [
  McpToolName.SEARCH_NOTES,
  McpToolName.GET_NOTE,
  McpToolName.CREATE_NOTE,
  McpToolName.APPEND_TO_NOTE,
  McpToolName.DELETE_NOTE,
  McpToolName.LIST_TAGS,
];

function toToolName(name: string): McpToolName | undefined {
  for (let i: number = 0; i < ALL_TOOL_NAMES.length; i++) {
    if (ALL_TOOL_NAMES[i] === name) {
      return ALL_TOOL_NAMES[i];
    }
  }
  return undefined;
}

function isGranted(clientId: string, gate: PolicyGate, name: string): boolean {
  const tool: McpToolName | undefined = toToolName(name);
  return tool !== undefined && gate.authorize(clientId, tool).allowed;
}

// ---------------------------------------------------------------------------
// UTF-8 字节长度（core 禁 Node 内建；逐码点计数，与 TextEncoder 等价）
// ---------------------------------------------------------------------------

export function utf8ByteLength(text: string): number {
  let bytes: number = 0;
  for (let i: number = 0; i < text.length; i++) {
    const code: number = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next: number = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// 参数读取（校验失败统一 -32602 InvalidParams）
// ---------------------------------------------------------------------------

function invalidParams(message: string): JsonRpcMethodError {
  return new JsonRpcMethodError(JSONRPC_INVALID_PARAMS, message);
}

function requireString(args: Record<string, unknown>, name: string): string {
  const v: unknown = args[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw invalidParams(`parameter '${name}' must be a non-empty string`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const v: unknown = args[name];
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== 'string') {
    throw invalidParams(`parameter '${name}' must be a string`);
  }
  return v;
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const v: unknown = args[name];
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw invalidParams(`parameter '${name}' must be a number`);
  }
  return v;
}

function optionalStringArray(args: Record<string, unknown>, name: string): string[] | undefined {
  const v: unknown = args[name];
  if (v === undefined) {
    return undefined;
  }
  if (!Array.isArray(v)) {
    throw invalidParams(`parameter '${name}' must be an array of strings`);
  }
  const out: string[] = [];
  for (let i: number = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string') {
      throw invalidParams(`parameter '${name}' must be an array of strings`);
    }
    out.push(v[i] as string);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 协议适配器
// ---------------------------------------------------------------------------

interface IdempotencyEntry {
  readonly expiresAtMs: number;
  readonly result: unknown;
  readonly objectIds: string[];
}

export class ClipNoteMcpDispatcher implements McpDispatcher {
  private readonly rateBuckets: Map<string, number[]> = new Map();
  private readonly idempotency: Map<string, IdempotencyEntry> = new Map();
  private readonly rateLimit: DispatcherRateLimit;

  constructor(
    private readonly gate: PolicyGate,
    private readonly store: NoteStoreLike,
    private readonly clock: ClockLike,
    rateLimit?: DispatcherRateLimit,
  ) {
    this.rateLimit = rateLimit ?? DEFAULT_RATE_LIMIT;
  }

  /** 版本协商：无论客户端声明什么版本，一律回退到我方锁定版本（锁定决议）。 */
  async initialize(
    clientProtocolVersion: string | undefined,
    params: Record<string, unknown> | undefined,
    client: AuthenticatedClient,
  ): Promise<{ protocolVersion: string; result: unknown }> {
    void clientProtocolVersion;
    void params;
    void client;
    return {
      protocolVersion: LOCKED_PROTOCOL_VERSION,
      result: {
        protocolVersion: LOCKED_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }

  async dispatch(
    session: McpSession,
    method: string,
    params: Record<string, unknown> | undefined,
    client: AuthenticatedClient,
  ): Promise<unknown> {
    void session;
    if (method === 'ping') {
      return {};
    }
    if (method === 'tools/list') {
      return this.listTools(client.clientId);
    }
    if (method === 'tools/call') {
      return this.callTool(params, client.clientId);
    }
    throw new JsonRpcMethodError(-32601, `method not found: ${method}`);
  }

  /** 按该 clientId 的 grant 过滤可见工具（纯判定，无 grant 返回空数组）。 */
  private listTools(clientId: string): { tools: ToolDescriptor[] } {
    const tools: ToolDescriptor[] = [];
    for (let i: number = 0; i < TOOL_CATALOG.length; i++) {
      const desc: ToolDescriptor = TOOL_CATALOG[i];
      if (isGranted(clientId, this.gate, desc.name)) {
        tools.push(desc);
      }
    }
    return { tools };
  }

  private async callTool(params: Record<string, unknown> | undefined, clientId: string): Promise<unknown> {
    if (params === undefined) {
      throw invalidParams('tools/call requires params');
    }
    const name: string = requireString(params, 'name');
    const tool: McpToolName | undefined = toToolName(name);
    if (tool === undefined) {
      throw new JsonRpcMethodError(-32601, `unknown tool: ${name}`);
    }
    const args: Record<string, unknown> = asRecord(params['arguments']) ?? {};
    if (!this.allowRate(clientId)) {
      throw new JsonRpcMethodError(RATE_LIMIT_EXCEEDED, 'rate limit exceeded');
    }
    const payloadBytes: number = utf8ByteLength(JSON.stringify(args));
    try {
      const result: unknown = await this.gate.execute(clientId, tool, payloadBytes, (auth: ToolAuthorization) =>
        this.invoke(clientId, tool, auth, args),
      );
      // 工具语义错误（isError 信封）原样返回；成功结果包成 MCP content 负载
      if (typeof result === 'object' && result !== null && (result as Record<string, unknown>)['isError'] === true) {
        return result;
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        // 授权拒绝映射为 -32002；不得吞掉重写为成功
        throw new JsonRpcMethodError(RATE_LIMIT_EXCEEDED, err.message);
      }
      throw err;
    }
  }

  /** 工具语义分发：经 PolicyGate.execute 的 fn 进入，返回 ToolInvocation（结果 + 触及对象）。 */
  private async invoke(
    clientId: string,
    tool: McpToolName,
    auth: ToolAuthorization,
    args: Record<string, unknown>,
  ): Promise<ToolInvocation<unknown>> {
    switch (tool) {
      case McpToolName.SEARCH_NOTES:
        return this.searchNotes(auth, args);
      case McpToolName.GET_NOTE:
        return this.getNote(auth, args);
      case McpToolName.CREATE_NOTE:
        return this.createNote(auth, args);
      case McpToolName.APPEND_TO_NOTE:
        return this.appendToNote(clientId, auth, args);
      case McpToolName.DELETE_NOTE:
        return this.deleteNote(auth, args);
      case McpToolName.LIST_TAGS:
        return this.listTags(auth);
      default:
        throw new JsonRpcMethodError(-32601, 'unreachable');
    }
  }

  // -------------------------------------------------------------------------
  // 工具实现（§4.5.5 表）
  // -------------------------------------------------------------------------

  private async searchNotes(auth: ToolAuthorization, args: Record<string, unknown>): Promise<ToolInvocation<unknown>> {
    const query: string = requireString(args, 'query');
    const requested: number | undefined = optionalNumber(args, 'limit');
    const limit: number = clampMaxResults(auth, requested);
    const rows: NoteSearchRow[] = await this.store.search(query, limit);
    const results: Array<{ id: string; title: string; snippet: string }> = [];
    const objectIds: string[] = [];
    for (let i: number = 0; i < rows.length && results.length < limit; i++) {
      const row: NoteSearchRow = rows[i];
      // 越权候选需要范围信息：逐条取详情做 isObjectInScope（静默剔除，不泄露存在性）
      const detail: NoteDetail | undefined = await this.store.getById(row.id);
      if (detail === undefined || !isObjectInScope(auth, scopeObjectOf(detail))) {
        continue;
      }
      results.push({ id: row.id, title: row.title, snippet: clampSnippet(auth, row.snippetText) });
      objectIds.push(row.id);
    }
    return { result: { results }, objectIds };
  }

  private async getNote(auth: ToolAuthorization, args: Record<string, unknown>): Promise<ToolInvocation<unknown>> {
    const noteId: string = requireString(args, 'note_id');
    const detail: NoteDetail | undefined = await this.store.getById(noteId);
    if (detail === undefined || !isObjectInScope(auth, scopeObjectOf(detail))) {
      // not found 口径：不泄露存在性
      return toolError({ error: 'note not found or not accessible' });
    }
    return {
      result: { id: detail.id, title: detail.title, content: detail.content, revision: detail.revision },
      objectIds: [detail.id],
    };
  }

  private async createNote(auth: ToolAuthorization, args: Record<string, unknown>): Promise<ToolInvocation<unknown>> {
    const content: string = requireString(args, 'content');
    if (utf8ByteLength(content) > MAX_NOTE_CONTENT_BYTES) {
      throw invalidParams(`content exceeds ${MAX_NOTE_CONTENT_BYTES} bytes (UTF-8)`);
    }
    const titleArg: string | undefined = optionalString(args, 'title');
    const collectionIds: string[] | undefined = optionalStringArray(args, 'collection_ids');
    if (collectionIds !== undefined) {
      for (let i: number = 0; i < collectionIds.length; i++) {
        if (!contains(auth.scope.collectionIds, collectionIds[i])) {
          // 集合越权：以 AccessDeniedError 经闸门审计上抛，映射 -32002
          throw new AccessDeniedError({
            tool: McpToolName.CREATE_NOTE,
            allowed: false,
            scope: auth.scope,
            denyReason: `collection not granted: ${collectionIds[i]}`,
          });
        }
      }
    }
    const title: string = titleArg === undefined ? deriveTitle(content) : titleArg;
    const created: NoteCreateResult = await this.store.create({ title, content });
    return { result: { id: created.id, title: created.title, revision: created.revision }, objectIds: [created.id] };
  }

  private async appendToNote(clientId: string, auth: ToolAuthorization, args: Record<string, unknown>): Promise<ToolInvocation<unknown>> {
    const noteId: string = requireString(args, 'note_id');
    const content: string = requireString(args, 'content');
    const expectedRevision: number | undefined = optionalNumber(args, 'expected_revision');
    const idempotencyKey: string | undefined = optionalString(args, 'idempotency_key');

    // 应用级幂等：同键重放直接返回首次结果（不重复追加）；在闸门 fn 内检查，
    // 重放同样经 PolicyGate 现场授权（撤销后立即失效），审计按重放计 ok。
    if (idempotencyKey !== undefined) {
      const replay: IdempotencyEntry | undefined = this.lookupIdempotency(clientId, idempotencyKey);
      if (replay !== undefined) {
        return { result: replay.result, objectIds: replay.objectIds };
      }
    }

    const detail: NoteDetail | undefined = await this.store.getById(noteId);
    if (detail === undefined || !isObjectInScope(auth, scopeObjectOf(detail))) {
      return toolError({ error: 'note not found or not accessible' });
    }
    if (expectedRevision !== undefined && expectedRevision !== detail.revision) {
      return toolError({ conflict: true, current_revision: detail.revision });
    }
    const appended: NoteAppendResult = await this.store.append(noteId, `${detail.content}\n\n${content}`);
    const result: unknown = { id: appended.id, revision: appended.revision };
    if (idempotencyKey !== undefined) {
      this.rememberIdempotency(clientId, idempotencyKey, result, [appended.id]);
    }
    return { result, objectIds: [appended.id] };
  }

  private async deleteNote(auth: ToolAuthorization, args: Record<string, unknown>): Promise<ToolInvocation<unknown>> {
    const noteId: string = requireString(args, 'note_id');
    const expectedRevision: number | undefined = optionalNumber(args, 'expected_revision');
    const detail: NoteDetail | undefined = await this.store.getById(noteId);
    if (detail === undefined || !isObjectInScope(auth, scopeObjectOf(detail))) {
      return toolError({ error: 'note not found or not accessible' });
    }
    if (expectedRevision !== undefined && expectedRevision !== detail.revision) {
      return toolError({ conflict: true, current_revision: detail.revision });
    }
    await this.store.remove(noteId);
    return { result: { id: noteId, deleted: true }, objectIds: [noteId] };
  }

  private async listTags(auth: ToolAuthorization): Promise<ToolInvocation<unknown>> {
    const rows: NoteTagRow[] = await this.store.listTags();
    const tags: NoteTagRow[] = [];
    const objectIds: string[] = [];
    for (let i: number = 0; i < rows.length; i++) {
      // 可见标签 = 与授权集合求交；空 scope ⇒ 空列表（冻结语义）
      if (contains(auth.scope.collectionIds, rows[i].id)) {
        tags.push({ id: rows[i].id, name: rows[i].name });
        objectIds.push(rows[i].id);
      }
    }
    return { result: { tags }, objectIds };
  }

  // -------------------------------------------------------------------------
  // 限流与幂等注册表
  // -------------------------------------------------------------------------

  /** 每 clientId 滑动窗；超限返回 false（调用方抛 -32002）。 */
  private allowRate(clientId: string): boolean {
    const now: number = this.clock.nowMs();
    let bucket: number[] | undefined = this.rateBuckets.get(clientId);
    if (bucket === undefined) {
      bucket = [];
      this.rateBuckets.set(clientId, bucket);
    }
    while (bucket.length > 0 && now - bucket[0] > this.rateLimit.windowMs) {
      bucket.shift();
    }
    if (bucket.length >= this.rateLimit.maxCalls) {
      return false;
    }
    bucket.push(now);
    return true;
  }

  private idempotencyKeyOf(clientId: string, key: string): string {
    return `${clientId}|${key}`;
  }

  private lookupIdempotency(clientId: string, key: string): IdempotencyEntry | undefined {
    // 惰性清扫过期项（ClockLike 驱动；注册表为内存态，前台周期边界自然清零）
    const now: number = this.clock.nowMs();
    for (const entry of [...this.idempotency]) {
      if (now > entry[1].expiresAtMs) {
        this.idempotency.delete(entry[0]);
      }
    }
    return this.idempotency.get(this.idempotencyKeyOf(clientId, key));
  }

  private rememberIdempotency(clientId: string, key: string, result: unknown, objectIds: string[]): void {
    this.idempotency.set(this.idempotencyKeyOf(clientId, key), {
      expiresAtMs: this.clock.nowMs() + IDEMPOTENCY_TTL_MS,
      result,
      objectIds,
    });
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function scopeObjectOf(note: NoteDetail): ScopeObject {
  return {
    id: note.id,
    collectionIds: note.tagIds,
    inInbox: false,
    inTrash: note.deletedAtMs !== undefined,
  };
}

function contains(list: readonly string[], v: string): boolean {
  for (let i: number = 0; i < list.length; i++) {
    if (list[i] === v) {
      return true;
    }
  }
  return false;
}

/** 标题缺省取正文首行（截断到 100 字符） */
function deriveTitle(content: string): string {
  const line: string = content.split('\n', 1)[0].trim();
  return line.length > 100 ? line.slice(0, 100) : line;
}

/**
 * 工具语义错误 → tools/call 的 isError 结果（消息经 JSON 序列化进 content，
 * 不泄露对象存在性；与 JSON-RPC 传输错误区分）。
 */
function toolError(payload: Record<string, unknown>): ToolInvocation<unknown> {
  return {
    result: {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    },
    objectIds: [],
  };
}
