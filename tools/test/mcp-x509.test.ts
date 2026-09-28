import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';

import {
  base64Encode,
  buildSelfSignedCertificate,
  concatBytes,
  derInteger,
  derLength,
  derOid,
  derSequence,
  derToPem,
  derTlv,
  derUtcTime,
  ecdsaDerToRaw,
  ecdsaRawToDer,
  X509SignerPort,
} from '../../mcp/src/main/ets/core/x509-selfsign';

/** node:crypto 实现的签名端口（对应鸿蒙 cryptoFramework 适配器的角色）。 */
class NodeX509Signer implements X509SignerPort {
  private readonly keyPair: crypto.KeyPairKeyObjectResult =
    crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  async publicKeyPointUncompressed(): Promise<Uint8Array> {
    const spki = new Uint8Array(this.keyPair.publicKey.export({ type: 'spki', format: 'der' }));
    // SPKI 尾部即 EC 非压缩点（0x04 || X || Y，65 字节）
    const point = spki.subarray(spki.length - 65);
    assert.equal(point[0], 0x04, 'SPKI 尾部应为非压缩点');
    return new Uint8Array(point);
  }

  async signEcdsaSha256(tbsDer: Uint8Array): Promise<Uint8Array> {
    const sigDer = crypto.sign('sha256', Buffer.from(tbsDer), this.keyPair.privateKey);
    // 平台 DER → P1363 raw(r||s, 32+32)
    return ecdsaDerToRaw(new Uint8Array(sigDer), 32);
  }
}

function sha256Hex(der: Uint8Array): string {
  return crypto.createHash('sha256').update(Buffer.from(der)).digest('hex');
}

test('DER 基础编码：长度、INTEGER 正数填充、OID base-128', () => {
  assert.deepEqual([...derLength(127)], [0x7f]);
  assert.deepEqual([...derLength(128)], [0x81, 0x80]);
  assert.deepEqual([...derLength(256)], [0x82, 0x01, 0x00]);

  // 高位为 1 必须补 0x00 保持正数语义
  assert.deepEqual([...derInteger(new Uint8Array([0x80]))], [0x02, 0x02, 0x00, 0x80]);
  // 前导 0 去除
  assert.deepEqual([...derInteger(new Uint8Array([0x00, 0x01]))], [0x02, 0x01, 0x01]);
  // 全零
  assert.deepEqual([...derInteger(new Uint8Array([0, 0]))], [0x02, 0x01, 0x00]);

  // 1.2.840.10045.3.1.7 → 2a 86 48 ce 3d 03 01 07
  const oid = derOid('1.2.840.10045.3.1.7');
  assert.deepEqual([...oid], [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
});

test('derUtcTime 产出 YYMMDDHHMMSSZ', () => {
  const d = new Date(Date.UTC(2026, 8, 28, 12, 30, 45));
  const tlv = derUtcTime(d);
  assert.equal(Buffer.from(tlv).toString('latin1'), '\x17\x0d260928123045Z');
});

test('ecdsa DER ⇄ P1363 raw 往返', () => {
  // r=1, s=0x80…（高位为 1，DER 会各补 0x00）
  const raw = new Uint8Array(64);
  raw[31] = 0x01;
  raw[32] = (raw[32] | 0x80) as number;
  const der = ecdsaRawToDer(raw);
  const back = ecdsaDerToRaw(der, 32);
  assert.deepEqual([...back], [...raw]);

  // DER 直接拼接
  assert.equal(der[0], 0x30);
  assert.equal(der[2], 0x02);
});

test('自签证书：Node X509 解析、自签名校验、指纹与有效期', async () => {
  const signer = new NodeX509Signer();
  const notBefore = new Date(Date.now() - 60 * 60 * 1000);
  const notAfter = new Date(notBefore.getTime() + 5 * 365 * 24 * 3600 * 1000);
  const serial = crypto.randomBytes(16);
  const der = await buildSelfSignedCertificate({
    commonName: 'clipnote-device',
    serialNumber: new Uint8Array(serial),
    notBefore,
    notAfter,
    sanDnsNames: ['clipnote.local'],
    sanIps: ['192.168.1.5'],
  }, signer);
  const pem = derToPem(der, 'CERTIFICATE');

  assert.match(pem, /^-----BEGIN CERTIFICATE-----\n/);
  assert.ok(pem.endsWith('-----END CERTIFICATE-----\n'));

  const cert = new crypto.X509Certificate(pem);
  // 结构解析成功 + 自签名验证（issuer 即 subject，用自身公钥验签）
  assert.equal(cert.subject, 'CN=clipnote-device');
  assert.equal(cert.issuer, 'CN=clipnote-device');
  assert.equal(cert.verify(cert.publicKey), true);

  // 指纹 = DER 的 SHA-256（TOFU 展示值）
  const expectedFp = sha256Hex(der);
  const actualFp = cert.fingerprint256!.toLowerCase().replace(/:/g, '');
  assert.equal(actualFp, expectedFp);

  // 有效期与序列号
  assert.equal(cert.serialNumber.toLowerCase(), serial.toString('hex'));
  const validTo = new Date(cert.validTo);
  const validFrom = new Date(cert.validFrom);
  assert.ok(validTo.getTime() - validFrom.getTime() >= 4.9 * 365 * 24 * 3600 * 1000, '有效期约 5 年');
  assert.ok(validFrom.getTime() <= Date.now());

  // SAN 进入扩展
  const san = cert.subjectAltName ?? '';
  assert.match(san, /DNS:clipnote\.local/);
  assert.match(san, /IP Address:192\.168\.1\.5/);
});

test('自签证书：不同密钥产出的证书互不复用签名（签名覆盖 TBSCertificate）', async () => {
  const a = new NodeX509Signer();
  const b = new NodeX509Signer();
  const params = {
    commonName: 'clipnote-device',
    serialNumber: new Uint8Array([1, 2, 3, 4]),
    notBefore: new Date(Date.UTC(2026, 0, 1)),
    notAfter: new Date(Date.UTC(2031, 0, 1)),
    sanDnsNames: [],
    sanIps: [] as string[],
  };
  const derA = await buildSelfSignedCertificate(params, a);
  const certA = new crypto.X509Certificate(derToPem(derA, 'CERTIFICATE'));
  // B 的证书不能用 A 的公钥验证
  const derB = await buildSelfSignedCertificate(params, b);
  const certB = new crypto.X509Certificate(derToPem(derB, 'CERTIFICATE'));
  assert.equal(certB.verify(certA.publicKey), false);
  assert.equal(certB.verify(certB.publicKey), true);
  assert.notEqual(sha256Hex(derA), sha256Hex(derB));
});

test('PEM base64 编码与标准实现一致', () => {
  const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
  assert.equal(base64Encode(data), Buffer.from(data).toString('base64'));
});

test('pemToDer/base64Decode 与编码互逆（加载证书重算指纹的路径）', async () => {
  const { base64Decode, pemToDer } = await import('../../mcp/src/main/ets/core/x509-selfsign');
  const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11]);
  assert.deepEqual([...base64Decode(base64Encode(data))], [...data]);
  const pem = derToPem(data, 'CERTIFICATE');
  assert.deepEqual([...pemToDer(pem)], [...data]);
  assert.throws(() => pemToDer('not a pem'));
});

test('derTlv/derSequence/concatBytes 组合结构', () => {
  const seq = derSequence(derTlv(0x02, new Uint8Array([1])), derTlv(0x02, new Uint8Array([2])));
  assert.deepEqual([...seq], [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
  const joined = concatBytes([new Uint8Array([1]), new Uint8Array([2, 3])]);
  assert.deepEqual([...joined], [1, 2, 3]);
});
