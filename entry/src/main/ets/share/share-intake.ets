import { Want, wantConstant } from '@kit.AbilityKit';
import { systemShare } from '@kit.ShareKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import {
  ShareFileRef,
  ShareIntakeService,
  ShareIntakeSummary,
  ShareRejectReason,
  ShareWantData,
  isShareAction,
} from 'common';
import { AppServices } from '../services/AppServices';

/**
 * 分享接收的 entry 适配层（S2-3）。
 *
 * 职责：把 want 提取成平台无关的 ShareWantData（本文件是唯一允许碰 @kit 的地方），
 * 然后交给 common/core 的 ShareIntakeService 走统一管线；结果经 ShareNoticeBus 转给前台页面。
 *
 * want 提取策略（探测报告 §3，E20~E22）：
 *  1. 主路径走 Share Kit 官方解析 systemShare.getSharedData（utd/content/uri 结构化字段）；
 *  2. 失败或解析为空时回退直连 want 字段（action/type/uri + ability.params.stream）；
 *  3. 真实字段形态以真机探测（G1ProbeScenes 场景 q3）回收的 JSONL 为准回校。
 */

const DOMAIN: number = 0xF1C0;
const TAG: string = 'ClipNote';

/** UTD → MIME（module.json5 注册的图片类型）；已带 image/ 前缀的原样透传 */
export function mimeOfUtd(utd: string): string | undefined {
  switch (utd) {
    case 'general.png':
      return 'image/png';
    case 'general.jpeg':
      return 'image/jpeg';
    case 'general.webp':
      return 'image/webp';
    case 'general.gif':
      return 'image/gif';
    case 'general.bmp':
      return 'image/bmp';
    case 'general.heic':
    case 'general.heif':
      return 'image/heic';
    default:
      return utd.indexOf('image/') === 0 ? utd : undefined;
  }
}

export function isTextUtd(utd: string): boolean {
  return utd === 'general.text' || utd === 'general.plain-text' || utd.indexOf('text/') === 0;
}

/** 主路径：Share Kit 结构化解析；返回 false 表示不可用/为空，调用方走直连兜底 */
function extractViaShareKit(want: Want, texts: string[], files: ShareFileRef[]): Promise<boolean> {
  return systemShare.getSharedData(want)
    .then((data: systemShare.SharedData) => {
      const records: systemShare.SharedRecord[] = data.getRecords();
      for (let i: number = 0; i < records.length; i++) {
        const rec: systemShare.SharedRecord = records[i];
        if (isTextUtd(rec.utd)) {
          // content 形态以真机为准（探测场景 q3 回校）；非字符串一律按无文本处理
          const content: string = typeof rec.content === 'string' ? rec.content : '';
          if (content.length > 0) {
            texts.push(content);
          }
        } else if (rec.uri !== undefined && rec.uri.length > 0) {
          files.push({ uri: rec.uri, mime: mimeOfUtd(rec.utd) });
        }
      }
      return texts.length > 0 || files.length > 0;
    })
    .catch((err: Error) => {
      // 分享来源未走 Share Kit 协议时这里会失败 —— 属预期路径，降级为直连解析
      hilog.info(DOMAIN, TAG, 'share kit parse fallback: %{public}s', String(err));
      return false;
    });
}

/** 兜底：直连 want 字段（官方样例口径 ability.params.stream；探测报告 §3 E21/E22） */
function extractDirect(want: Want, texts: string[], files: ShareFileRef[]): void {
  const type: string = want.type ?? '';
  const uri: string = want.uri ?? '';

  const params = want.parameters as Record<string, Object> | undefined;
  const stream = params?.[wantConstant.Params.PARAMS_STREAM];
  const uris: string[] = [];
  if (typeof stream === 'string') {
    uris.push(stream);
  } else if (Array.isArray(stream)) {
    const list: Object[] = stream as Object[];
    for (let i: number = 0; i < list.length; i++) {
      const v: Object = list[i];
      if (typeof v === 'string') {
        uris.push(v);
      }
    }
  }
  for (let i: number = 0; i < uris.length; i++) {
    files.push({ uri: uris[i], mime: type.indexOf('image/') === 0 ? type : undefined });
  }

  // 文本形态：type 为 text/* 且 uri 不是文件/内容 URI 时，want.uri 即正文（如浏览器分享链接）
  const isFileUri: boolean =
    uri.indexOf('file://') === 0 || uri.indexOf('content://') === 0 || uri.indexOf('datashare://') === 0;
  if (type.indexOf('text/') === 0 && uri.length > 0 && !isFileUri) {
    texts.push(uri);
  } else if (isFileUri && uri.length > 0) {
    files.push({ uri, mime: type.indexOf('image/') === 0 ? type : undefined });
  }
}

export async function extractShareWantData(want: Want): Promise<ShareWantData> {
  const texts: string[] = [];
  const files: ShareFileRef[] = [];
  const ok: boolean = await extractViaShareKit(want, texts, files);
  if (!ok) {
    extractDirect(want, texts, files);
  }
  return { action: want.action, texts, files };
}

// ---------------------------------------------------------------------------
// 结果通知总线：Ability（无 UI）→ 前台页面
// ---------------------------------------------------------------------------

export type ShareNoticeListener = (summary: ShareIntakeSummary) => void;

/**
 * 分享结果的进程内总线。页面未订阅（冷启动途中的窗口期）时结果排队，
 * 页面 onPageShow 时 drain；已订阅则即时投递。只活在进程内存，不落盘。
 */
export class ShareNoticeBus {
  private static backlog: ShareIntakeSummary[] = [];
  private static listeners: ShareNoticeListener[] = [];

  static publish(summary: ShareIntakeSummary): void {
    if (ShareNoticeBus.listeners.length === 0) {
      ShareNoticeBus.backlog.push(summary);
      return;
    }
    for (let i: number = 0; i < ShareNoticeBus.listeners.length; i++) {
      ShareNoticeBus.listeners[i](summary);
    }
  }

  static subscribe(listener: ShareNoticeListener): void {
    ShareNoticeBus.listeners.push(listener);
  }

  static unsubscribe(listener: ShareNoticeListener): void {
    const idx: number = ShareNoticeBus.listeners.indexOf(listener);
    if (idx >= 0) {
      ShareNoticeBus.listeners.splice(idx, 1);
    }
  }

  static drain(): ShareIntakeSummary[] {
    const out: ShareIntakeSummary[] = ShareNoticeBus.backlog;
    ShareNoticeBus.backlog = [];
    return out;
  }
}

/**
 * EntryAbility 的唯一入口。非分享 want 直接返回；分享处理全程不抛 —
 * 任何失败都降级为日志 + 用户可见提示，绝不允许影响 Ability 正常启动。
 */
export async function handleSharedWant(want: Want, source: 'onCreate' | 'onNewWant'): Promise<void> {
  if (!isShareAction(want.action)) {
    return;
  }
  try {
    const data: ShareWantData = await extractShareWantData(want);
    // 数据层（恢复扫描）就绪前不落入收件箱；whenReady 等待的是 EntryAbility.onCreate 发起的同一 Promise
    const svc: ShareIntakeService = await AppServices.get().shareIntakeService();
    const summary: ShareIntakeSummary = await svc.handleShare(data);
    if (summary.handled) {
      ShareNoticeBus.publish(summary);
    }
  } catch (err) {
    hilog.error(DOMAIN, TAG, 'share intake failed (%{public}s): %{public}s', source, String(err));
    const summary: ShareIntakeSummary = {
      handled: true,
      persisted: 0,
      merged: 0,
      rejectedContent: [],
      pendingConfirm: [],
      rejections: [{ target: '', reason: ShareRejectReason.URI_UNREADABLE, detail: String(err) }],
      evicted: 0,
    };
    ShareNoticeBus.publish(summary);
  }
}
