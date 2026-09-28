import { pasteboard } from '@kit.BasicServicesKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { wantConstant } from '@kit.AbilityKit';
import { Want } from '@kit.AbilityKit';
import { fs } from '@kit.CoreFileKit';
import { G1ProbeLog } from './G1ProbeLog';

/**
 * G1 探测场景（WHY-90，临时设施，G1 验收后随 G1ProbeLog 一并移除）。
 *
 * 每个场景对应探测报告（tools/report/g1-clipboard-probe.md）的一个待复测问题。
 * 场景只负责"执行 + 如实记录结果"，不做任何业务判断 —— 判断全部在报告里完成。
 *
 * 主机无鸿蒙运行环境，本文件未经设备编译验证；字段/签名以 API 12 SDK 文档口径编写，
 * 真机执行时若遇编译差异，以 SDK 报错为准修正，不得改动探测语义。
 */

/** 探针总开关。false 时 EntryAbility 的探针块退化为纯日志，不触碰剪贴板。 */
export const G1_PROBE_ENABLED: boolean = true;

/** 场景编号与报告章节一一对应 */
export const SCENE = {
  DEVICE_INFO: 'q0-device-info',
  MANUAL_READ: 'q1-manual-read',
  PASTE_BUTTON: 'q2-paste-button',
  SHARE_WANT: 'q3-share-want',
  SHARE_URI_COPY: 'q3-share-uri-copy',
  FOREGROUND_READ: 'q4-foreground-read',
} as const;

/** 记录设备指纹：每项探测结论都必须能回溯到具体机型/系统/API level */
export function recordDeviceInfo(): void {
  try {
    G1ProbeLog.record(
      SCENE.DEVICE_INFO,
      true,
      `os=${deviceInfo.osFullName}; display=${deviceInfo.displayVersion}; ` +
        `sdkApi=${deviceInfo.sdkApiVersion}; deviceType=${deviceInfo.deviceType}`,
    );
  } catch (err) {
    G1ProbeLog.record(SCENE.DEVICE_INFO, false, `deviceInfo 读取失败: ${String(err)}`);
  }
}

/** 把一条 PasteData 的类型清单展开成可读字符串（text/html/plain/uri/pixelMap/自定义） */
function describePasteData(data: pasteboard.PasteData): string {
  const parts: string[] = [];
  parts.push(`records=${data.getRecordCount()}`);
  parts.push(`hasHtml=${data.hasMimeType(pasteboard.MIMETYPE_TEXT_HTML)}`);
  parts.push(`hasPlain=${data.hasMimeType(pasteboard.MIMETYPE_TEXT_PLAIN)}`);
  parts.push(`hasUri=${data.hasMimeType(pasteboard.MIMETYPE_TEXT_URI)}`);
  parts.push(`hasPixelMap=${data.hasMimeType(pasteboard.MIMETYPE_PIXELMAP)}`);
  for (let i: number = 0; i < data.getRecordCount(); i++) {
    const rec: pasteboard.PasteDataRecord = data.getRecord(i);
    parts.push(`r${i}.mime=${rec.getMimeType()}`);
  }
  const text: string = data.getPrimaryText();
  parts.push(`primaryTextLen=${text.length}`);
  return parts.join(' ');
}

/** 读取剪贴板并记录完整结果。trigger 标注触发方式（manual / pasteButton / foreground），用于区分授权路径 */
export async function probeClipboardRead(scene: string, trigger: string): Promise<void> {
  try {
    const board: pasteboard.SystemPasteboard = pasteboard.getSystemPasteboard();
    const hasData: boolean = await board.hasData();
    if (!hasData) {
      G1ProbeLog.record(scene, true, `trigger=${trigger} hasData=false（剪贴板为空，读取未被拦截）`);
      return;
    }
    const data: pasteboard.PasteData = await board.getData();
    G1ProbeLog.record(scene, true, `trigger=${trigger} 读取成功 ${describePasteData(data)}`);
  } catch (err) {
    // 201=权限校验失败（弹窗被拒/未授权）；其他错误码原样记录，不猜原因
    G1ProbeLog.record(scene, false, `trigger=${trigger} 读取失败: ${JSON.stringify(err)}`);
  }
}

/** PasteButton 点击回调内的读取：验证"临时授权窗口内免弹窗读取"是否成立（含图片类型） */
export async function probePasteButtonRead(): Promise<void> {
  await probeClipboardRead(SCENE.PASTE_BUTTON, 'pasteButton');
}

/** 回前台读取（无用户手势）：验证 onForeground 时机系统是否放行、默认授权策略下是否弹窗 */
export async function probeForegroundRead(): Promise<void> {
  if (!G1_PROBE_ENABLED) {
    return;
  }
  await probeClipboardRead(SCENE.FOREGROUND_READ, 'foreground');
}

/**
 * 分享接收：原样记录 want 结构（参数 key、URI 形态），不解析业务内容。
 * 关注 key 的实际到达形态 —— 文档口径是 ability.params.stream，探测要验证真机一致性。
 */
export function probeShareWant(want: Want, source: 'onCreate' | 'onNewWant'): void {
  try {
    const action: string = want.action ?? '';
    const uriKeys: string[] = [];
    const params = want.parameters as Record<string, Object> | undefined;
    if (params !== undefined && params !== null) {
      const keys: string[] = Object.keys(params);
      for (let i: number = 0; i < keys.length; i++) {
        const v = params[keys[i]];
        uriKeys.push(`${keys[i]}=${typeof v}`);
      }
    }
    let streamDesc: string = 'stream=absent';
    try {
      const stream = params?.[wantConstant.Params.PARAMS_STREAM];
      streamDesc = `stream=${JSON.stringify(stream)}`;
    } catch (streamErr) {
      streamDesc = `stream=read-error:${String(streamErr)}`;
    }
    G1ProbeLog.record(
      SCENE.SHARE_WANT,
      true,
      `source=${source} action=${action} uri=${want.uri ?? ''} type=${want.type ?? ''} ` +
        `keys=[${uriKeys.join(',')}] ${streamDesc}`,
    );
  } catch (err) {
    G1ProbeLog.record(SCENE.SHARE_WANT, false, `source=${source} want 记录失败: ${String(err)}`);
  }
}

/**
 * 分享 URI 复制入沙箱：直接 fs.openSync 读临时授权 URI，验证"拿到 URI 立即复制"路径可行性。
 * 逐字节核验交由 common 的 blob CAS 负责，探针只回答"能不能打开、能读多少"。
 */
export function probeShareUriCopy(want: Want): void {
  try {
    const params = want.parameters as Record<string, Object> | undefined;
    const stream = params?.[wantConstant.Params.PARAMS_STREAM] as string[] | string | undefined;
    if (stream === undefined || stream === null) {
      return;
    }
    const uris: string[] = Array.isArray(stream) ? stream : [stream];
    for (let i: number = 0; i < uris.length; i++) {
      try {
        const file = fs.openSync(uris[i], fs.OpenMode.READ_ONLY);
        const stat = fs.statSync(file.fd);
        fs.closeSync(file);
        G1ProbeLog.record(SCENE.SHARE_URI_COPY, true, `uri=${uris[i]} 可读 size=${stat.size}`);
      } catch (err) {
        G1ProbeLog.record(SCENE.SHARE_URI_COPY, false, `uri=${uris[i]} 打开失败: ${JSON.stringify(err)}`);
      }
    }
  } catch (err) {
    G1ProbeLog.record(SCENE.SHARE_URI_COPY, false, `stream 解析失败: ${String(err)}`);
  }
}
