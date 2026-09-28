/**
 * 鸿蒙 TLS 服务端适配器：socket.TLSSocketServer（API 12+，系统 mbedTLS 栈）
 * → transport-ports.ts 的 IServerSocket/IConnection。
 *
 * 分层纪律：本目录是唯一允许 import @kit.* 的层（与 common/adapters 同规则）。
 *
 * ⚠ 真机验证项（design/mcp-传输选型.md R-A）：本文件未经 DevEco 编译与真机
 * 联调，API 形状按 OpenHarmony socket 文档（API 12）书写；G3 联调第一步即在
 * 真机跑通 监听 → Cherry Studio 连接 → 指纹核对。
 */

import { socket } from '@kit.NetworkKit';

import {
  ICertificateAuthority,
  IConnection,
  IServerSocket,
  ServerTlsMaterial,
} from '../core/transport-ports';

const FAMILY_IPV4: number = 1;

/** TCPSocketConnection / TLSSocketConnection 的最小公共面（两者事件/发送形态一致）。 */
interface SocketConnLike {
  on(type: string, callback: (data: unknown) => void): void;
  send(data: { data: ArrayBuffer }): Promise<void>;
  close(): Promise<void>;
}

/**
 * TLS 服务端 socket。start() 时从注入的证书权威加载当前材料 —
 * 与 McpServer 必须注入同一 ICertificateAuthority 实例（轮换即两边同步）。
 */
export class HarmonyTlsServerSocket implements IServerSocket {
  private server: socket.TLSSocketServer | undefined;
  private connCb: ((conn: IConnection) => void) | undefined;
  private port: number = 0;

  constructor(private readonly authority: ICertificateAuthority) {}

  async start(address: string, port: number): Promise<void> {
    const material: ServerTlsMaterial = await this.authority.current();
    const server: socket.TLSSocketServer = socket.constructTLSSocketServer();
    // 私钥/证书明文只存在于应用沙箱文件与本进程内存，不出设备（设计 §4.5.3）
    await server.listen({
      address: address,
      port: port,
      family: FAMILY_IPV4,
      secureOptions: {
        key: material.keyPem,
        cert: material.certPem,
        protocols: [socket.Protocol.TLSv12, socket.Protocol.TLSv13],
      },
    } as socket.TLSServerListenOptions);
    server.on('connect', (client: socket.TLSSocketConnection) => {
      const conn: IConnection = new SocketConnectionAdapter(client);
      if (this.connCb !== undefined) {
        this.connCb(conn);
      }
    });
    this.server = server;
    // TLSSocketServer 不回填实际端口；0（自动分配）场景由调用方避免（UI 展示需确定端口）
    this.port = port;
  }

  async stop(): Promise<void> {
    const server: socket.TLSSocketServer | undefined = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await server.close();
    }
  }

  onConnection(cb: (conn: IConnection) => void): void {
    this.connCb = cb;
  }

  boundPort(): number {
    return this.port;
  }
}

/** TCP 明文兜底调试 socket —— 生产装配不使用（设计：绝不静默退回明文 HTTP）。 */
export class HarmonyTcpServerSocket implements IServerSocket {
  private server: socket.TCPSocketServer | undefined;
  private connCb: ((conn: IConnection) => void) | undefined;
  private port: number = 0;

  async start(address: string, port: number): Promise<void> {
    const server: socket.TCPSocketServer = socket.constructTCPSocketServer();
    await server.listen({ address: address, port: port, family: FAMILY_IPV4 });
    server.on('connect', (client: socket.TCPSocketConnection) => {
      const conn: IConnection = new SocketConnectionAdapter(client);
      if (this.connCb !== undefined) {
        this.connCb(conn);
      }
    });
    this.server = server;
    this.port = port;
  }

  async stop(): Promise<void> {
    const server: socket.TCPSocketServer | undefined = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await server.close();
    }
  }

  onConnection(cb: (conn: IConnection) => void): void {
    this.connCb = cb;
  }

  boundPort(): number {
    return this.port;
  }
}

class SocketConnectionAdapter implements IConnection {
  constructor(
    private readonly conn: SocketConnLike,
    readonly remoteAddress: string = '',
  ) {
    // HarmonyOS socket 连接对象的 remoteAddress 在 connect 回调参数中携带；
    // 审计展示允许为空（限速键退化为连接级）。真机联调时从 client.remoteInfo 补充。
  }

  write(data: Uint8Array): Promise<void> {
    // ArrayBuffer 视图底层共享：TLSSocketServer.send 同步拷贝发送
    return this.conn.send({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
  }

  async close(): Promise<void> {
    await this.conn.close();
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.conn.on('data', (event: unknown) => {
      const message: ArrayBuffer = (event as { message: ArrayBuffer }).message;
      cb(new Uint8Array(message));
    });
  }

  onClose(cb: () => void): void {
    this.conn.on('close', () => {
      cb();
    });
  }

  onError(cb: (err: Error) => void): void {
    this.conn.on('error', (event: unknown) => {
      cb(new Error(String(event)));
    });
  }
}
