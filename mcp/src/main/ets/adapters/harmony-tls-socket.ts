/**
 * 鸿蒙 TLS 服务端适配器：socket.TLSSocketServer（API 12+，系统 mbedTLS 栈）
 * → transport-ports.ts 的 IServerSocket/IConnection。
 *
 * 分层纪律：本目录是唯一允许 import @kit.* 的层（与 common/adapters 同规则）。
 *
 * 真机/模拟器实测结论（2026-10，API 26 模拟器，design/mcp-传输选型.md R-A 收口）：
 *  - 数据事件名为 'message'（SocketMessageInfo { message, remoteInfo }），
 *    不是 Node 习惯的 'data'——订错名握手成功也收不到任何数据；
 *  - 'close'/'error' 事件名与 d.ts 一致，可用；
 *  - 连接对象无 remoteAddress 属性，对端地址随 message 事件 remoteInfo 到达；
 *  - send 的实参必须是"原生" ArrayBuffer：ArrayBuffer.prototype.slice 的产物
 *    通不过 netstack 原生类型检查（报 first param is not string or
 *    arraybuffer），write() 里显式 new ArrayBuffer + 拷贝，勿回退；
 *    且 TLS 连接 send 直接收 ArrayBuffer，TCP 连接收 TCPSendOptions 对象——
 *    两者形态不同，由构造时注入的 sendImpl 区分；
 *  - TLS 材料必须 RSA（EC 私钥 netstack 服务端不支持，见
 *    harmony-certificate-authority.ets 文件头实测记录）。
 */

import { socket } from '@kit.NetworkKit';

import {
  ICertificateAuthority,
  IConnection,
  IServerSocket,
  ServerTlsMaterial,
} from '../core/transport-ports';

const FAMILY_IPV4: number = 1;

/** TCPSocketConnection / TLSSocketConnection 的事件/关闭公共面（发送形态两者不同，见 write）。 */
interface SocketConnLike {
  on(type: string, callback: (data: unknown) => void): void;
  close(): Promise<void>;
}

/** 发送实参形态：TCP 为 TCPSendOptions 对象，TLS 直接收 string | ArrayBuffer（SDK d.ts 实测口径）。 */
type SocketSendImpl = (data: ArrayBuffer) => Promise<void>;

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
    const server: socket.TLSSocketServer = socket.constructTLSSocketServerInstance();
    // 私钥/证书明文只存在于应用沙箱文件与本进程内存，不出设备（设计 §4.5.3）
    // listen 实参以 SDK d.ts 为准：TLSConnectOptions = { address: NetAddress, secureOptions }
    await server.listen({
      address: { address: address, port: port, family: FAMILY_IPV4 },
      secureOptions: {
        key: material.keyPem,
        cert: material.certPem,
        protocols: [socket.Protocol.TLSv12, socket.Protocol.TLSv13],
      },
    });
    server.on('connect', (client: socket.TLSSocketConnection) => {
      // TLS 连接的 send 直接收 ArrayBuffer（与 TCP 的 TCPSendOptions 对象形态不同）
      const conn: IConnection = new SocketConnectionAdapter(client,
        (buf: ArrayBuffer): Promise<void> => client.send(buf));
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
      const conn: IConnection = new SocketConnectionAdapter(client,
        (buf: ArrayBuffer): Promise<void> => client.send({ data: buf }));
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
  private readonly conn: SocketConnLike;
  private readonly sendImpl: SocketSendImpl;
  /**
   * 对端地址：SDK 的连接对象不带 remoteAddress 属性，地址随每条 'message' 事件的
   *  remoteInfo 到达（SocketMessageInfo.remoteInfo.address），首条消息时填充；
   * 到达前为空串（审计/限速键按连接级退化，与 server.ts 既有容错一致）。
   */
  private remoteAddr: string = '';

  constructor(conn: SocketConnLike, sendImpl: SocketSendImpl) {
    this.conn = conn;
    this.sendImpl = sendImpl;
  }

  get remoteAddress(): string {
    return this.remoteAddr;
  }

  write(data: Uint8Array): Promise<void> {
    // 实测结论（API 26 模拟器）：netstack 对 send 参数做原生类型检查，
    // ArrayBuffer.prototype.slice 的产物通不过（"first param is not string or
    // arraybuffer"）。显式 new ArrayBuffer + Uint8Array 拷贝的形态才能过检。
    const buf: ArrayBuffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    return this.sendImpl(buf);
  }

  async close(): Promise<void> {
    await this.conn.close();
  }

  onData(cb: (data: Uint8Array) => void): void {
    // 数据事件名为 'message'（SDK d.ts 口径；'data' 不存在，订阅不到任何数据）
    this.conn.on('message', (event: unknown) => {
      const info: socket.SocketMessageInfo = event as socket.SocketMessageInfo;
      if (this.remoteAddr.length === 0 && info.remoteInfo.address.length > 0) {
        this.remoteAddr = info.remoteInfo.address;
      }
      cb(new Uint8Array(info.message));
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
