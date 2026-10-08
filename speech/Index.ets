/**
 * speech（HAR）：离线朗读。S5-1 已交付系统离线 TTS 引擎实现（TTS-0，设计 §4.6）。
 *
 * **进度口径（S5-2 后）**：S5-1 引擎 + S5-2 播放主链路已落地——
 * 段规划（core/planner.ts：DocumentBlock → 规范化 → ≤300 字切段 → 块锚点）、
 * 有界预取队列（core/queue.ts，高水位背压）、播放控制器（core/controller.ts：
 * play/pause/stop/seek/next/prev 状态机 + 换文/快进 generation 切换 + 中断挂接）、
 * AVSession 播控适配（adapters/av-session-controls.ets：通知栏/锁屏指令、音频焦点，
 * 真机核对项见文件头）。pause 为段边界暂停（恢复重读当前段头），TTS-0 整段粒度
 * 与 G4 探测方案 A 一致。
 *
 * 分层纪律（同 common/mcp）：`./src/main/ets/core/*` 零 @kit.*，本机 node 全量验证；
 * @kit.* 只允许出现在 `./src/main/ets/adapters/`。UI 只依赖本文件导出的符号。
 *
 * **仍未实现（真机/G4 项）**：playType=0 PCM 音频流与 AudioRenderer 播放管线
 * （段内进度高亮、样本级背压）、后台长时播报与音频焦点真机联验——见
 * tools/report/g4-tts-probe.md §5。
 */

// ---- 契约（S5-1 前冻结；对外导入路径不变） ----
export * from './src/main/ets/core/contract';

// ---- 引擎内核（零 @kit.*，本机可测） ----
export * from './src/main/ets/core/settings';
export * from './src/main/ets/core/driver';
export * from './src/main/ets/core/engine';
export * from './src/main/ets/core/testing';

// ---- 播放主链路（S5-2；零 @kit.*，本机可测） ----
export * from './src/main/ets/core/planner';
export * from './src/main/ets/core/queue';
export * from './src/main/ets/core/controller';

// ---- 鸿蒙适配（@kit.* 只允许出现在 adapters/） ----
export { SystemTtsDriver } from './src/main/ets/adapters/system-tts-driver';
export { PreferencesTtsSettingsStore } from './src/main/ets/adapters/preferences-settings-store';
export { AvSessionControls } from './src/main/ets/adapters/av-session-controls';
