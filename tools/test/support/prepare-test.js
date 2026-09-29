/**
 * npm test 前置：把 node 运行期 'common' / 'mcp' 垫片软链进 tools/node_modules。
 *
 * 背景：speech core（planner.ts）与 entry MCP 装配层（McpNoteStoreAdapter 的
 * NoteSource 值导入、McpServiceCore 的 mcp core 组件装配）对 'common'/'mcp'
 * 是**值导入**，tsc 编译产物里保留 require('common') / require('mcp')；
 * tsconfig paths 只管编译期，node 运行期需要真实的 node_modules/common 与
 * node_modules/mcp。
 * npm ci 会清空 node_modules，所以每次 test 前重建（幂等）。
 */

const fs = require('fs');
const path = require('path');

const nmDir = path.join(__dirname, '..', '..', 'node_modules');

function linkPackage(name, targetName) {
  const link = path.join(nmDir, name);
  const target = path.join(__dirname, targetName);
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link, 'dir');
}

fs.mkdirSync(nmDir, { recursive: true });
linkPackage('common', 'common-proxy');
linkPackage('mcp', 'mcp-proxy');
