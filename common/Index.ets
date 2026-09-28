/**
 * common（HAR）对外统一出口。
 *
 * 分层纪律（评审基线，勿破坏）：
 *  - `./src/main/ets/core/*`    领域内核：**零平台依赖**，必须能用本机 `tsc + node --test` 全量跑通
 *                               （`tools/` 目录，95 个用例）。任何 import @kit.* 都会破坏这一保证。
 *  - `./src/main/ets/adapters/*` 鸿蒙适配：`@kit.*` 只允许出现在这里，且只实现 core/ports.ts 的接口。
 *  - UI 只依赖本文件导出的符号，不直接触碰 adapters 之外的平台 API。
 */

export * from './src/main/ets/core/model';
export * from './src/main/ets/core/ports';
export * from './src/main/ets/core/bytes';
export * from './src/main/ets/core/id';
export * from './src/main/ets/core/atomicfs';
export * from './src/main/ets/core/blob-cas';
export * from './src/main/ets/core/clip';
export * from './src/main/ets/core/markdown';
export * from './src/main/ets/core/speech';
export * from './src/main/ets/core/backup';
export * from './src/main/ets/core/search/tokenizer';
export * from './src/main/ets/core/search/inverted-index';

export * from './src/main/ets/core/data/rdb';
export * from './src/main/ets/core/data/schema';
export * from './src/main/ets/core/data/migrator';
export * from './src/main/ets/core/data/note-repository';
export * from './src/main/ets/core/data/inbox-repository';
export * from './src/main/ets/core/data/blob-repository';
export * from './src/main/ets/core/data/recovery';

export { SystemClock } from './src/main/ets/adapters/system-clock';
export { CryptoRandom } from './src/main/ets/adapters/random';
export { CryptoHasher } from './src/main/ets/adapters/crypto-hasher';
export { HilogLogger } from './src/main/ets/adapters/hilog-logger';
export { SandboxFileStore } from './src/main/ets/adapters/file-store';
export { AppContextHolder } from './src/main/ets/adapters/app-context';
export { RelationalStoreExecutor, DEFAULT_DB_NAME } from './src/main/ets/adapters/relational-store';
export { AppDataRuntime } from './src/main/ets/adapters/app-database';
