/**
 * 字节与文本工具（纯函数，无平台依赖）。
 *
 * 为什么不直接用 TextEncoder / Buffer：
 *   ArkTS 的 TextEncoder 来自 `@ohos.util`（非全局），Node 用 `TextEncoder`/`Buffer`。
 *   内核必须两边都能编译运行，故自实现 UTF-8 字节计数与安全截断 —— 顺带消除了
 *   "按字节截断把代理对/多字节字符切坏" 这一类真实缺陷。
 */

/** 计算字符串的 UTF-8 字节长度（按码点遍历，正确处理代理对与 4 字节字符） */
export function utf8ByteLength(text: string): number {
  let total: number = 0;
  const length: number = text.length;
  for (let i: number = 0; i < length; i++) {
    const code: number = text.charCodeAt(i);
    if (code < 0x80) {
      total += 1;
    } else if (code < 0x800) {
      total += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // 高代理项：与后续低代理项合成一个 4 字节码点
      const next: number = i + 1 < length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        total += 4;
        i++;
      } else {
        // 孤立代理项：按 U+FFFD 计 3 字节
        total += 3;
      }
    } else {
      total += 3;
    }
  }
  return total;
}

export interface TruncateResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly byteLength: number;
}

/**
 * 按 UTF-8 字节上限截断，**保证落在码点边界**。
 * 设计 §4.1：超限内容不得静默丢弃，必须带 `truncated` 标记进入收件箱。
 */
export function truncateToUtf8Bytes(text: string, maxBytes: number): TruncateResult {
  const full: number = utf8ByteLength(text);
  if (full <= maxBytes) {
    return { text, truncated: false, byteLength: full };
  }
  let used: number = 0;
  let end: number = 0;
  const length: number = text.length;
  while (end < length) {
    const code: number = text.charCodeAt(end);
    let width: number = 1;
    let consumed: number = 1;
    if (code < 0x80) {
      width = 1;
    } else if (code < 0x800) {
      width = 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next: number = end + 1 < length ? text.charCodeAt(end + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        width = 4;
        consumed = 2;
      } else {
        width = 3;
      }
    } else {
      width = 3;
    }
    if (used + width > maxBytes) {
      break;
    }
    used += width;
    end += consumed;
  }
  return { text: text.slice(0, end), truncated: true, byteLength: used };
}

/** 统一行尾为 LF。注意：这是**唯一**允许的内建规范化，且不作用于持久化正文（设计 §4.1） */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

const ENCODED_DOT_RE: RegExp = /%2e/gi;
const ENCODED_PERCENT_RE: RegExp = /%25/gi;
/** 允许出现 `:`（如 Windows 盘符检测）但不得以 scheme 形式出现在相对路径中 */
const SCHEME_RE: RegExp = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/;

/**
 * 相对路径安全校验（设计 §4.2 备份恢复、§4.4 附件映射共同要求）。
 * 拒绝：绝对路径、盘符、UNC、任何形式的 `..` 段（含 `%2e` / `%2E` 与重复编码如 `%252e`）、
 * 空段、控制字符、NUL。返回布尔值以便在无异常语义的解析循环里使用。
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) {
    return false;
  }
  // 控制字符与 NUL
  for (let i: number = 0; i < path.length; i++) {
    const code: number = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  if (SCHEME_RE.test(path)) {
    return false;
  }
  if (path.startsWith('/') || path.startsWith('\\')) {
    return false;
  }
  // 逐轮解码，最多 5 轮，覆盖 %2e 与重复编码（%252e → %2e → '.'）等变体；
  // 不使用带 lastIndex 的 test（g 标志下 test 是有状态的，会漏判）。
  let decoded: string = path;
  for (let round: number = 0; round < 5; round++) {
    const next: string = decoded.replace(ENCODED_PERCENT_RE, '%').replace(ENCODED_DOT_RE, '.');
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  const normalized: string = decoded.split('\\').join('/');
  const segments: string[] = normalized.split('/');
  for (let i: number = 0; i < segments.length; i++) {
    const seg: string = segments[i];
    if (seg.length === 0) {
      return false;
    }
    if (seg === '.' || seg === '..') {
      return false;
    }
  }
  return true;
}

/** 生成一个确定性安全短随机串（用于临时文件名）；不用于任何密码学用途 */
export function toHex(bytes: Uint8Array): string {
  let out: string = '';
  for (let i: number = 0; i < bytes.length; i++) {
    const v: number = bytes[i] & 0xff;
    out += (v < 16 ? '0' : '') + v.toString(16);
  }
  return out;
}

/**
 * UTF-8 编码（纯函数）。
 * 字节宽度口径与 `utf8ByteLength` 完全一致（含孤立代理项 → U+FFFD），
 * 因此 `utf8Encode(t).length === utf8ByteLength(t)` 恒成立。
 */
export function utf8Encode(text: string): Uint8Array {
  const out: Uint8Array = new Uint8Array(utf8ByteLength(text));
  let o: number = 0;
  const length: number = text.length;
  for (let i: number = 0; i < length; i++) {
    let code: number = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next: number = i + 1 < length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      out[o++] = code;
    } else if (code < 0x800) {
      out[o++] = 0xc0 | (code >> 6);
      out[o++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[o++] = 0xe0 | (code >> 12);
      out[o++] = 0x80 | ((code >> 6) & 0x3f);
      out[o++] = 0x80 | (code & 0x3f);
    } else {
      out[o++] = 0xf0 | (code >> 18);
      out[o++] = 0x80 | ((code >> 12) & 0x3f);
      out[o++] = 0x80 | ((code >> 6) & 0x3f);
      out[o++] = 0x80 | (code & 0x3f);
    }
  }
  return out;
}

/** UTF-8 解码（纯函数）；非法序列按 WHATWG 惯例替换为 U+FFFD，不抛错 */
export function utf8Decode(bytes: Uint8Array): string {
  let out: string = '';
  let i: number = 0;
  const length: number = bytes.length;
  while (i < length) {
    const b0: number = bytes[i];
    let code: number = 0;
    let needed: number = 0;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      code = b0 & 0x1f;
      needed = 1;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      code = b0 & 0x0f;
      needed = 2;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      code = b0 & 0x07;
      needed = 3;
    } else {
      // 孤立 continuation / 非法首字节
      out += String.fromCharCode(0xfffd);
      i++;
      continue;
    }
    if (i + needed >= length) {
      out += String.fromCharCode(0xfffd);
      i++;
      continue;
    }
    let valid: boolean = true;
    for (let k: number = 1; k <= needed; k++) {
      const bk: number = bytes[i + k];
      if (bk < 0x80 || bk > 0xbf) {
        valid = false;
        break;
      }
      code = (code << 6) | (bk & 0x3f);
    }
    // 拒绝 overlong 与超范围编码（安全口径：不允许同一码点的多种字节表示）
    if (
      !valid ||
      (needed === 1 && code < 0x80) ||
      (needed === 2 && code < 0x800) ||
      (needed === 3 && code < 0x10000) ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      out += String.fromCharCode(0xfffd);
      i++;
      continue;
    }
    if (code < 0x10000) {
      out += String.fromCharCode(code);
    } else {
      const v: number = code - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
    i += needed + 1;
  }
  return out;
}
