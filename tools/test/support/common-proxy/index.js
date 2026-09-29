/**
 * node 运行期 'common' 垫片（tsc 编译产物的重导出）。
 *
 * tools/tsconfig.json 的 paths 只解决**编译期**裸导入 'common'；本文件解决
 * **运行期** require('common')（tsc 对值导入不会在产物里改写路径）。
 * 与 tools/test/support/common-shim.ts（编译期镜像）保持同源：
 * 只重导出 node 可运行的 common core 子集，避开含 @kit.* 的 adapters/。
 *
 * 由 tools/test/support/prepare-test.js 在 npm test 前软链到
 * tools/node_modules/common（npm ci 会清掉 node_modules，故每次测试前重建）。
 */

module.exports = {
  ...require('../../../dist/common/src/main/ets/core/speech.js'),
  ...require('../../../dist/common/src/main/ets/core/model.js'),
  // S6-7 entry MCP 装配层（McpNoteStoreAdapter 的 NoteService/NoteRepository/NoteSource）
  ...require('../../../dist/common/src/main/ets/core/notes.js'),
  ...require('../../../dist/common/src/main/ets/core/data/note-repository.js'),
  // WHY-131 条件 A：entry 备份/恢复入口编排内核（BackupEntryCore）
  ...require('../../../dist/common/src/main/ets/core/backup-service.js'),
  // LogLevel 等枚举的运行期取值（entry 装配内核 logger 调用用）
  ...require('../../../dist/common/src/main/ets/core/ports.js'),
};
