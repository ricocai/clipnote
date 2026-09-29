/**
 * node 构建的 'common' 裸导入垫片（tools/tsconfig.json paths 映射目标）。
 *
 * hvigor 构建里 'common' 解析到 common HAR 的 Index.ets；但 Index.ets 还导出
 * adapters/（含 @kit.*，node 编译不过）。本垫片只重导出 speech core 需要的
 * common core 符号，保持「内核源码与 ArkTS 一致的裸导入写法」两边都合法。
 */

export {
  DEFAULT_SEGMENT_MAX_CHARS,
  NormalizeOptions,
  SpeechSegment,
  normalizeForSpeech,
  splitForSpeech,
} from '../../../common/src/main/ets/core/speech';
export { BlockType, DocumentBlock, SourceRange } from '../../../common/src/main/ets/core/model';
