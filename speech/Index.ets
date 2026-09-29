/**
 * speech（HAR）：离线朗读。S5-1 已交付系统离线 TTS 引擎实现（TTS-0，设计 §4.6）。
 *
 * **进度口径（S5-1 后）**：`ITtsEngine` 冻结接口的实现已落地——
 * 系统引擎适配（core/engine.ts + adapters/system-tts-driver.ets）、
 * capability 探测（不可用显式禁用，绝不静默转在线）、init/speak/stop/pause/resume/release
 * 全生命周期状态机、generation 代际取消、音色/语速持久化
 * （adapters/preferences-settings-store.ets）。pause/resume 按 G4 探测方案 A
 * （stop+新代际续读）实现，不抬 API 基线。
 *
 * 分层纪律（同 common/mcp）：`./src/main/ets/core/*` 零 @kit.*，本机 node 全量验证；
 * @kit.* 只允许出现在 `./src/main/ets/adapters/`。UI 只依赖本文件导出的符号。
 *
 * **仍未实现（真机/G4 项）**：playType=0 PCM 音频流与 AudioRenderer 播放管线
 * （段内进度高亮、背压）、断网/长时/音频焦点真机联验——见 tools/report/g4-tts-probe.md §5。
 */

// ---- 契约（S5-1 前冻结；对外导入路径不变） ----
export * from './src/main/ets/core/contract';

// ---- 引擎内核（零 @kit.*，本机可测） ----
export * from './src/main/ets/core/settings';
export * from './src/main/ets/core/driver';
export * from './src/main/ets/core/engine';
export * from './src/main/ets/core/testing';

// ---- 鸿蒙适配（@kit.* 只允许出现在 adapters/） ----
export { SystemTtsDriver } from './src/main/ets/adapters/system-tts-driver';
export { PreferencesTtsSettingsStore } from './src/main/ets/adapters/preferences-settings-store';
