/**
 * MCP 审计仓储（设计 §4.5.5：审计记客户端、操作、对象 ID、结果与时间，**不记完整正文**）。
 *
 * 本仓储是审计的唯一落库通道（schema v2 `mcp_audit` 表）：
 *  - 只接收元数据字段；接口上根本不存在"正文/令牌"参数 —— 泄露面靠类型收窄，
 *    而不是靠调用方自觉；
 *  - `tool` 以字符串存储（取值集合由 mcp HAR 的 McpToolName 约束），
 *    避免 common 反向依赖 mcp（分层：mcp → common，单向）；
 *  - 审计只增不改：不提供 update/delete，审计页之外的清理策略（如保留期）
 *    若引入须另立迁移与评审。
 */

import { IRdbExecutor, SqlRow, reqNumber, reqString } from './rdb';

export type McpAuditResult = 'ok' | 'denied' | 'error';

/** 一条已落库的审计记录（id 为库内自增序号，单调递增即时间序） */
export interface McpAuditEntry {
  readonly id: number;
  readonly clientId: string;
  readonly tool: string;
  readonly objectIds: string[];
  readonly result: McpAuditResult;
  readonly atMs: number;
  readonly payloadBytes: number;
}

/** 审计查询过滤条件；全部可选，缺省即不按该维度过滤 */
export interface McpAuditQuery {
  readonly clientId?: string;
  readonly tool?: string;
  readonly result?: McpAuditResult;
  /** 只返回 at_ms >= sinceMs 的记录 */
  readonly sinceMs?: number;
  /** 结果上限（缺省 DEFAULT_QUERY_LIMIT；硬上限 MAX_QUERY_LIMIT） */
  readonly limit?: number;
}

export const DEFAULT_QUERY_LIMIT: number = 100;
export const MAX_QUERY_LIMIT: number = 1000;

export class McpAuditRepository {
  constructor(private readonly db: IRdbExecutor) {}

  /** 追加一条审计记录；objectIds 序列化为 JSON 数组文本（仅 ID，无正文） */
  async append(
    clientId: string,
    tool: string,
    objectIds: readonly string[],
    result: McpAuditResult,
    atMs: number,
    payloadBytes: number,
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO mcp_audit (client_id, tool, object_ids, result, at_ms, payload_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [clientId, tool, JSON.stringify(objectIds), result, atMs, payloadBytes],
    );
  }

  /** 条件查询，按时间倒序（最新在前）；limit 收敛到 [1, MAX_QUERY_LIMIT] */
  async query(filter: McpAuditQuery): Promise<McpAuditEntry[]> {
    let sql: string =
      `SELECT id, client_id, tool, object_ids, result, at_ms, payload_bytes FROM mcp_audit`;
    const params: (string | number | null)[] = [];
    const where: string[] = [];
    if (filter.clientId !== undefined) {
      where.push('client_id = ?');
      params.push(filter.clientId);
    }
    if (filter.tool !== undefined) {
      where.push('tool = ?');
      params.push(filter.tool);
    }
    if (filter.result !== undefined) {
      where.push('result = ?');
      params.push(filter.result);
    }
    if (filter.sinceMs !== undefined) {
      where.push('at_ms >= ?');
      params.push(filter.sinceMs);
    }
    if (where.length > 0) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }
    sql += ` ORDER BY at_ms DESC, id DESC LIMIT ?`;
    params.push(clampLimit(filter.limit));
    const rows: SqlRow[] = await this.db.query(sql, params);
    const out: McpAuditEntry[] = [];
    for (let i: number = 0; i < rows.length; i++) {
      out.push(rowToEntry(rows[i]));
    }
    return out;
  }

  async count(filter: McpAuditQuery): Promise<number> {
    let sql: string = `SELECT COUNT(*) AS n FROM mcp_audit`;
    const params: (string | number | null)[] = [];
    const where: string[] = [];
    if (filter.clientId !== undefined) {
      where.push('client_id = ?');
      params.push(filter.clientId);
    }
    if (filter.tool !== undefined) {
      where.push('tool = ?');
      params.push(filter.tool);
    }
    if (filter.result !== undefined) {
      where.push('result = ?');
      params.push(filter.result);
    }
    if (filter.sinceMs !== undefined) {
      where.push('at_ms >= ?');
      params.push(filter.sinceMs);
    }
    if (where.length > 0) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }
    const rows: SqlRow[] = await this.db.query(sql, params);
    return reqNumber(rows[0], 'n');
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit <= 0) {
    return DEFAULT_QUERY_LIMIT;
  }
  return limit > MAX_QUERY_LIMIT ? MAX_QUERY_LIMIT : Math.floor(limit);
}

function rowToEntry(row: SqlRow): McpAuditEntry {
  const objectIdsRaw: string = reqString(row, 'object_ids');
  let objectIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(objectIdsRaw);
    if (Array.isArray(parsed)) {
      for (let i: number = 0; i < parsed.length; i++) {
        if (typeof parsed[i] === 'string') {
          objectIds.push(parsed[i] as string);
        }
      }
    }
  } catch {
    // 脏数据不阻断查询页：对象列表降级为空，其余字段照常展示
  }
  const result: string = reqString(row, 'result');
  if (result !== 'ok' && result !== 'denied' && result !== 'error') {
    throw new Error(`mcp_audit: unknown result "${result}" (schema 与代码失配)`);
  }
  const entry: McpAuditEntry = {
    id: reqNumber(row, 'id'),
    clientId: reqString(row, 'client_id'),
    tool: reqString(row, 'tool'),
    objectIds,
    result,
    atMs: reqNumber(row, 'at_ms'),
    payloadBytes: reqNumber(row, 'payload_bytes'),
  };
  return entry;
}
