/**
 * npm test 前置：把 node 运行期 'common' 垫片软链进 tools/node_modules。
 *
 * 背景：speech core（planner.ts）对 'common' 是**值导入**（normalizeForSpeech /
 * splitForSpeech / BlockType），tsc 编译产物里保留 require('common')；
 * tsconfig paths 只管编译期，node 运行期需要真实的 node_modules/common。
 * npm ci 会清空 node_modules，所以每次 test 前重建（幂等）。
 */

const fs = require('fs');
const path = require('path');

const nmDir = path.join(__dirname, '..', '..', 'node_modules');
const link = path.join(nmDir, 'common');
const target = path.join(__dirname, 'common-proxy');

fs.mkdirSync(nmDir, { recursive: true });
fs.rmSync(link, { recursive: true, force: true });
fs.symlinkSync(target, link, 'dir');
