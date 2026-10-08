/**
 * 鸿蒙证书权威适配器：cryptoFramework 生成 RSA 2048 密钥对 + 系统 Sign 自签，
 * 证书结构由 core/x509-selfsign.ts 纯 DER 编码（本机已验证）。
 * 私钥/证书持久化于应用沙箱（common IFileStore），PEM 形态供 TLSSocketServer 加载。
 *
 * 真机实测结论（2026-10，API 26 模拟器，design/mcp-传输选型.md R-A 收口）：
 *  - netstack TLS 服务端（tls_context_server.cpp SetKeyAndCheck）装私钥只有
 *    RSA/DSA 分支，**EC 私钥解析正常但装不进 SSL_CTX**，
 *    SSL_CTX_check_private_key 必失败（日志 "Check if the certificate matches
 *    the private key is error"），握手挂死——故从 ECC P-256 改 RSA 2048，勿回退；
 *  - RSA 私钥用 priKey.getEncodedPem('PKCS8') 直接产 PEM（API 12+ 支持 RSA，
 *    实测模拟器可用）；EC 时代 getEncoded()/getEncodedDer 的坑不再适用；
 *  - RSA 公钥成分经 pubKey.getAsyKeySpec(RSA_N_BN/RSA_PK_BN) 取 bigint
 *    （API 10+），不再走 EC 的"SPKI 尾部 65 字节"；
 *  - RSA 签名为 PKCS#1 v1.5 原始字节，直接入证书 BIT STRING，无形态转换。
 *
 * 失败必须显式抛错交 UI 提示，**绝不静默退回明文 HTTP**（设计 §4.5.3）。
 *
 * 持久化布局（filesDir 下）：
 *   mcp-tls/key.pem    PKCS#8 私钥（不出设备、不进日志）
 *   mcp-tls/cert.pem   自签证书
 *   mcp-tls/meta.json  { generation, fingerprintSha256 }
 * 加载时三件套缺一即报错（不猜测、不重建 —— 避免无感丢失已配对客户端）。
 */

import { cryptoFramework } from '@kit.CryptoArchitectureKit';

import { IClock, IFileStore, IRandom } from 'common';
import {
  ICertificateAuthority,
  ServerTlsMaterial,
} from '../core/transport-ports';
import {
  buildSelfSignedCertificate,
  derToPem,
  pemToDer,
  RsaPublicKeyNumbers,
  X509KeyAlgorithm,
  X509SignerPort,
} from '../core/x509-selfsign';

const CERT_VALIDITY_MS: number = 5 * 365 * 24 * 3600 * 1000;
const CN: string = 'clipnote-device';
const SAN_DNS: string[] = ['clipnote.local'];

interface TlsMeta {
  generation: number;
  fingerprintSha256: string;
}

export class HarmonyCertificateAuthority implements ICertificateAuthority {
  private cached: ServerTlsMaterial | undefined;

  private readonly fs: IFileStore;
  private readonly dir: string;
  private readonly random: IRandom;
  private readonly clock: IClock;

  constructor(fs: IFileStore, dir: string, random: IRandom, clock: IClock) {
    this.fs = fs;
    this.dir = dir;
    this.random = random;
    this.clock = clock;
  }

  async current(): Promise<ServerTlsMaterial> {
    if (this.cached !== undefined) {
      return this.cached;
    }
    const meta: TlsMeta | undefined = await this.readMeta();
    if (meta !== undefined) {
      const keyPem: string = await this.readRequired('key.pem');
      const certPem: string = await this.readRequired('cert.pem');
      // 指纹以当前证书 DER 重算为准（meta 仅记录代际）
      const fingerprint: string = await this.fingerprintOfPem(certPem);
      this.cached = {
        keyPem: keyPem,
        certPem: certPem,
        fingerprintSha256: fingerprint,
        generation: meta.generation,
      };
      return this.cached;
    }
    // 首次启用：生成并持久化 generation=1
    this.cached = await this.generateAndPersist(1);
    return this.cached;
  }

  async rotate(): Promise<ServerTlsMaterial> {
    const currentMeta: TlsMeta | undefined = await this.readMeta();
    const nextGeneration: number = (currentMeta?.generation ?? 0) + 1;
    this.cached = await this.generateAndPersist(nextGeneration);
    return this.cached;
  }

  // -------------------------------------------------------------------------

  private async generateAndPersist(generation: number): Promise<ServerTlsMaterial> {
    const signer: CryptoFrameworkSigner = new CryptoFrameworkSigner();
    const now: number = this.clock.nowMs();
    const certDer: Uint8Array = await buildSelfSignedCertificate({
      commonName: CN,
      serialNumber: this.random.nextBytes(16),
      notBefore: new Date(now - 3600 * 1000),
      notAfter: new Date(now + CERT_VALIDITY_MS),
      sanDnsNames: SAN_DNS,
      sanIps: [],
    }, signer);
    const fingerprint: string = await this.fingerprintOfDer(certDer);
    const material: ServerTlsMaterial = {
      keyPem: signer.privateKeyPem(),
      certPem: derToPem(certDer, 'CERTIFICATE'),
      fingerprintSha256: fingerprint,
      generation: generation,
    };
    await this.fs.mkdirp(this.dir);
    await this.fs.writeRaw(`${this.dir}/key.pem`, material.keyPem);
    await this.fs.writeRaw(`${this.dir}/cert.pem`, material.certPem);
    await this.fs.writeRaw(`${this.dir}/meta.json`, JSON.stringify({
      generation: generation,
      fingerprintSha256: fingerprint,
    }));
    return material;
  }

  private async readMeta(): Promise<TlsMeta | undefined> {
    try {
      const text: string = await this.fs.readText(`${this.dir}/meta.json`);
      const value = JSON.parse(text) as TlsMeta;
      if (typeof value.generation !== 'number' || typeof value.fingerprintSha256 !== 'string') {
        return undefined;
      }
      return { generation: value.generation, fingerprintSha256: value.fingerprintSha256 };
    } catch {
      return undefined;
    }
  }

  private async readRequired(name: string): Promise<string> {
    try {
      return await this.fs.readText(`${this.dir}/${name}`);
    } catch (err) {
      throw new Error(`mcp tls material incomplete (${name} unreadable): ${String(err)}`);
    }
  }

  private async fingerprintOfPem(certPem: string): Promise<string> {
    return this.fingerprintOfDer(pemToDer(certPem));
  }

  private async fingerprintOfDer(certDer: Uint8Array): Promise<string> {
    const md = cryptoFramework.createMd('SHA256');
    await md.update({ data: certDer });
    const digest = await md.digest();
    return hexLower(digest.data);
  }
}

/** cryptoFramework 实现的签名端口（对应本机测试的 node:crypto 版本）。 */
class CryptoFrameworkSigner implements X509SignerPort {
  private keyPair: cryptoFramework.KeyPair | undefined;
  private keyPem: string = '';

  /** 惰性生成密钥对（generateAndPersist 中先调用，再取 PEM）。 */
  private async ensureKeyPair(): Promise<cryptoFramework.KeyPair> {
    if (this.keyPair === undefined) {
      const gen: cryptoFramework.AsyKeyGenerator = cryptoFramework.createAsyKeyGenerator('RSA2048');
      this.keyPair = await gen.generateKeyPair();
      // RSA 私钥 PKCS#8 PEM：API 12+ 支持（d.ts 注明），直接产出 PEM 字符串
      this.keyPem = this.keyPair.priKey.getEncodedPem('PKCS8');
    }
    return this.keyPair;
  }

  keyAlgorithm(): X509KeyAlgorithm {
    return 'rsa-2048';
  }

  privateKeyPem(): string {
    if (this.keyPem.length === 0) {
      throw new Error('privateKeyPem called before key generation');
    }
    return this.keyPem;
  }

  async rsaPublicKeyNumbers(): Promise<RsaPublicKeyNumbers> {
    const keyPair: cryptoFramework.KeyPair = await this.ensureKeyPair();
    const n: bigint = keyPair.pubKey.getAsyKeySpec(cryptoFramework.AsyKeySpecItem.RSA_N_BN) as bigint;
    const e: bigint = keyPair.pubKey.getAsyKeySpec(cryptoFramework.AsyKeySpecItem.RSA_PK_BN) as bigint;
    return { modulus: bigintToBytes(n), exponent: bigintToBytes(e) };
  }

  async signRsaSha256(tbsDer: Uint8Array): Promise<Uint8Array> {
    const keyPair: cryptoFramework.KeyPair = await this.ensureKeyPair();
    const signer: cryptoFramework.Sign = cryptoFramework.createSign('RSA2048|PKCS1|SHA256');
    await signer.init(keyPair.priKey);
    const signature: cryptoFramework.DataBlob = await signer.sign({ data: tbsDer });
    // RSA 签名为 PKCS#1 v1.5 原始字节，内核直接入 BIT STRING，无形态转换
    return signature.data;
  }
}

/** bigint → 大端无符号字节（去前导零；0 编码为单字节 0x00） */
function bigintToBytes(v: bigint): Uint8Array {
  let hex: string = v.toString(16);
  if (hex.length % 2 === 1) {
    hex = '0' + hex;
  }
  const raw: Uint8Array = new Uint8Array(hex.length / 2);
  for (let i: number = 0; i < raw.length; i++) {
    raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  let start: number = 0;
  while (start < raw.length - 1 && raw[start] === 0) {
    start++;
  }
  return raw.subarray(start);
}

function hexLower(bytes: Uint8Array): string {
  const HEX: string = '0123456789abcdef';
  let out: string = '';
  for (let i: number = 0; i < bytes.length; i++) {
    out += HEX.charAt((bytes[i] >> 4) & 0x0f) + HEX.charAt(bytes[i] & 0x0f);
  }
  return out;
}
