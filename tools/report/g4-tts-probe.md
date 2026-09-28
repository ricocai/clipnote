# G4 系统离线 TTS 探测报告

生成时间：2026-09-28（WHY-92 / S1-4 任务 1，供 S5-1 与 TTS-0 PoC 采信）

## 探测性质与结论边界

| 项 | 值 |
|---|---|
| 探测方式 | **文档证据探测**（官方 Codelabs / Kit 简介页 + 社区交叉验证），非真机实测 |
| 主机限制 | 鸿蒙 `textToSpeech` 无法在 macOS 主机运行；且官方明确**模拟器不支持**（API ≤19 必真机） |
| 与 G7 的关系 | 同 G7 口径：本报告数字为**文档口径/社区量级**，设备侧必须复测（见 §5 清单）后才允许宣称 G4 通过 |

> 本报告回答"TTS-0 是否可行、边界在哪、真机要验证什么"，不产出实现代码（issue 约定：探测只出结论）。

## TTS-0 可行性结论

**可行，且当前（HarmonyOS NEXT）系统 TTS 是"离线唯一"能力**——不是"离线可用"而是"只支持离线"：

- 系统引擎 `TextToSpeechEngine`（`import { textToSpeech } from '@kit.SpeechKit'`，新文档归 `@kit.CoreSpeechKit`）的 `CreateEngineParams.online` 字段：**0=在线（官方口径"目前不支持"）、1=离线（"当前仅支持离线模式"）**。即"系统离线引擎"这一 TTS-0 前提不是风险项，而是系统当前唯一形态；联网状态也不改变文本不出设备的事实。
- **无需任何权限**：离线官方示例不声明 INTERNET/MICROPHONE（纯端侧合成，符合设计 §4.6"正文不联网发送"的验收口径）。
- **API 基线**：API 12（HarmonyOS NEXT 5.0.0）起可用，社区大量 API 12 实测；不抬高设计基线。

## 能力清单与边界

| 维度 | 结论 | 置信度 | 对设计的影响 |
|---|---|---|---|
| 断网可用性 | 离线-only，飞行模式可用为文档预期行为 | 官方，高 | TTS-0 前提成立；仍需真机复测（§5-1） |
| 语种 | 仅 `zh-CN` | 官方，高 | 与 R5"中文朗读"范围一致，无缺口 |
| 音色 | 官方口径 `person=0` 聆小珊（女声）；社区列 13/21（凌飞哲男声，"需下载"）/8（英文）等，版本与机型有差异 | 官方+社区，中 | **必须真机枚举**（§5-2）；多音色进 TTS-2，不阻塞 TTS-0 |
| 单次文本上限 | **10000 字符**（中英混排）；超限走 `onError`，**不截断**；官方/社区均推荐 >500 字逻辑分段 | 官方，高 | 设计"≤300 字切段"远低于上限，安全；错误码需真机取（§5-3） |
| 长文稳定性 | 无官方 >300 字段落连续合成的公开数据；分段合成是官方推荐路径 | 社区，中 | 连续 10 分钟播放欠载属 G4 真机验收项，非文档可判 |
| 音频输出 | `speak` 的 `extraParams.playType`：**1=引擎直接播报**（默认，无音频流出）；**0=只合成不播报，`onData` 回调返回 PCM**（`audioType:"pcm"`）交 AudioRenderer | 官方，高 | 设计"合成→有界队列→播放（AudioRenderer）"管线对应 playType=0；高亮/进度/背压都依赖此路径，须真机验证 PCM 帧格式（§5-5） |
| 中断/恢复 | 旧引擎（API 12~22）API 面仅 `speak/stop/isBusy/shutdown`，**无 pause/resume**；新 `SpeechSynthesizer`（HarmonyOS 6.1 / API 23 起）才有 pause/resume，社区实测为**句级**暂停且部分设备 resume 从头播 | 官方+社区，中 | 见下"接口对齐" |
| 延迟量级 | 无官方数据；社区称离线首包 50–200ms、在线 500ms–2s | 社区，低 | 仅作量级参考；G4 冷/热启动与首声延迟实测为验收项 |
| 模拟器 | 官方 Codelabs 明确"模拟器上不支持，建议真机"（Kit 简介页称 6.0.0(20) 起模拟器可用但与真机有差异） | 官方，高 | 探测与联调全部排真机；模拟器只跑通回调逻辑 |
| 常见坑 | ①模拟器无声 ②`requestId` 一次性（复用则后续 speak 不生效，须每次自增）③首次 createEngine 有初始化耗时（宜启动即异步初始化）④`volume` 范围 0–2（设 0 无声）、`speed/pitch` 0.5–2 ⑤`online:0` 创建失败 ⑥页面销毁须 stop+shutdown | 社区，中高 | requestId 一次性 → 现有代际 ID（generation）设计可直接覆盖 |

### 与冻结接口 `ITtsEngine` 的对齐（重要）

`speech/Index.ets` 冻结的 `pause()/resume()` 在 API 12~22 旧引擎上**没有原生对应**。两个选项：

- **A（推荐，不抬基线）**：pause/resume 按"stop + 记录已播放进度 + 重新 speak 剩余段"实现，`generation` 自增废弃旧样本——与设计 §4.6"切段/换音色/暂停/停止/来电中断时废弃旧 generation ID 的样本"的语义一致，接口不变；
- **B（抬基线到 API 23 / HarmonyOS 6.1）**：使用 `SpeechSynthesizer` 原生 pause/resume，但句级暂停语义与 resume 行为需真机复核，且抬高了 `minCompatibleVersion`。

**建议 TTS-0 走 A**，待 G4 真机数据回来后再决定是否把 API 23 作为 TTS-2 的增强项。

## 证据来源

| # | 结论 | 来源 | 类型 |
|---|---|---|---|
| E1 | 离线-only、`online` 字段语义、playType=0/1、回调集、`person=0`、模拟器不支持 | 官方 Codelabs《鸿蒙智能：AI语音朗读》(2025-10-30) developer.huawei.com/consumer/cn/codelabsPortal/carddetails/tutorials_Next-TTS | 官方 |
| E2 | 10000 字符上限、离线场景定位 | 官方 Kit 简介页摘要 (2026-05-14) developer.huawei.com/consumer/cn/doc/harmonyos-guides/core-speech-introduction（页面正文 JS 渲染未抓全，仅搜索摘要） | 官方 |
| E3 | API 12 实测、requestId 一次性、onData 签名 | 腾讯云开发者社区《鸿蒙开发：文本合成语音》(2024-12-31) developer.cloud.tencent.com/article/2482996 | 社区，与官方文案交叉一致 |
| E4 | 10000 字符上限、>500 字建议分段 | CSDN HarmonyOS 开发者社区《TTS 语音合成管理器》(2026-01-01)；dev.to (2025-11-05)；博客园 (2025-07-22) | 社区 |
| E5 | 旧引擎 API 面（无 pause/resume）、SpeechSynthesizer（API 23）句级 pause/resume、模拟器无声 | CSDN《Core Speech Kit 第3篇：语音合成》(2026-07-05，含可疑内容，pause/resume 部分降置信) | 社区 |
| E6 | 音色扩展（13/21/8 需下载）、5 种预置发音人说法 | cbismb (2026-07-16，仅摘要)；华为开发者论坛 (2025-06-27，仅摘要) | 社区/官方论坛，正文未抓取 |
| E7 | 常见坑（音量 0–2、初始化耗时、online:0 失败等） | ost.51cto.com (2025-10-30)、博客园 Flutter 离线部署 (2026-01-20) | 社区 |

> 说明：developer.huawei.com 的 API 参考页为 JS 渲染、本次抓取返回空壳；关键数据均经 ≥2 源交叉，无法交叉的已降置信。官方 API 参考路径社区引为 `developer.huawei.com/consumer/cn/doc/harmonyos-references/hms-ai-texttospeech`，**真机联调前浏览器人工核对一次**。

## 真机必测清单（G4 验收前置，S5-1 执行）

1. 飞行模式下 createEngine + speak 全链路（断网可用性终验）；
2. 目标机型/系统版本的音色枚举（`person` 全集、额外音色是否需下载、下载后离线可用性）；
3. 10000 字符边界与超长 `onError` 的 errorCode/errorMessage 实测值；
4. 300~10000 字符连续合成的 onData 序列完整性、onComplete 时序、内存曲线；>500 字分段的首包延迟；
5. playType=0 的 PCM 实际格式（采样率/位深/声道/帧大小）与 AudioRenderer 对接；
6. 来电/闹钟/其他音频焦点抢占时引擎行为（自动停？onError/onStop？恢复策略）——**目前无任何官方或社区实测证据，是本探测最大未知项**；
7. 冷/热 createEngine 初始化耗时、speak 首声延迟实测；
8. pause/resume 按方案 A（stop+续读）实现后的进度连续性验证；若届时目标基线为 API 23，再实测原生 pause/resume 句级语义；
9. `isBackStage: true` 后台播报在锁屏/退后台场景是否生效（AVSession 控制面 ≠ 后台合成资格，设计 §4.6 已有此警示）。

## 采信结论（给 S5-1）

- **TTS-0 可行**：系统引擎离线-only、zh-CN、无权限需求、API 12 基线——V0.2"系统离线 TTS"的前提成立，无需范围收敛。
- **三个硬边界**：①旧引擎无原生 pause/resume（按方案 A 实现，接口不变）；②单次 10000 字符上限 + 不截断报错（切段策略必须保留，不得整篇一次 speak）；③模拟器不可靠，一切验收在真机。
- **两个待真机定案的未知**：音频焦点中断行为、PCM 输出格式细节。
