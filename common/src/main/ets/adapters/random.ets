import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { IRandom } from '../core/ports';

/** 密码学安全随机源（用于 UUID v7 与原子写入的临时文件后缀）。 */
export class CryptoRandom implements IRandom {
  private readonly rand: cryptoFramework.Random = cryptoFramework.createRandom();

  nextBytes(length: number): Uint8Array {
    return this.rand.generateRandomSync(length).data;
  }
}
