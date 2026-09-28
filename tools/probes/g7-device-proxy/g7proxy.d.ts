// g7proxy.node（N-API 插件）的类型声明：以 node:sqlite DatabaseSync 兼容子集暴露。
declare module '*.node' {
  export class StatementSync {
    run(...params: unknown[]): { changes: number };
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
  }
  export class DatabaseSync {
    constructor(path?: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
