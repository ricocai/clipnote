/**
 * 受限子集 HTTP/1.1 编解码（RFC 7230 语义，MCP Streamable HTTP 唯一需求面）。
 *
 * 刻意不支持：管线化、chunked 请求体、 trailers、Upgrade、内容编码协商。
 * 设计依据：`design/mcp-传输选型.md` §3 实现边界。
 */

export interface HttpRequest {
  readonly method: string;
  /** 请求目标（origin-form），如 `/mcp` */
  readonly target: string;
  /** 头按出现顺序保留；名字小写、值去首尾空白 */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
}

/** 解析失败：status 为建议响应码 */
export class HttpParseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const CR: number = 0x0d;
const LF: number = 0x0a;

/**
 * UTF-8 编码（ArkTS 无全局 TextEncoder，内核两边可编译运行的最低公共分母，
 * 与 common/src/main/ets/core/bytes.ts 同一纪律）。
 */
export function utf8Encode(text: string): Uint8Array {
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

/** UTF-8 解码；非法序列以 U+FFFD 替换（头部行损失解码可容忍，正文 JSON 会在解析层拒绝） */
export function utf8Decode(bytes: Uint8Array): string {
  let out: string = '';
  let i: number = 0;
  const length: number = bytes.length;
  while (i < length) {
    const b0: number = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }
    let code: number = 0;
    let width: number = 0;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      code = b0 & 0x1f;
      width = 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      code = b0 & 0x0f;
      width = 3;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      code = b0 & 0x07;
      width = 4;
    } else {
      out += '�';
      i += 1;
      continue;
    }
    if (i + width > length) {
      out += '�';
      break;
    }
    let valid: boolean = true;
    for (let k: number = 1; k < width; k++) {
      const bk: number = bytes[i + k];
      if ((bk & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      code = (code << 6) | (bk & 0x3f);
    }
    if (!valid || (width === 3 && code < 0x800) || (width === 4 && code < 0x10000) || code > 0x10ffff) {
      out += '�';
      i += 1;
      continue;
    }
    if (code >= 0x10000) {
      const v: number = code - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
    i += width;
  }
  return out;
}

function findCrlf(buf: Uint8Array, from: number): number {
  for (let i: number = from; i + 1 < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF) {
      return i;
    }
  }
  return -1;
}

/**
 * 增量请求解析器：feed 任意字节块，nextRequest 在凑齐一个完整请求时返回。
 * 同一连接上请求按序解析（keep-alive 循环由 server.ts 驱动）。
 */
export class HttpRequestParser {
  private buf: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly maxHeaderBytes: number,
    private readonly maxBodyBytes: number,
  ) {}

  feed(data: Uint8Array): void {
    const merged: Uint8Array = new Uint8Array(this.buf.length + data.length);
    merged.set(this.buf);
    merged.set(data, this.buf.length);
    this.buf = merged;
  }

  /** 返回已完成的请求；数据不足返回 undefined（继续 feed）。 */
  nextRequest(): HttpRequest | undefined {
    // 请求行 + 头块必须以 CRLFCRLF 结束
    const headEnd: number = findCrlf(this.buf, 0);
    if (headEnd < 0) {
      if (this.buf.length > this.maxHeaderBytes) {
        throw new HttpParseError(431, 'header block too large');
      }
      return undefined;
    }
    // 逐行扫描直到空行
    let lineStart: number = 0;
    let lineEnd: number = headEnd;
    const lines: Uint8Array[] = [];
    while (true) {
      lines.push(this.buf.subarray(lineStart, lineEnd));
      const next: number = findCrlf(this.buf, lineEnd + 2);
      if (next === lineEnd + 2) {
        // 空行：头块结束
        break;
      }
      if (next < 0) {
        if (this.buf.length > this.maxHeaderBytes) {
          throw new HttpParseError(431, 'header block too large');
        }
        return undefined;
      }
      lineStart = lineEnd + 2;
      lineEnd = next;
    }
    const headTotal: number = lineEnd + 4;
    if (headTotal > this.maxHeaderBytes) {
      throw new HttpParseError(431, 'header block too large');
    }

    const requestLine: string = utf8Decode(lines[0]);
    const parts: string[] = requestLine.split(' ');
    if (parts.length !== 3) {
      throw new HttpParseError(400, 'malformed request line');
    }
    const method: string = parts[0];
    const target: string = parts[1];
    const version: string = parts[2];
    if (!version.startsWith('HTTP/1.')) {
      throw new HttpParseError(505, 'unsupported HTTP version');
    }
    if (method.length === 0 || !target.startsWith('/')) {
      throw new HttpParseError(400, 'malformed request line');
    }

    const headers: Array<readonly [string, string]> = [];
    let contentLength: number = 0;
    let hasContentLength: boolean = false;
    for (let i: number = 1; i < lines.length; i++) {
      const line: string = utf8Decode(lines[i]);
      const colon: number = line.indexOf(':');
      if (colon <= 0) {
        throw new HttpParseError(400, 'malformed header line');
      }
      const name: string = line.slice(0, colon).trim().toLowerCase();
      const value: string = line.slice(colon + 1).trim();
      if (name.length === 0) {
        throw new HttpParseError(400, 'malformed header line');
      }
      headers.push([name, value]);
      if (name === 'content-length') {
        const n: number = Number(value);
        if (!Number.isInteger(n) || n < 0) {
          throw new HttpParseError(400, 'invalid content-length');
        }
        contentLength = n;
        hasContentLength = true;
      }
      if (name === 'transfer-encoding') {
        // 受限子集：不接受分块请求体（设计边界）
        throw new HttpParseError(400, 'chunked request body not supported');
      }
    }

    if (hasContentLength && contentLength > this.maxBodyBytes) {
      throw new HttpParseError(413, 'request body too large');
    }
    if (this.buf.length < headTotal + contentLength) {
      return undefined;
    }
    const body: Uint8Array = this.buf.subarray(headTotal, headTotal + contentLength);
    this.buf = this.buf.subarray(headTotal + contentLength);
    return { method, target, headers, body };
  }
}

/** 响应头值禁止 CRLF 注入（对端数据不得进入响应头） */
export function isSafeHeaderValue(value: string): boolean {
  return value.indexOf('\r') < 0 && value.indexOf('\n') < 0;
}

const REASONS: Record<number, string> = {
  200: 'OK',
  202: 'Accepted',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  505: 'HTTP Version Not Supported',
};

export interface HttpResponseHead {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

/** 编码响应头块（HTTP/1.1） */
export function encodeHead(head: HttpResponseHead): Uint8Array {
  let text: string = `HTTP/1.1 ${head.status} ${REASONS[head.status] ?? 'Unknown'}\r\n`;
  for (const [name, value] of head.headers) {
    if (!isSafeHeaderValue(value)) {
      throw new HttpParseError(500, 'unsafe header value');
    }
    text += `${name}: ${value}\r\n`;
  }
  text += '\r\n';
  return utf8Encode(text);
}

/**
 * 编码一个完整响应（已知长度体）。
 * headers 中不得再包含 Content-Length / Connection，由本函数统一设置。
 */
export function encodeFixedResponse(
  status: number,
  headers: ReadonlyArray<readonly [string, string]>,
  body: Uint8Array,
  keepAlive: boolean,
): Uint8Array {
  const all: Array<readonly [string, string]> = [
    ...headers,
    ['Content-Length', String(body.length)],
    ['Connection', keepAlive ? 'keep-alive' : 'close'],
  ];
  const out: Uint8Array = new Uint8Array(encodeHead({ status, headers: all }).length + body.length);
  out.set(encodeHead({ status, headers: all }), 0);
  out.set(body, out.length - body.length);
  return out;
}

/** chunked 传输编码的一个数据块（0 长度块即结束） */
export function encodeChunk(data: Uint8Array): Uint8Array {
  const prefix: Uint8Array = utf8Encode(`${data.length.toString(16)}\r\n`);
  const suffix: Uint8Array = utf8Encode('\r\n');
  const out: Uint8Array = new Uint8Array(prefix.length + data.length + suffix.length);
  out.set(prefix, 0);
  out.set(data, prefix.length);
  out.set(suffix, prefix.length + data.length);
  return out;
}

/** 终止 chunked 流 */
export const CHUNKED_TERMINATOR: Uint8Array = utf8Encode('0\r\n\r\n');

/**
 * SSE 帧编码。payload 为单行 JSON（不得含换行，调用方保证）；
 * 规范事件名为 message，便于客户端统一处理。
 */
export function encodeSseEvent(payload: string): Uint8Array {
  return utf8Encode(`event: message\r\ndata: ${payload}\r\n\r\n`);
}

/** SSE 注释（心跳/占位），客户端必须忽略 */
export function encodeSseComment(text: string): Uint8Array {
  const safe: string = text.replace(/\r/g, ' ').replace(/\n/g, ' ');
  return utf8Encode(`: ${safe}\r\n\r\n`);
}

/** 提取头的第一个值（不区分大小写，解析器已转小写） */
export function headerValue(req: HttpRequest, name: string): string | undefined {
  for (const [n, v] of req.headers) {
    if (n === name) {
      return v;
    }
  }
  return undefined;
}

/** Accept 头是否包含某媒体类型（含 `*`/`*` 通配） */
export function accepts(header: string | undefined, mediaType: string): boolean {
  if (header === undefined) {
    return false;
  }
  for (const part of header.split(',')) {
    const token: string = part.split(';')[0].trim().toLowerCase();
    if (token === mediaType || token === '*/*') {
      return true;
    }
  }
  return false;
}
