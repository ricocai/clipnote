/**
 * npm test 前置：把 node 运行期 'common' / 'mcp' 垫片挂进 tools/node_modules。
 *
 * 背景：speech core（planner.ts）与 entry MCP 装配层（McpNoteStoreAdapter /
 * McpServiceCore）以两种形态引用内核包：
 *  1. 裸导入 require('common') / require('mcp') —— 由垫片 index.js 解析
 *     （只重导出 node 可运行的 core 子集，避开含 @kit.* 的 adapters/）；
 *  2. 包子路径深导入 require('common/src/main/ets/core/...') —— hvigor 侧
 *     按 ohpm 包子路径解析（.ts 文件禁止 import .ets 入口，故双编译源码用
 *     深导入直取 .ts 内核文件）；node 侧由 src 软链解析到 dist 产物树，
 *     与本机测试的相对导入（../../common/src/...）落在同一批 dist 文件，
 *     模块身份一致。
 * tsconfig paths/baseUrl 只管编译期，运行期需要真实的 node_modules 布局；
 * npm ci 会清空 node_modules，所以每次 test 前重建（幂等）。
 */

const fs = require('fs');
const path = require('path');

const nmDir = path.join(__dirname, '..', '..', 'node_modules');
const toolsRoot = path.join(__dirname, '..', '..');

function linkPackage(name, proxyDirName) {
  const link = path.join(nmDir, name);
  fs.rmSync(link, { recursive: true, force: true });
  // 真实目录（不能用整包软链，否则 src 软链会写穿到仓库里的垫片目录）：
  //   index.js → 垫片（裸导入出口）
  //   src/     → dist/<name>/src（包子路径深导入出口）
  fs.mkdirSync(link, { recursive: true });
  fs.symlinkSync(path.join(__dirname, proxyDirName, 'index.js'), path.join(link, 'index.js'));
  fs.symlinkSync(path.join(toolsRoot, 'dist', name, 'src'), path.join(link, 'src'), 'dir');
}

fs.mkdirSync(nmDir, { recursive: true });
linkPackage('common', 'common-proxy');
linkPackage('mcp', 'mcp-proxy');
