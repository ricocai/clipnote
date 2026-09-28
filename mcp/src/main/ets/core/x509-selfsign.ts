/**
 * 设备侧自签证书（ECDSA P-256 + SHA-256）的纯 DER 编解码。
 *
 * 设计依据：`design/mcp-传输选型.md` §4 —— 生态无设备侧 cert-builder 框架（E5），
 * 证书结构手写；密钥生成与签名走端口（X509SignerPort），鸿蒙实现用
 * cryptoFramework（adapters/），本机测试用 node:crypto（tools/test）。
 * 本模块零平台依赖：TBSCertificate 结构编码、签名DER⇄raw 转换、PEM 封装都可本机验证。
 *
 * 刻意保持最小结构：v3 自签证书，subject=issuer（CN + SAN dNSName/iPAddress），
 * 不含 SKID/AKID/basicConstraints —— 信任完全由 TOFU 指纹比对承担（§4.5.3），
 * 这些扩展对 mbedTLS 客户端握手与 Cherry Studio 指纹展示都不是必需。
 */

/** 签名端口：鸿蒙适配器（cryptoFramework）与本机测试（node:crypto）分别实现。 */
export interface X509SignerPort {
  /** EC P-256 公钥非压缩点：65 字节（0x04 || X || Y） */
  publicKeyPointUncompressed(): Promise<Uint8Array>;
  /**
   * 对 TBSCertificate DER 做 ECDSA/SHA-256 签名。
   * 返回 IEEE P1363 raw 形态：r || s 各 32 字节共 64 字节（实现侧负责从平台格式转换）。
   */
  signEcdsaSha256(tbsDer: Uint8Array): Promise<Uint8Array>;
}

export interface SelfSignedCertParams {
  readonly commonName: string;
  /** 正整数 serial，≤20 字节大端无符号（调用方用安全随机源生成） */
  readonly serialNumber: Uint8Array;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** SAN dNSName 列表（如 `clipnote.local`） */
  readonly sanDnsNames: string[];
  /** SAN iPAddress 列表（IPv4 点分十进制） */
  readonly sanIps: string[];
}

// ---------------------------------------------------------------------------
// DER 基础编码（ASN.1 BER/DER 子集，足够 X.509 使用）
// ---------------------------------------------------------------------------

/** DER 长度字段（short form <128，否则 long form） */
export function derLength(n: number): Uint8Array {
  if (n < 0x80) {
    return new Uint8Array([n]);
  }
  const bytes: number[] = [];
  let v: number = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = v >> 8;
  }
  const out: Uint8Array = new Uint8Array(1 + bytes.length);
  out[0] = 0x80 | bytes.length;
  out.set(bytes, 1);
  return out;
}

/** DER TLV：tag 单字节 + length + content */
export function derTlv(tag: number, content: Uint8Array): Uint8Array {
  const len: Uint8Array = derLength(content.length);
  const out: Uint8Array = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

/** DER INTEGER：大端无符号，正数高位为 1 时补 0x00 */
export function derInteger(unsignedBigEndian: Uint8Array): Uint8Array {
  let start: number = 0;
  while (start < unsignedBigEndian.length - 1 && unsignedBigEndian[start] === 0) {
    start++;
  }
  let body: Uint8Array = unsignedBigEndian.subarray(start);
  if (body.length === 0) {
    body = new Uint8Array([0]);
  }
  if ((body[0] & 0x80) !== 0) {
    const padded: Uint8Array = new Uint8Array(body.length + 1);
    padded[0] = 0;
    padded.set(body, 1);
    body = padded;
  }
  return derTlv(0x02, body);
}

/** DER OID（如 `1.2.840.10045.3.1.7`） */
export function derOid(oid: string): Uint8Array {
  const parts: number[] = oid.split('.').map((p: string) => Number(p));
  const out: number[] = [40 * parts[0] + parts[1]];
  for (let i: number = 2; i < parts.length; i++) {
    let v: number = parts[i];
    const stack: number[] = [v & 0x7f];
    v = v >> 7;
    while (v > 0) {
      stack.unshift(0x80 | (v & 0x7f));
      v = v >> 7;
    }
    for (const b of stack) {
      out.push(b);
    }
  }
  return derTlv(0x06, new Uint8Array(out));
}

export function derSequence(...items: Uint8Array[]): Uint8Array {
  return derTlv(0x30, concatBytes(items));
}

export function derSet(...items: Uint8Array[]): Uint8Array {
  return derTlv(0x31, concatBytes(items));
}

export function derUtf8String(text: string): Uint8Array {
  return derTlv(0x0c, utf8Bytes(text));
}

export function derIa5String(text: string): Uint8Array {
  return derTlv(0x16, utf8Bytes(text));
}

/** DER BIT STRING：首字节为 unused-bits 计数（0） */
export function derBitString(content: Uint8Array): Uint8Array {
  const out: Uint8Array = new Uint8Array(content.length + 1);
  out[0] = 0;
  out.set(content, 1);
  return derTlv(0x03, out);
}

export function derOctetString(content: Uint8Array): Uint8Array {
  return derTlv(0x04, content);
}

/** DER UTCTime（YYMMDDHHMMSSZ，仅 1950–2049） */
export function derUtcTime(d: Date): Uint8Array {
  const text: string =
    String(d.getUTCFullYear() % 100).padStart(2, '0') +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0') +
    String(d.getUTCSeconds()).padStart(2, '0') +
    'Z';
  return derTlv(0x17, utf8Bytes(text));
}

/** context-specific primitive，如 GeneralName dNSName=[2]、iPAddress=[7] */
export function derContextPrimitive(tag: number, content: Uint8Array): Uint8Array {
  return derTlv(0x80 | tag, content);
}

/** context-specific constructed EXPLICIT，如 version=[0]、extensions=[3] */
export function derContextExplicit(tag: number, content: Uint8Array): Uint8Array {
  return derTlv(0xa0 | tag, content);
}

export function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total: number = 0;
  for (const p of parts) {
    total += p.length;
  }
  const out: Uint8Array = new Uint8Array(total);
  let offset: number = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 签名格式转换：IEEE P1363 raw(r||s) ⇄ DER SEQUENCE(INTEGER r, INTEGER s)
// ---------------------------------------------------------------------------

/** P1363 raw（64 字节 r||s）转 DER，供写入 X.509 signature 字段 */
export function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  if (raw.length % 2 !== 0 || raw.length === 0) {
    throw new Error(`ecdsa raw signature length must be even, got ${raw.length}`);
  }
  const half: number = raw.length / 2;
  return derSequence(derInteger(raw.subarray(0, half)), derInteger(raw.subarray(half)));
}

/** DER 签名转 P1363 raw（r、s 定长补齐；供适配器把平台 DER 输出转交本内核） */
export function ecdsaDerToRaw(der: Uint8Array, partLength: number): Uint8Array {
  // 期望形态：30 LL 02 Lr <r> 02 Ls <s>
  if (der.length < 8 || der[0] !== 0x30) {
    throw new Error('malformed DER ecdsa signature');
  }
  const readInt = (from: number): { value: Uint8Array; next: number } => {
    if (der[from] !== 0x02) {
      throw new Error('malformed DER ecdsa signature: expected INTEGER');
    }
    const len: number = der[from + 1];
    let body: Uint8Array = der.subarray(from + 2, from + 2 + len);
    if (body.length > partLength) {
      // 去掉正数填充 0x00
      body = body.subarray(body.length - partLength);
    }
    const value: Uint8Array = new Uint8Array(partLength);
    value.set(body, partLength - body.length);
    return { value, next: from + 2 + len };
  };
  const r = readInt(2);
  const s = readInt(r.next);
  const out: Uint8Array = new Uint8Array(partLength * 2);
  out.set(r.value, 0);
  out.set(s.value, partLength);
  return out;
}

// ---------------------------------------------------------------------------
// 证书组装
// ---------------------------------------------------------------------------

// 所需 OID 的预编码（DER content，即去掉 tag+length 的部分在 derOid 内处理）
const OID_EC_PUBLIC_KEY: Uint8Array = derOid('1.2.840.10045.2.1');
const OID_PRIME256V1: Uint8Array = derOid('1.2.840.10045.3.1.7');
const OID_ECDSA_SHA256: Uint8Array = derOid('1.2.840.10045.4.3.2');
const OID_COMMON_NAME: Uint8Array = derOid('2.5.4.3');
const OID_SUBJECT_ALT_NAME: Uint8Array = derOid('2.5.29.17');

function subjectName(commonName: string): Uint8Array {
  // Name ::= SEQUENCE OF RelativeDistinguishedName（RDN 为 SET OF ATV）
  return derSequence(derSet(derSequence(OID_COMMON_NAME, derUtf8String(commonName))));
}

function spkiEcP256(publicKeyPoint: Uint8Array): Uint8Array {
  if (publicKeyPoint.length !== 65 || publicKeyPoint[0] !== 0x04) {
    throw new Error('EC P-256 uncompressed point must be 65 bytes starting with 0x04');
  }
  return derSequence(
    derSequence(OID_EC_PUBLIC_KEY, OID_PRIME256V1),
    derBitString(publicKeyPoint),
  );
}

function sanExtension(params: SelfSignedCertParams): Uint8Array {
  const names: Uint8Array[] = [];
  for (const dns of params.sanDnsNames) {
    names.push(derContextPrimitive(2, utf8Bytes(dns)));
  }
  for (const ip of params.sanIps) {
    names.push(derContextPrimitive(7, ipv4ToBytes(ip)));
  }
  const generalNames: Uint8Array = derSequence(...names);
  // Extension ::= SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }
  return derSequence(OID_SUBJECT_ALT_NAME, derOctetString(generalNames));
}

function ipv4ToBytes(dotted: string): Uint8Array {
  const parts: string[] = dotted.split('.');
  if (parts.length !== 4) {
    throw new Error(`not an IPv4 address: ${dotted}`);
  }
  const out: Uint8Array = new Uint8Array(4);
  for (let i: number = 0; i < 4; i++) {
    const n: number = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error(`not an IPv4 address: ${dotted}`);
    }
    out[i] = n;
  }
  return out;
}

/** AlgorithmIdentifier for ecdsa-with-SHA256（RFC 5758：参数必须缺席） */
function ecdsaSha256Algorithm(): Uint8Array {
  return derSequence(OID_ECDSA_SHA256);
}

/**
 * 编码 TBSCertificate 并签名，返回完整自签证书 DER。
 * 结构：v3 / serial / ecdsa-with-SHA256 / issuer=subject(CN) / UTCTime 有效期 /
 * SPKI(EC P-256) / [3] SAN。
 */
export async function buildSelfSignedCertificate(
  params: SelfSignedCertParams,
  signer: X509SignerPort,
): Promise<Uint8Array> {
  const point: Uint8Array = await signer.publicKeyPointUncompressed();
  const tbs: Uint8Array = derSequence(
    derContextExplicit(0, derInteger(new Uint8Array([2]))),
    derInteger(params.serialNumber),
    ecdsaSha256Algorithm(),
    subjectName(params.commonName),
    derSequence(derUtcTime(params.notBefore), derUtcTime(params.notAfter)),
    subjectName(params.commonName),
    spkiEcP256(point),
    derContextExplicit(3, derSequence(sanExtension(params))),
  );
  const rawSig: Uint8Array = await signer.signEcdsaSha256(tbs);
  return derSequence(tbs, ecdsaSha256Algorithm(), derBitString(ecdsaRawToDer(rawSig)));
}

// ---------------------------------------------------------------------------
// PEM（TLSSocketServer 加载形态）
// ---------------------------------------------------------------------------

const B64_STD: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64Encode(bytes: Uint8Array): string {
  let out: string = '';
  let i: number = 0;
  while (i + 2 < bytes.length) {
    const n: number = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_STD.charAt((n >> 18) & 63) + B64_STD.charAt((n >> 12) & 63) + B64_STD.charAt((n >> 6) & 63) + B64_STD.charAt(n & 63);
    i += 3;
  }
  if (i + 1 < bytes.length) {
    const n: number = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_STD.charAt((n >> 18) & 63) + B64_STD.charAt((n >> 12) & 63) + B64_STD.charAt((n >> 6) & 63) + '=';
  } else if (i < bytes.length) {
    const n: number = bytes[i] << 16;
    out += B64_STD.charAt((n >> 18) & 63) + B64_STD.charAt((n >> 12) & 63) + '==';
  }
  return out;
}

/** base64 解码（忽略空白；非法字符抛错）。用于把 PEM 还原为 DER 以重算指纹。 */
export function base64Decode(text: string): Uint8Array {
  const clean: string = text.replace(/\s/g, '');
  if (clean.length % 4 !== 0) {
    throw new Error('invalid base64 length');
  }
  const out: number[] = [];
  for (let i: number = 0; i < clean.length; i += 4) {
    const chunk: string = clean.slice(i, i + 4);
    let n: number = 0;
    let pad: number = 0;
    for (let k: number = 0; k < 4; k++) {
      const ch: string = chunk.charAt(k);
      if (ch === '=') {
        pad++;
        n = n << 6;
        continue;
      }
      const idx: number = B64_STD.indexOf(ch);
      if (idx < 0) {
        throw new Error(`invalid base64 character: ${ch}`);
      }
      n = (n << 6) | idx;
    }
    out.push((n >> 16) & 0xff);
    if (pad < 2) {
      out.push((n >> 8) & 0xff);
    }
    if (pad < 1) {
      out.push(n & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** PEM → DER：去掉首尾行与空白后 base64 解码。 */
export function pemToDer(pem: string): Uint8Array {
  const lines: string[] = pem.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
  if (lines.length < 3 || !lines[0].startsWith('-----BEGIN ') || !lines[lines.length - 1].startsWith('-----END ')) {
    throw new Error('malformed PEM');
  }
  return base64Decode(lines.slice(1, -1).join(''));
}

/** DER → PEM（64 列 base64），label 如 `CERTIFICATE` */export function derToPem(der: Uint8Array, label: string): string {
  const b64: string = base64Encode(der);
  const lines: string[] = [`-----BEGIN ${label}-----`];
  for (let i: number = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  lines.push(`-----END ${label}-----`);
  return lines.join('\n') + '\n';
}

/** UTF-8 编码（与 http11.ts 同一纪律：ArkTS 无全局 TextEncoder） */
function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  const length: number = text.length;
  for (let i: number = 0; i < length; i++) {
    let code: number = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < length) {
      const next: number = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}
