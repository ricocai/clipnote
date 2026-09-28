# G1 剪贴板权限 / 分享接收 / 回前台行为 探测报告

生成时间：2026-09-28（WHY-90 / S1-2 任务，供 Stage2 数据层与采集闭环采信）

## 探测性质与结论边界

| 项 | 值 |
|---|---|
| 探测方式 | **文档证据探测**（官方 API 文档/指南存档 + OpenHarmony 文档仓原文 + 社区实测交叉验证），非真机实测 |
| 主机限制 | 执行环境为 macOS，无 HarmonyOS SDK / DevEco / hdc / 模拟器，无法编译运行 ArkTS；剪贴板与分享行为是系统服务行为，主机无任何可替代的执行面 |
| 与 G4/G7 同口径 | 本报告数字为**文档口径/社区量级**；已随附可上机执行的探针设施（`entry/src/main/ets/probe/` + `pages/G1ProbePage`），真机执行并回收 JSONL 后才允许宣称 G1 通过 |
| 探针交付物 | `probe/G1ProbeLog.ets`（hilog + 沙箱 JSONL 双写）、`probe/G1ProbeScenes.ets`（6 个场景函数）、`pages/G1ProbePage.ets`（临时探测页）、EntryAbility 探针块（onCreate/onNewWant/onForeground，均有 `G1 PROBE BEGIN/END` 标记，验收后整体移除） |

> 本报告回答"五入口各自可不可行、边界在哪、真机要验证什么"，不改动业务代码（module.json5 的两处发现只记录、不修改，见 §6）。

## 1. API 12/13 下 `getSystemPasteboard().getData()` 读取行为

**结论（置信度：高）**

- 从 **API 12（HarmonyOS NEXT 5.0.0）起**，读取剪贴板接口增加读权限校验；未授权读取报 **201（Permission verification failed）**。受管控接口：`getData()` / `getData(callback)` / `getDataSync()` / `getUnifiedData()` / `getUnifiedDataSync()`（E1/E5）。
- `ohos.permission.READ_PASTEBOARD` 是 **system_basic 级受限 user_grant 权限**：完整申请需 ①ACL 方式申请高级别权限 → ②module.json5 声明 → ③`requestPermissionsFromUser` 弹窗。ACL 有场景门槛（官方允许场景举例：银行卡号/口令复制），**不符合场景的申请会被驳回，影响上架**（E2/E3/E8）。写入剪贴板（复制）不需要任何权限。
- 授权粒度默认 **"使用前每次询问"**：每次读取都可能弹窗，用户可在 设置→隐私和安全→剪贴板 改为"始终允许"（E6/E7）。弹窗时机由系统在应用实际调用读取接口时触发，应用不可控（E10）。
- 数据类型：MIMETYPE 常量共 5 个——`text/html`、`text/want`、`text/plain`、`text/uri`、`pixelMap`；另支持 ≤1024 字节的自定义 MIME。**没有 `image/*` 常量，剪贴板图片走 PixelMap**（E4）。API 12+ 另有 UDMF 通道 `getUnifiedData()`。

**对设计的直接影响**：探测题面假设的"声明 READ_PASTEBOARD 后即可读取"不成立——该权限是 ACL 受限权限，存在上架审批风险。采集主路径不应依赖它（见 §5 五入口结论）。

## 2. PasteButton 安全控件

**结论（置信度：高）**

- **API 10 起支持**（Stage 模型；元服务 API 11）。用户点击后应用临时获得读取权限，**读取不弹窗、且无需声明 READ_PASTEBOARD**（E11/E12/E13）。
- 临时授权有效期：官方原文"**持续到灭屏、应用切后台或应用退出为止**"，授权期间调用次数无限制（E12）。有社区来源称"切后台 10 秒后回收"（E14），与官方表述存在出入——列入真机复测。
- 回调签名：API 10–17 为 `onClick((event, result: PasteButtonOnClickResult) => void)`，`SUCCESS=0 / TEMPORARY_AUTHORIZATION_FAILED=1`；**API 18 起变更为三参 `PasteButtonCallback`**（E11）。V0.1 基线 API 12，不受影响。
- 使用限制：控件必须可见可识别；图标/文本不可自定义（只能选系统样式）；过小/透明/被遮挡/超屏/padding 为负等样式不合法会导致授权失败（错误码 2，10 类情形）（E11）。
- **矛盾证据（待复测）**：有社区实测称 API 12 下 PasteButton 回调内 `getDataSync()` 仍报需要 READ_PASTEBOARD（E15）。可能是未走 SUCCESS 分支或版本差异，探针场景 B 会记录真实错误码。

## 3. 分享接收（`ohos.want.action.sendData`）

**结论（置信度：高）**

- want 参数结构：UIAbility 在 `onCreate` / `onNewWant` 收 want；文件 URI 列表的 key 是 **`ability.params.stream`**（常量 `wantConstant.Params.PARAMS_STREAM`，API 12+），值为 string 数组，"表示授权给目标方的文件 URI 列表"（E21/E22 官方样例仓实测代码同口径）。**题面列的 `ohos.ability.params.stream` / `ohos.params.stream` 均非当前官方 key。**
- 官方推荐的解析路径是 Share Kit：skills 按 **UTD 穷举**可接收类型（`general.text` / `general.png` / `general.jpeg`…，并配 `maxFileSupported`，默认 0 即不收文件），UI 内用 `systemShare.getSharedData(want)` 解析为 `SharedData` → `SharedRecord`（含 `uri`、`utd`）（E20）。多文件分享 action 为 `ohos.want.action.sendMultipleData`。
- URI 临时授权有效期：**目标应用退出（进程销毁）后权限被系统回收；设备重启后全部失效**（E23/E24/E27）。需要长期访问须 `fileShare.persistPermission()`（API 11+；所需 `FILE_ACCESS_PERSIST` 在 API 12 起已降为 normal 级，不走 ACL），重启后还需 `activatePermission()` 激活（E25/E26）。
- 复制入沙箱可行路径：已授权 URI 可**直接用 `@ohos.file.fs` 的 `openSync/read` 打开并复制**到 `context.filesDir`；官方建议需要持久使用时"拿到 URI 后立即复制到应用沙箱"（E24/E25）。这与设计 §4.1"URI 图片在授权有效期内复制进沙箱并核验"一致。

## 4. 回前台（onForeground）读取剪贴板

**结论（置信度：中-高）**

- **允许读取，不要求用户手势**——onForeground 属前台时机，权限模型上合法；授权弹窗由系统在实际调用读取接口时触发，弹窗本身就是用户交互（E30/E31）。
- 但默认"每次询问"策略下，回前台自动读会**每次触发弹窗**（UX 不可接受）；改"始终允许"后无感（E7/E31）。后台/息屏读取被系统级禁止，上架应用 CrossPaste 实测口径一致：前台可记录，退后台即停（E32/E33/E34）。
- 弹窗期间是否触发二次前后台切换、导致 onForeground 重入——无文档证据，探针场景会记录（每次 onForeground 一条 FOREGROUND_READ 记录，重入会留下重复条目）。

## 5. 结论：V0.1 采集管线五入口可行性等级与降级方案

| 入口 | 可行性等级 | 依据 | 降级方案 |
|---|---|---|---|
| ① 前台监听（变化通知+读取） | **可行（有条件）** | 前台读取权限模型合法；变化通知（`pasteboard.on('update')`）与内容读取的权限需分别验证（设计 §4.1 已注明） | 用户未授权时仅提示"检测到剪贴板变化，点击查看"，不读内容 |
| ② 回前台提示 | **可行（须改交互）** | onForeground 读取合法且无手势要求，但默认策略下每次弹窗 | **不要自动读**：回前台只显示"有内容可保存"提示条，由用户点击（手势）触发读取——与设计 §4.1"提示保存、拒绝后不反复打扰"一致，探针数据回填后定稿 |
| ③ 分享接收 | **可行（高置信）** | want 结构、URI 授权生命周期、`fs` 直读复制路径均有官方证据 | URI 授权随进程退出回收 → 收到即复制入沙箱并核验（设计已如此）；长期访问需求走 persistPermission |
| ④ 桌面卡片 | **不可行（卡片内直接读），按设计降级成立** | ArkTS 卡片模块白名单不含 `@ohos.pasteboard`（无"支持卡片"标记）；FormExtensionAbility 无 UI 上下文无法完成 user_grant 授权；PasteButton 不在卡片组件白名单（E40~E43，置信度中，缺一条官方直述） | 设计 §4.1 口径即降级方案：卡片只负责拉起主应用采集页，读取在主应用前台完成。**不需要为卡片读取做任何投入** |
| ⑤ 手动粘贴入口（PasteButton） | **可行，且应列为首选路径** | API 10+、免弹窗、免 READ_PASTEBOARD 声明、授权窗口内次数不限 | 若真机复现 E15 反例（回调内仍报权限错误），降级为"PasteButton 点击 + 按需降级申请 READ_PASTEBOARD（ACL 路径）"；再不行退回普通按钮 + 系统弹窗 |

**风险 R2 处置建议**：READ_PASTEBOARD 是 ACL 受限权限、有上架审批风险（§1）。V0.1 采集应以 **PasteButton（⑤）+ 分享接收（③）+ 手势触发读取（①②降级形态）** 为主路径，把 READ_PASTEBOARD 的 ACL 申请降为可选项——即使审批不过，产品闭环仍成立。

## 6. 对现有代码的两处发现（只记录，未修改）

1. `entry/src/main/module.json5` 的分享 skills 用 **MIME 写法**（`text/plain`、`image/*`）注册 uris。Share Kit 官方指南要求按 **UTD 枚举**（`general.text`、`general.png`…）并配 `maxFileSupported`（默认 0 不收文件）。按现状配置，**图片分享大概率不会把 ClipNote 列入分享面板**。建议 Stage2 分享接收实现时改为 UTD 写法并用探针场景 q3 回归。
2. 同文件已声明 `ohos.permission.READ_PASTEBOARD`。按 §1 证据，该权限为 ACL 受限权限：未走 ACL 申请时声明本身在审核/安装期的行为需真机/提审验证；若 V0.1 走"⑤为主"的路径，可考虑移除该声明以降低审核面。决定权在 Stage2 开工时。

## 7. 证据来源

| # | 结论 | 来源 | 类型/日期 |
|---|---|---|---|
| E1 | API 12+ 读取接口增加权限管控；两条访问路径（安全控件免权限 / 申请 READ_PASTEBOARD） | gitee.com/openharmony/docs `get-pastedata-permission-guidelines.md` | 官方（OpenHarmony 文档仓） |
| E2 | READ_PASTEBOARD：system_basic、user_grant、起始 API 11 | OpenHarmony restricted-permissions.md（rvaim/openharmony-docs 镜像） | 官方（镜像） |
| E3 | READ_PASTEBOARD 受限 user_grant，自定义控件应用需 ACL；安全控件无需申请 | 华为开发者官方论坛答复（2024-12） | 官方论坛 |
| E4 | MIMETYPE 常量全表（5 个）、ValueType、错误码 201 | js-apis-pasteboard 官方文档存档（liasica/harmonyos-skills，原文更新 2026-09-23） | 官方文档存档 |
| E5 | OpenHarmony 5.0.0 Release 说明："API 12 起读取剪贴板增加读权限校验" | OpenHarmony 5.0.0 Release 发布说明（转载，2024-09） | 官方发布说明 |
| E6/E7 | 默认"使用前每次询问"，可在 设置→隐私和安全→剪贴板 改始终允许 | 知乎专栏（2025-10）/ 51CTO 问答（2024-12） | 社区实测 ×2 |
| E8 | ACL 受限场景举例与驳回风险 | 掘金：Flutter 三方依赖鸿蒙化（2026-01） | 社区实测 |
| E10 | 弹窗时机由系统在调用读取接口时触发，应用不可控 | IT营论坛：如何控制剪贴板权限弹窗时机 | 社区实测 |
| E11 | PasteButton API 10 起、回调签名与枚举、错误码 2 的 10 类样式不合法情形、API 18 签名变更 | ts-security-components-pastebutton 官方文档存档（更新 2026-09-09） | 官方文档存档 |
| E12 | PasteButton 免弹窗；临时授权持续到灭屏/切后台/退出；次数不限 | harmonyos-guides/pastebutton 官方指南存档 | 官方文档存档 |
| E13 | 点击时临时授予 ohos.permission.SECURE_PASTE | 腾讯云开发者社区（2024-12，转述官方变更说明） | 社区 |
| E14 | "切后台 10 秒后权限回收"（与官方表述出入） | ai6s.net 安全控件机制文（2026-03） | 社区（分歧项） |
| E15 | 反例：API 12 下 PasteButton 回调内 getDataSync 仍报需 READ_PASTEBOARD | IT营论坛帖 | 社区实测（分歧项） |
| E20 | Share Kit 接入：sendData + UTD 穷举 + maxFileSupported；getSharedData 解析 | harmonyos-guides/share-interface-description 官方指南存档 | 官方文档存档 |
| E21 | `PARAMS_STREAM = "ability.params.stream"`（API 12+），授权文件 URI 列表 | docs.openharmony.cn wantConstant 官方文档 | 官方 |
| E22 | 官方样例仓实测：`want.parameters['ability.params.stream']` | gitee.com/harmonyos-cases/cases EntryAbility.ets | 官方样例 |
| E23/E27 | URI 授权"目标应用退出后回收"；重启后全部失效 | uripermissionmanager 官方文档镜像（2025-06）；掘金文件分享文（2024-10） | 官方 + 社区 |
| E24/E25 | 已授权 URI 可直接 fs open/read 复制；官方建议"拿到即复制入沙箱"；persistPermission/activatePermission | CSDN 踩坑文（2026-06）；js-apis-fileShare 官方文档存档 | 社区实测 + 官方 |
| E26 | FILE_ACCESS_PERSIST 在 API 12 起降为 normal 级 | OpenHarmony restricted-permissions.md | 官方（镜像） |
| E30~E34 | 前台读取合法无手势要求；后台读取系统级禁止；CrossPaste 上架应用实测口径 | IT营/CSDN 实测、CrossPaste 官方教程（2026-09） | 社区实测多源一致 |
| E40~E43 | 卡片模块白名单机制；pasteboard 无卡片能力标记；FormExtensionAbility 加载非白名单模块得 undefined；PasteButton 仅限 ArkUI Full | 阿里云开发者社区、harmonyos.cool 卡片 FAQ、官方 pasteboard/PasteButton 文档（反向证据） | 官方机制 + 社区，中置信 |

> 说明：developer.huawei.com 正文为 JS 渲染无法直接抓取，官方证据取自 OpenHarmony 文档仓原文与逐页存档镜像（含原文 URL 与抓取时间戳）；关键结论均经 ≥2 源交叉，无法交叉或存在分歧的（E14/E15）已标注并列入真机必测。

## 8. 真机必测清单（G1 验收前置，Stage2 开工前执行）

探针设施已入库，执行步骤：

1. DevEco 编译 entry（API 12 SDK），安装到目标设备（记录型号/系统版本/API level——探针场景 q0 会自动落 `deviceInfo`）；
2. 首页底部"G1 探测页（临时）"进入探测页，逐按钮执行场景 A/B；
3. 从备忘录/浏览器/图库分别分享 text 与 image 到 ClipNote（场景 q3 自动记录 want 与 URI 直读结果）；
4. 切后台再回前台多次（场景 q4 自动记录，含弹窗重入迹象）；
5. 回收日志：`hdc shell "cat /data/app/el2/100/base/<bundle>/haps/entry/files/g1-probe.jsonl"` 或 `hdc file recv <沙箱路径>/g1-probe.jsonl .`，归档到 `tools/report/`。

必测项（与报告章节对应）：

1. §1：弹窗文案与选项、"每次询问"的确切频率（每次读取都弹 / 每冷启动首读弹）；
2. §2：PasteButton 切后台后授权回收时延（立即 vs 10 秒）；E15 反例是否可重现（SUCCESS 回调内同步读取）；临时授权窗口内能否读 PixelMap；
3. §3：各分享源（备忘录/浏览器/图库）want 实际到达字段；URI 直读在各源的兼容性；"应用退出即回收"的精确判定（后台驻留是否保活授权）；
4. §4：onForeground 无手势读取在默认策略下的弹窗表现；授权弹窗是否引发前后台重入；
5. §5-④：FormExtensionAbility 内 import pasteboard 的实际表现（编译期拦截 / 运行期 undefined / 错误码）——一条即可定案，投入以半小时为限。

## 9. 采信结论（给 Stage2）

- **采集主路径成立，但须换打法**：以 PasteButton + 分享接收 + 手势触发读取为主，READ_PASTEBOARD（ACL 受限）降为可选增强——即使 ACL 审批不过，V0.1 采集闭环仍成立。
- **分享接收须改 UTD 注册**（现 module.json5 的 MIME 写法预计收不到图片分享），URI 收到即复制入沙箱的路径有官方证据支撑。
- **桌面卡片不做直接读取**：按设计降级为"拉起主应用采集页"，零额外投入。
- **回前台不自动读**：默认"每次询问"策略下自动读 = 每次弹窗，交互上不可接受；回前台只提示、用户手势触发。
- 以上全部为文档口径；§8 清单回填真机数据后才允许宣称 G1 通过。
