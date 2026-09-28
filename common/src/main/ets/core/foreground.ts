/**
 * 回前台「检查并提示」状态机（S2-4；设计 §4.1 场景矩阵第 2 行、WHY-96 任务 1）。
 *
 * 口径（V1.4，勿放宽）：
 *  - 检测阶段**不读内容**：只做"有没有内容"探测（probe.hasData），读内容必须等用户手势；
 *  - 提示条只是提示，是否读取/落盘由用户点击决定；落盘仍走 ClipIngestService 管线，
 *    3 秒幂等窗（DEDUPE_WINDOW_MS）在内核处理重复内容，提示层不再叠一层去重；
 *  - 「拒绝授权后不得反复打扰」＝每个"非空集"只提示一次：用户点过（保存/忽略）或本集
 *    已提示过，就不再出现，直到剪贴板出现过一次"空"（集边界）；
 *  - 「不是历史补采」：本应用驻留后台期间发生的新复制，在不读内容的前提下无法被察觉，
 *    这是设计承诺边界（§4.1 明确不承诺 A/B/C 逐条补回），不是缺陷。
 *
 * 一次"非空集"＝从"已知为空/未知"到下一次"已知为空"之间的时段。
 * 回前台时机由平台侧驱动（EntryAbility.onForeground → 页面检查），本文件零平台依赖。
 */

import { ClipboardProbe } from './ports';

export enum ForegroundCheck {
  /** 应显示提示条（新的非空集，首次检查） */
  SHOW = 'show',
  /** 提示条已在展示，继续保留（同一集内用户尚未处理） */
  KEEP = 'keep',
  /** 不提示：集已处理过、无内容、或探测不可用 */
  NONE = 'none',
}

export class ForegroundPromptController {
  private open: boolean = false;
  private promptedInEpisode: boolean = false;

  get isPromptOpen(): boolean {
    return this.open;
  }

  get isEpisodeSuppressed(): boolean {
    return this.promptedInEpisode;
  }

  /**
   * 回前台检查。永不抛出：探测失败按"无内容"处理（检测失败不得打扰用户）。
   * 注意：这里只做布尔探测，不读取、不落盘任何内容。
   */
  async checkOnForeground(probe: ClipboardProbe): Promise<ForegroundCheck> {
    let filled: boolean = false;
    try {
      filled = await probe.hasData();
    } catch (err) {
      filled = false;
    }
    if (!filled) {
      // 集边界：剪贴板为空（或不可探测）→ 清空本集记忆，下次"非空"按新集处理
      this.promptedInEpisode = false;
      this.open = false;
      return ForegroundCheck.NONE;
    }
    if (this.open) {
      return ForegroundCheck.KEEP;
    }
    if (this.promptedInEpisode) {
      // 本集已提示过（含"拒绝后不得反复打扰"情形）
      return ForegroundCheck.NONE;
    }
    this.promptedInEpisode = true;
    this.open = true;
    return ForegroundCheck.SHOW;
  }

  /** 用户点击"查看并保存"：提示使命完成，本集不再弹（后续读取成败都不重新弹） */
  accept(): void {
    this.open = false;
    this.promptedInEpisode = true;
  }

  /** 用户点击"忽略"：本集剩余时间不再弹（设计：拒绝后不得反复打扰） */
  dismiss(): void {
    this.open = false;
    this.promptedInEpisode = true;
  }

  /** 完全重置（单测；未来若设置页增加"关闭采集"开关，接这里） */
  reset(): void {
    this.open = false;
    this.promptedInEpisode = false;
  }
}
