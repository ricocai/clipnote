import { pasteboard } from '@kit.BasicServicesKit';
import { ClipboardProbe } from '../core/ports';

/**
 * 系统剪贴板接触面（S2-4；端口见 core/ports.ts，实现纪律：@kit 只出现在 adapters）。
 *
 * hasData 是"回前台检查并提示"的全部依据 —— 它只回答布尔，不触碰内容：
 * G1 探测报告 §1 确认 API 12 的受管控读取清单是 getData/getDataSync/getUnifiedData/
 * getUnifiedDataSync（共 5 个接口），hasData 不在其中。若系统版本收紧导致这里抛错，
 * 如实按"探测不到＝无提示"处理（不打扰用户，主路径不受影响）。
 *
 * readText 只读取主文本，且**只应在用户手势后调用**（调用点纪律：Index 页三处入口，
 * 以及回前台提示条的"查看并保存"）。失败原样抛出，由 UI 如实展示 —— 不得静默。
 */
export class SystemPasteboardProbe implements ClipboardProbe {
  async hasData(): Promise<boolean> {
    try {
      const board: pasteboard.SystemPasteboard = pasteboard.getSystemPasteboard();
      return await board.hasData();
    } catch (err) {
      return false;
    }
  }

  async readText(): Promise<string> {
    const board: pasteboard.SystemPasteboard = pasteboard.getSystemPasteboard();
    // 空剪贴板（或无文本类内容）时，getData 返回的 PasteData 记录数组未初始化，
    // getPrimaryText 内部对 undefined 取 length 抛 TypeError（G1 真机实测，HarmonyOS 6.1.1）。
    // 先用非受控探测接口判空（hasDataType 与 hasData 同类，不在受控读取清单内），
    // 空则返回空串，由上层提示"剪贴板当前没有可保存的文本"。HTML 也是文本来源，一并探测。
    // 注意 hasDataType 返回 Promise，必须 await——不 await 则守卫恒不生效（X7 实测）。
    const hasPlain: boolean = await board.hasDataType(pasteboard.MIMETYPE_TEXT_PLAIN);
    const hasHtml: boolean = await board.hasDataType(pasteboard.MIMETYPE_TEXT_HTML);
    if (!hasPlain && !hasHtml) {
      return '';
    }
    const data: pasteboard.PasteData = await board.getData();
    // 契约：readText 永不返回 undefined（X7 实测：剪贴板声明 text 类型但主文本为空时
    // getPrimaryText 返回 undefined，上层 text.length 会抛 TypeError）。
    // 空主文本按"无可保存文本"处理，由 UI 如实提示。
    const text: string | undefined = data.getPrimaryText();
    return text === undefined ? '' : text;
  }
}
