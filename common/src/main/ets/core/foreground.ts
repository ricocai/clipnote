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

/**
 * 剪贴板直写采集门（第二批 Feature 6 真机实测修复）。
 *
 * 口径：
 *  - 直写模式的"新内容"判定以**变更计数**为准（probe.changeCount），不以
 *    「剪贴板出现过空」为集边界——真机实测：用户连续复制 A→B，剪贴板从不
 *    为空，提示态的 ForegroundPromptController 会把 B 起全部吞掉（每集只
 *    提示一次的防打扰语义），表现为"只有第一次复制进了收件箱"；
 *  - 首检基线化：应用启动后第一次检查只记当前计数、不采集（沿用 §4.1
 *    「不是历史补采」边界——启动前复制的内容不抓）；
 *  - 计数回零（剪贴板服务重启）→ 重新基线化，不采集；
 *  - 探测失败 → SKIP 且不动基线（下次探测恢复后按原基线判定）；
 *  - 显式读取（安全控件/降级/提示条）后应调 syncAfterRead 抬基线，
 *    否则同一内容会被随后的回前台检查二次抓取。
 * 提示态（开关关）仍走 ForegroundPromptController，两套口径互不干扰。
 */

export enum AutoCaptureCheck {
  /** 有新复制发生，应读取并写收件箱 */
  CAPTURE = 'capture',
  /** 无新内容/首检基线化/探测失败，不采集 */
  SKIP = 'skip',
}

export class ClipboardAutoCaptureController {
  private baseline: number = -1;

  /**
   * 回前台检查。永不抛出：探测失败按"无变化"处理且不污染基线。
   */
  async checkOnForeground(probe: ClipboardProbe): Promise<AutoCaptureCheck> {
    let count: number = 0;
    let probed: boolean = false;
    try {
      count = await probe.changeCount();
      probed = true;
    } catch (err) {
      probed = false;
    }
    if (!probed) {
      return AutoCaptureCheck.SKIP;
    }
    if (this.baseline < 0) {
      // 首检：基线化，不补采（§4.1 边界）
      this.baseline = count;
      return AutoCaptureCheck.SKIP;
    }
    const changed: boolean = count > this.baseline;
    // 回零（服务重启）也被此赋值重新基线化
    this.baseline = count;
    return changed ? AutoCaptureCheck.CAPTURE : AutoCaptureCheck.SKIP;
  }

  /** 显式读取后同步基线：手动入口已消费当前内容，回前台不得再抓同一份 */
  async syncAfterRead(probe: ClipboardProbe): Promise<void> {
    try {
      const count: number = await probe.changeCount();
      if (count > this.baseline) {
        this.baseline = count;
      }
    } catch (err) {
      // 同步失败保持原基线；同内容二次抓取由内核 3 秒幂等窗兜底
    }
  }

  /** 完全重置（单测） */
  reset(): void {
    this.baseline = -1;
  }
}
