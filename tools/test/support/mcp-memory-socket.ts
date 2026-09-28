/**
 * 本机测试用 MCP 传输端口实现（内存双工连接对）。
 *
 * 不是交付物：真实实现位于 `mcp/src/main/ets/adapters/`（鸿蒙 socket/TLS），
 * 两者必须满足 transport-ports.ts 的同一组接口契约。
 * 交付延迟为同步触发（onData 同步回调），配合 server 的串行队列即确定有序。
 */

import {
  IConnection,
  IServerSocket,
  ServerTlsMaterial,
} from '../../../mcp/src/main/ets/core/transport-ports';

export class MemoryConnection implements IConnection {
  private dataCbs: Array<(data: Uint8Array) => void> = [];
  private closeCbs: Array<() => void> = [];
  private errorCbs: Array<(err: Error) => void> = [];
  private closed: boolean = false;
  /** 对端连接：write 的数据同步送入对端 dataCbs */
  peer: MemoryConnection | undefined;

  constructor(readonly remoteAddress: string) {}

  write(data: Uint8Array): Promise<void> {
    if (this.closed || this.peer === undefined) {
      return Promise.resolve();
    }
    for (const cb of this.peer.dataCbs) {
      cb(data);
    }
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const cb of this.closeCbs) {
      cb();
    }
    if (this.peer !== undefined && !this.peer.closed) {
      await this.peer.close();
    }
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.dataCbs.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  onError(cb: (err: Error) => void): void {
    this.errorCbs.push(cb);
  }

  emitError(err: Error): void {
    for (const cb of this.errorCbs) {
      cb(err);
    }
  }
}

/**
 * 内存服务端：connect() 建立一对连接并触发 onConnection。
 * 持有 TLS 材料仅供断言（本机无真实 TLS；TLS 语义由鸿蒙适配器承担）。
 */
export class MemoryServerSocket implements IServerSocket {
  private connCb: ((conn: IConnection) => void) | undefined;
  private listening: boolean = false;
  private port: number = 0;
  readonly serverSide: MemoryConnection[] = [];

  constructor(readonly material: ServerTlsMaterial) {}

  async start(address: string, port: number): Promise<void> {
    this.listening = true;
    this.port = port === 0 ? 8765 : port;
  }

  async stop(): Promise<void> {
    this.listening = false;
  }

  onConnection(cb: (conn: IConnection) => void): void {
    this.connCb = cb;
  }

  boundPort(): number {
    return this.port;
  }

  /** 测试端：模拟一个客户端接入，返回客户端侧连接。 */
  connect(remoteAddress: string): MemoryConnection {
    if (!this.listening) {
      throw new Error('server socket not listening');
    }
    const client: MemoryConnection = new MemoryConnection('server');
    const server: MemoryConnection = new MemoryConnection(remoteAddress);
    client.peer = server;
    server.peer = client;
    this.serverSide.push(server);
    if (this.connCb !== undefined) {
      this.connCb(server);
    }
    return client;
  }
}

/** 固定 TLS 材料的证书权威假实现（轮换时 generation+1、指纹变化）。 */
export class FakeCertificateAuthority {
  private material: ServerTlsMaterial;

  constructor(private readonly hasher: (derLike: string) => string, startGeneration: number = 1) {
    this.material = makeMaterial(startGeneration, hasher);
  }

  async current(): Promise<ServerTlsMaterial> {
    return this.material;
  }

  async rotate(): Promise<ServerTlsMaterial> {
    this.material = makeMaterial(this.material.generation + 1, this.hasher);
    return this.material;
  }

  /** 同步查看当前材料（测试夹具组装用）。 */
  peek(): ServerTlsMaterial {
    return this.material;
  }
}

function makeMaterial(generation: number, hasher: (s: string) => string): ServerTlsMaterial {
  // 指纹随代际变化，模拟新证书
  return {
    keyPem: `-----BEGIN PRIVATE KEY-----\n(fake-${generation})\n-----END PRIVATE KEY-----`,
    certPem: `-----BEGIN CERTIFICATE-----\n(fake-${generation})\n-----END CERTIFICATE-----`,
    fingerprintSha256: hasher(`cert-der-${generation}`),
    generation,
  };
}
