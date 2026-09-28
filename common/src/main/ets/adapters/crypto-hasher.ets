import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { IHasher } from '../core/ports';

const HEX: string = '0123456789abcdef';

function toHexLower(bytes: Uint8Array): string {
  let out: string = '';
  for (let i: number = 0; i < bytes.length; i++) {
    const v: number = bytes[i];
    out += HEX.charAt((v >> 4) & 0x0f) + HEX.charAt(v & 0x0f);
  }
  return out;
}

/**
 * SHA-256 摘要。
 * 与领域层的契约（ports.ts）：返回**小写 64 位十六进制**；不一致会破坏内容寻址与去重语义。
 */
export class CryptoHasher implements IHasher {
  async sha256Hex(data: string): Promise<string> {
    const encoder: util.TextEncoder = new util.TextEncoder();
    const bytes: Uint8Array = encoder.encodeInto(data);
    const md: cryptoFramework.Md = cryptoFramework.createMd('SHA256');
    await md.update({ data: bytes });
    const digest: cryptoFramework.DataBlob = await md.digest();
    return toHexLower(digest.data);
  }
}
