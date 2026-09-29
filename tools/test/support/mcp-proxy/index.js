/**
 * node 运行期 'mcp' 垫片（tsc 编译产物的重导出）。
 *
 * 与 tools/test/support/mcp-shim.ts（编译期镜像）保持同源：
 * mcp core 零平台依赖，整体重导出即可（adapters/ 含 @kit.*，不含在内）。
 * entry 装配层（McpNoteStoreAdapter / McpServiceCore）的编译产物保留
 * require('mcp')，由本文件在运行期解析到 dist 的 mcp core；
 * 与本机测试的相对导入（../../mcp/src/main/ets/core/...）解析到同一批
 * dist 文件，模块身份一致。
 *
 * 由 tools/test/support/prepare-test.js 在 npm test 前软链到
 * tools/node_modules/mcp（npm ci 会清掉 node_modules，故每次测试前重建）。
 */

module.exports = {
  ...require('../../../dist/mcp/src/main/ets/core/transport-ports.js'),
  ...require('../../../dist/mcp/src/main/ets/core/http11.js'),
  ...require('../../../dist/mcp/src/main/ets/core/jsonrpc.js'),
  ...require('../../../dist/mcp/src/main/ets/core/session.js'),
  ...require('../../../dist/mcp/src/main/ets/core/credentials.js'),
  ...require('../../../dist/mcp/src/main/ets/core/pairing.js'),
  ...require('../../../dist/mcp/src/main/ets/core/x509-selfsign.js'),
  ...require('../../../dist/mcp/src/main/ets/core/access-policy.js'),
  ...require('../../../dist/mcp/src/main/ets/core/endpoint.js'),
  ...require('../../../dist/mcp/src/main/ets/core/dispatcher.js'),
  ...require('../../../dist/mcp/src/main/ets/core/server.js'),
};
