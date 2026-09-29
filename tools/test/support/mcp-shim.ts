/**
 * node 构建的 'mcp' 裸导入垫片（tools/tsconfig.json paths 映射目标）。
 *
 * hvigor 构建里 'mcp' 解析到 mcp HAR 的 Index.ets；但 Index.ets 还导出
 * adapters/（含 @kit.*，node 编译不过）。mcp core 本身零平台依赖，
 * 本垫片按 common-shim 同一手法重导出 core 全量符号
 * （entry 装配层 McpNoteStoreAdapter / McpServiceCore 经裸导入 'mcp' 取用，
 * 与本机测试的相对导入指向同一批源文件，模块身份一致）。
 * 与 tools/test/support/mcp-proxy/index.js（运行期镜像）保持同源。
 */

export * from '../../../mcp/src/main/ets/core/transport-ports';
export * from '../../../mcp/src/main/ets/core/http11';
export * from '../../../mcp/src/main/ets/core/jsonrpc';
export * from '../../../mcp/src/main/ets/core/session';
export * from '../../../mcp/src/main/ets/core/credentials';
export * from '../../../mcp/src/main/ets/core/pairing';
export * from '../../../mcp/src/main/ets/core/x509-selfsign';
export * from '../../../mcp/src/main/ets/core/access-policy';
export * from '../../../mcp/src/main/ets/core/endpoint';
export * from '../../../mcp/src/main/ets/core/dispatcher';
export * from '../../../mcp/src/main/ets/core/server';
