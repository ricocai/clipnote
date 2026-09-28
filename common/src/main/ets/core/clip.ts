/**
 * 剪贴板采集管线（设计 §4.1）。
 *
 * 落盘前的职责边界（V1.4 口径）：
 *   内容读取 → 类型识别与结构化 → **内存中限长与敏感特征判断（落盘前）** → SHA-256 去重（时间窗）→ 收件箱暂存
 *
 * 三条不可退让的约束：
 *   1. 收件箱即持久化 —— 一旦写入 `clipboard_item` 就是"已保存"，因此敏感内容必须**在落盘前**拦截；
 *      检测器一定存在漏判，所以它是"降噪"而非"安全保证"，UI 不得宣称已保护。
 *   2. 不得静默丢弃 —— 超限内容截断后带 `truncated` 标记进入收件箱。
 *   3. 不得粗暴规范化 —— 规范化仅用于类型判定与幂等键，永不改写持久化正文；
 *      代码空白与表格单元格边界必须原样保留。
 */

import {
  ClipEntry,
  ClipboardItem,
  ClipKind,
  DEDUPE_WINDOW_MS,
  DEFAULT_INBOX_TTL_MS,
  IngestDecision,
  IngestInput,
  IngestOutcome,
  InboxState,
  MAX_CLIP_TEXT_BYTES,
  NORMALIZE_VERSION,
  Sensitivity,
} from './model';
import { IClock, IHasher, ILogger, IRandom, LogLevel } from './ports';
import { normalizeLineEndings, truncateToUtf8Bytes, utf8ByteLength } from './bytes';
import { uuidv7 } from './id';

/** 硬上限：超过即判定为误操作/异常数据，直接拒绝而不是吃掉内存 */
export const HARD_REJECT_BYTES: number = 16 * 1024 * 1024;

/** 幂等记忆表容量上限（防内存无界增长；LRU 淘汰最旧） */
const DEDUPE_MEMORY_CAPACITY: number = 128;

// ---------------------------------------------------------------------------
// 类型识别
// ---------------------------------------------------------------------------

export interface Classification {
  readonly kind: ClipKind;
  readonly structuredJson?: string;
  readonly reasons: string[];
}

const URL_RE: RegExp = /^(https?|ftp|file|mailto):\/\/\S+$/i;
const IMAGE_EXT_RE: RegExp = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif|svg)(\?|#|$)/i;
const DATA_IMAGE_RE: RegExp = /^data:image\/[a-z0-9.+-]+;base64,/i;
const MD_TABLE_SEPARATOR_RE: RegExp = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

function isSingleLine(text: string): boolean {
  return text.indexOf('\n') < 0;
}

function countPipes(line: string): number {
  let n: number = 0;
  for (let i: number = 0; i < line.length; i++) {
    if (line.charCodeAt(i) === 0x7c) {
      n++;
    }
  }
  return n;
}

function countTabs(line: string): number {
  let n: number = 0;
  for (let i: number = 0; i < line.length; i++) {
    if (line.charCodeAt(i) === 0x09) {
      n++;
    }
  }
  return n;
}

/** 代码特征打分；阈值偏保守，避免把普通中文段落误判为代码 */
function codeScore(text: string): number {
  let score: number = 0;
  const signals: RegExp[] = [
    /(^|\n)\s*(import|from|export|package|using)\s+[\w.{*]/,
    /(^|\n)\s*(function|class|interface|struct|enum|def|fn|func|public|private|protected)\s+\w/,
    /(^|\n)\s*(const|let|var|val|final)\s+\w+\s*[:=]/,
    /(^|\n)\s*(if|for|while|switch|try|catch)\s*[({]/,
    /=>|::|->|\+\+|--|&&|\|\|/,
    /(^|\n)\s*(\/\/|#|\/\*|\*\/|<!--)/,
    /;\s*(\n|$)/,
    /[{}]\s*$/m,
  ];
  for (let i: number = 0; i < signals.length; i++) {
    if (signals[i].test(text)) {
      score++;
    }
  }
  return score;
}

export function classify(text: string): Classification {
  const reasons: string[] = [];
  const trimmed: string = text.trim();
  if (trimmed.length === 0) {
    return { kind: ClipKind.TEXT, reasons: ['empty'] };
  }

  if (DATA_IMAGE_RE.test(trimmed) || (isSingleLine(trimmed) && IMAGE_EXT_RE.test(trimmed))) {
    reasons.push('image_signature');
    const payload: string = isSingleLine(trimmed) ? trimmed : trimmed.slice(0, 64);
    return {
      kind: ClipKind.IMAGE,
      structuredJson: JSON.stringify({ ref: payload.slice(0, 2048) }),
      reasons,
    };
  }

  if (isSingleLine(trimmed) && URL_RE.test(trimmed)) {
    reasons.push('url_single_line');
    return {
      kind: ClipKind.URL,
      structuredJson: JSON.stringify({ url: trimmed.slice(0, 2048), host: hostOf(trimmed) }),
      reasons,
    };
  }

  const lines: string[] = trimmed.split('\n');
  if (lines.length >= 2) {
    // Markdown 表格：首行含 `|`，第二行为分隔行
    let headerPipes: number = countPipes(lines[0]);
    if (headerPipes >= 2 && MD_TABLE_SEPARATOR_RE.test(lines[1])) {
      reasons.push('markdown_table');
      const rows: string[] = [];
      for (let i: number = 2; i < lines.length; i++) {
        rows.push(lines[i]);
      }
      return {
        kind: ClipKind.TABLE,
        // 单元格边界原样保留（设计 §4.1：表格单元格边界不得粗暴规范化）
        structuredJson: JSON.stringify({
          delimiter: 'markdown',
          header: lines[0],
          columns: headerPipes - 1,
          rows,
        }),
        reasons,
      };
    }
    // TSV / Excel 粘贴
    let tabLines: number = 0;
    for (let i: number = 0; i < lines.length; i++) {
      if (countTabs(lines[i]) >= 1) {
        tabLines++;
      }
    }
    if (tabLines >= 2 && tabLines * 2 >= lines.length) {
      reasons.push('tsv_table');
      return {
        kind: ClipKind.TABLE,
        structuredJson: JSON.stringify({
          delimiter: 'tab',
          columns: countTabs(lines[0]) + 1,
          rows: lines,
        }),
        reasons,
      };
    }
  }

  const score: number = codeScore(trimmed);
  if (score >= 3) {
    reasons.push(`code_score_${score}`);
    return {
      kind: ClipKind.CODE,
      structuredJson: JSON.stringify({ lines: lines.length, score }),
      reasons,
    };
  }

  reasons.push('plain_text');
  return { kind: ClipKind.TEXT, reasons };
}

function hostOf(url: string): string {
  const m: RegExpMatchArray | null = url.match(/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/([^/?#]+)/);
  return m === null ? '' : m[1];
}

// ---------------------------------------------------------------------------
// 敏感特征检测（落盘前）
// ---------------------------------------------------------------------------

export interface SensitivityVerdict {
  readonly level: Sensitivity;
  readonly reasons: string[];
}

interface Rule {
  readonly id: string;
  readonly level: Sensitivity;
  readonly re: RegExp;
  /** 面向用户的中文说明：敏感提示交互中如实展示命中原因（S2-2，设计 §4.1 落盘前提示） */
  readonly label: string;
}

/** 强特征：一旦命中即可确信是凭证/私钥/实名标识 */
const HIGH_RULES: Rule[] = [
  { id: 'pem_private_key', level: Sensitivity.HIGH, re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: '私钥块（PEM）' },
  { id: 'pem_openssh_private_key', level: Sensitivity.HIGH, re: /-----BEGIN OPENSSH PRIVATE KEY-----/, label: 'OpenSSH 私钥块' },
  { id: 'aws_access_key_id', level: Sensitivity.HIGH, re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, label: 'AWS Access Key' },
  { id: 'github_token', level: Sensitivity.HIGH, re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, label: 'GitHub Token' },
  { id: 'slack_token', level: Sensitivity.HIGH, re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, label: 'Slack Token' },
  { id: 'google_api_key', level: Sensitivity.HIGH, re: /\bAIza[0-9A-Za-z\-_]{35}\b/, label: 'Google API Key' },
  { id: 'openai_style_key', level: Sensitivity.HIGH, re: /\bsk-[A-Za-z0-9]{16,}\b/, label: 'API 密钥（sk-…）' },
  {
    id: 'jwt',
    level: Sensitivity.HIGH,
    re: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/,
    label: 'JWT 令牌',
  },
  {
    id: 'cn_id_card',
    level: Sensitivity.HIGH,
    re: /\b[1-9]\d{5}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,
    label: '身份证号',
  },
];

/** 弱特征：需要上下文关键词共同命中，否则误报率过高 */
const CONTEXT_RULES: Rule[] = [
  {
    id: 'otp_code',
    level: Sensitivity.SUSPECTED,
    re: /(验证码|校验码|动态码|口令|verification\s*code|verify\s*code|one[\s-]*time\s*(password|code)|\bOTP\b|\b2FA\b)[\s:：是为]{0,4}\d{4,8}\b/i,
    label: '验证码/动态口令',
  },
  {
    id: 'password_assignment',
    level: Sensitivity.SUSPECTED,
    re: /(password|passwd|pwd|密码|口令|secret)\s*[:=：]\s*\S{4,}/i,
    label: '密码赋值',
  },
  {
    id: 'bearer_token',
    level: Sensitivity.SUSPECTED,
    re: /\bAuthorization\s*:\s*Bearer\s+\S{16,}/i,
    label: 'Bearer 令牌',
  },
  {
    id: 'bank_card_like',
    level: Sensitivity.SUSPECTED,
    re: /(卡号|账号|card\s*(number|no))\s*[:：]?\s*\d{16,19}\b/i,
    label: '银行卡号',
  },
  {
    id: 'private_key_hint',
    level: Sensitivity.SUSPECTED,
    re: /(私钥|密钥|api[\s_-]?key|access[\s_-]?token|secret[\s_-]?key)/i,
    label: '密钥相关关键词',
  },
];

/** 命中规则 id → 用户可读说明；未知 id 原样返回（不静默吞掉新规则） */
export function sensitivityReasonLabel(reasonId: string): string {
  for (let i: number = 0; i < HIGH_RULES.length; i++) {
    if (HIGH_RULES[i].id === reasonId) {
      return HIGH_RULES[i].label;
    }
  }
  for (let i: number = 0; i < CONTEXT_RULES.length; i++) {
    if (CONTEXT_RULES[i].id === reasonId) {
      return CONTEXT_RULES[i].label;
    }
  }
  return reasonId;
}

export class SensitivityDetector {
  detect(text: string): SensitivityVerdict {
    const reasons: string[] = [];
    let level: Sensitivity = Sensitivity.NONE;

    for (let i: number = 0; i < HIGH_RULES.length; i++) {
      const rule: Rule = HIGH_RULES[i];
      if (rule.re.test(text)) {
        reasons.push(rule.id);
        level = Sensitivity.HIGH;
      }
    }
    if (level !== Sensitivity.HIGH) {
      for (let i: number = 0; i < CONTEXT_RULES.length; i++) {
        const rule: Rule = CONTEXT_RULES[i];
        if (rule.re.test(text)) {
          reasons.push(rule.id);
          level = Sensitivity.SUSPECTED;
        }
      }
    }
    return { level, reasons };
  }
}

// ---------------------------------------------------------------------------
// 采集服务
// ---------------------------------------------------------------------------

export interface IngestPolicy {
  readonly maxTextBytes: number;
  readonly inboxTtlMs: number;
  readonly dedupeWindowMs: number;
}

export const DEFAULT_INGEST_POLICY: IngestPolicy = {
  maxTextBytes: MAX_CLIP_TEXT_BYTES,
  inboxTtlMs: DEFAULT_INBOX_TTL_MS,
  dedupeWindowMs: DEDUPE_WINDOW_MS,
};

export interface IngestDeps {
  readonly clock: IClock;
  readonly hasher: IHasher;
  readonly random: IRandom;
  readonly logger: ILogger;
  /** 覆盖默认策略；用于单测与灰度 */
  readonly policy?: IngestPolicy;
}

interface DedupeEntry {
  tsMs: number;
  item: ClipboardItem;
}

export interface ReIngestOptions {
  /** 用户显式"再次保存"：跳过幂等合并（设计 §4.1 保留该能力） */
  readonly forceNew?: boolean;
}

export class ClipIngestService {
  private readonly policy: IngestPolicy;
  private readonly detector: SensitivityDetector = new SensitivityDetector();
  /** 有界 LRU：Map 保持插入序，超容量时删除最旧键 */
  private readonly recent: Map<string, DedupeEntry> = new Map<string, DedupeEntry>();

  constructor(private readonly deps: IngestDeps) {
    this.policy = deps.policy === undefined ? DEFAULT_INGEST_POLICY : deps.policy;
  }

  async ingest(input: IngestInput, options?: ReIngestOptions): Promise<IngestOutcome> {
    const forceNew: boolean = options !== undefined && options.forceNew === true;
    const reasons: string[] = [];
    const raw: string = input.text;

    const byteLength: number = utf8ByteLength(raw);
    if (raw.trim().length === 0) {
      return this.reject(input, byteLength, ['empty_content']);
    }
    if (byteLength > HARD_REJECT_BYTES) {
      return this.reject(input, byteLength, ['exceeds_hard_limit']);
    }

    // ① 限长（落盘前，且在内存中完成）
    const cut = truncateToUtf8Bytes(raw, this.policy.maxTextBytes);
    if (cut.truncated) {
      reasons.push(`truncated_to_${this.policy.maxTextBytes}_bytes`);
    }
    const payload: string = cut.text;

    // ② 类型识别（在规范化副本上进行，正文不受影响）
    const normalizedForClassify: string = normalizeLineEndings(payload);
    const cls: Classification = classify(normalizedForClassify);
    for (let i: number = 0; i < cls.reasons.length; i++) {
      reasons.push(`kind:${cls.reasons[i]}`);
    }

    // ③ 摘要（对**原始**截断后字节计算，不做任何规范化）
    const sha: string = await this.deps.hasher.sha256Hex(payload);

    // ④ 敏感判断（落盘前）
    const verdict: SensitivityVerdict = this.detector.detect(payload);
    for (let i: number = 0; i < verdict.reasons.length; i++) {
      reasons.push(`sensitive:${verdict.reasons[i]}`);
    }

    const capturedAtMs: number = input.capturedAtMs === undefined ? this.deps.clock.nowMs() : input.capturedAtMs;
    const item: ClipboardItem = {
      id: uuidv7(this.deps.clock, this.deps.random),
      kind: cls.kind,
      rawText: payload,
      structuredJson: cls.structuredJson,
      originApp: input.originApp,
      sha256: sha,
      capturedAtMs,
      expiresAtMs: capturedAtMs + this.policy.inboxTtlMs,
      sensitivity: verdict.level,
      state: verdict.level === Sensitivity.NONE ? InboxState.PENDING : InboxState.AWAITING_CONFIRM,
      entry: input.entry,
      truncated: cut.truncated,
      originalByteLength: byteLength,
    };

    // ⑤ 幂等合并：同一次操作可能同时触发分享 / 前台读取 / 变化回调
    const key: string = this.dedupeKey(sha, cls.kind);
    if (!forceNew) {
      const hit: DedupeEntry | undefined = this.recent.get(key);
      if (hit !== undefined && capturedAtMs - hit.tsMs <= this.policy.dedupeWindowMs) {
        // 滑动窗口：突发期内后续重复事件继续被吸收
        hit.tsMs = capturedAtMs;
        this.touch(key, hit);
        this.deps.logger.log(LogLevel.DEBUG, 'clip_ingest_merged', {
          kind: cls.kind,
          entry: input.entry,
          sensitivity: verdict.level,
        });
        return {
          merged: true,
          decision: this.decide(verdict.level),
          item: hit.item,
          reasons: reasons.concat(['dedupe:merged_within_window']),
        };
      }
    }

    this.remember(key, { tsMs: capturedAtMs, item });
    const decision: IngestDecision = this.decide(verdict.level);
    if (decision === IngestDecision.REQUIRE_CONFIRM) {
      reasons.push('policy:no_auto_persist');
    }
    this.deps.logger.log(LogLevel.INFO, 'clip_ingest', {
      kind: cls.kind,
      entry: input.entry,
      sensitivity: verdict.level,
      decision,
      bytes: byteLength,
      truncated: cut.truncated,
    });
    return { merged: false, decision, item, reasons };
  }

  /** 清空幂等记忆（例如用户在设置中关闭/开启采集时） */
  reset(): void {
    this.recent.clear();
  }

  get dedupeMemorySize(): number {
    return this.recent.size;
  }

  private decide(level: Sensitivity): IngestDecision {
    return level === Sensitivity.NONE ? IngestDecision.AUTO_PERSIST : IngestDecision.REQUIRE_CONFIRM;
  }

  private dedupeKey(sha: string, kind: ClipKind): string {
    return `${NORMALIZE_VERSION}|${kind}|${sha}`;
  }

  private remember(key: string, entry: DedupeEntry): void {
    this.recent.delete(key);
    this.recent.set(key, entry);
    while (this.recent.size > DEDUPE_MEMORY_CAPACITY) {
      const oldest: string | undefined = this.recent.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.recent.delete(oldest);
    }
  }

  private touch(key: string, entry: DedupeEntry): void {
    this.recent.delete(key);
    this.recent.set(key, entry);
  }

  private reject(input: IngestInput, byteLength: number, reasons: string[]): IngestOutcome {
    const capturedAtMs: number = input.capturedAtMs === undefined ? this.deps.clock.nowMs() : input.capturedAtMs;
    const item: ClipboardItem = {
      id: uuidv7(this.deps.clock, this.deps.random),
      kind: ClipKind.TEXT,
      rawText: '',
      originApp: input.originApp,
      sha256: '',
      capturedAtMs,
      expiresAtMs: capturedAtMs,
      sensitivity: Sensitivity.NONE,
      state: InboxState.DISCARDED,
      entry: input.entry,
      truncated: false,
      originalByteLength: byteLength,
    };
    this.deps.logger.log(LogLevel.WARN, 'clip_ingest_rejected', {
      entry: input.entry,
      bytes: byteLength,
      reason: reasons.join(','),
    });
    return { merged: false, decision: IngestDecision.REJECT, item, reasons };
  }
}
