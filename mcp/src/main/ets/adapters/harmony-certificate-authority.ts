/**
 * 鸿蒙证书权威适配器：cryptoFramework 生成 EC(P-256) 密钥对 + 系统 Sign 自签，
 * 证书结构由 core/x509-selfsign.ts 纯 DER 编码（本机已验证）。
 * 私钥/证书持久化于应用沙箱（common IFileStore），PEM 形态供 TLSSocketServer 加载。
 *
 * ⚠ 真机验证项（design/mcp-传输选型.md R-A，置信度中）：本文件未经 DevEco 编译
 * 与真机验证。失败必须显式抛错交 UI 提示，**绝不静默退回明文 HTTP**（设计 §4.5.3）。
 *
 * 持久化布局（filesDir 下）：
 *   mcp-tls/key.pem    PKCS#8 私钥（不出设备、不进日志）
 *   mcp-tls/cert.pem   自签证书
 *   mcp-tls/meta.json  { generation, fingerprintSha256 }
 * 加载时三件套缺一即报错（不猜测、不重建 —— 避免无感丢失已配对客户端）。
 */

import { cryptoFramework } from '@kit.UniversalCryptoKit';

import { IClock, IFileStore, IRandom } from 'common';
import {
  ICertificateAuthority,
  ServerTlsMaterial,
} from '../core/transport-ports';
import {
  buildSelfSignedCertificate,
  derToPem,
  pemToDer,
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

  constructor(
    private readonly fs: IFileStore,
    private readonly dir: string,
    private readonly random: IRandom,
    private readonly clock: IClock,
  ) {}

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
      const gen = cryptoFramework.createAsyKeyGenerator('ECC256');
      this.keyPair = await gen.generateKeyPair();
      const encoded = this.keyPair.priKey.getEncoded();
      this.keyPem = derToPem(encoded.data, 'PRIVATE KEY');
    }
    return this.keyPair;
  }

  privateKeyPem(): string {
    if (this.keyPem.length === 0) {
      throw new Error('privateKeyPem called before key generation');
    }
    return this.keyPem;
  }

  async publicKeyPointUncompressed(): Promise<Uint8Array> {
    const keyPair = await this.ensureKeyPair();
    const spki: Uint8Array = keyPair.pubKey.getEncoded().data;
    // SPKI 尾部即 EC 非压缩点（0x04 || X || Y，65 字节），与本机 node:crypto 行为一致
    if (spki.length < 65 || spki[spki.length - 65] !== 0x04) {
      throw new Error('unexpected EC public key encoding from cryptoFramework');
    }
    return spki.subarray(spki.length - 65);
  }

  async signEcdsaSha256(tbsDer: Uint8Array): Promise<Uint8Array> {
    const keyPair = await this.ensureKeyPair();
    const signer = cryptoFramework.createSign('ECC256|SHA256');
    await signer.init(keyPair.priKey);
    const signature = await signer.sign({ data: tbsDer });
    // cryptoFramework ECC 签名为 P1363 raw（r||s 各 32 字节），即 X509SignerPort 契约形态
    return signature.data;
  }
}

function hexLower(bytes: Uint8Array): string {
  const HEX: string = '0123456789abcdef';
  let out: string = '';
  for (let i: number = 0; i < bytes.length; i++) {
    out += HEX.charAt((bytes[i] >> 4) & 0x0f) + HEX.charAt(bytes[i] & 0x0f);
  }
  return out;
}
