# MCP 协议版本锁定决议

生成时间：2026-09-28（WHY-92 / S1-4 任务 2，落地设计 §4.5.1 决策表）
状态：**已锁定**，供 S6 阶段（Stage 6 MCP 通道）实现与 G3 验收直接引用；锁定后变更须走设计变更流程。

## 决议摘要

| 事项 | 锁定值 |
|---|---|
| **首发 Host** | **Cherry Studio**（桌面客户端，当前 v2.1.3） |
| **备选 Host** | VS Code（`mcp.json` type:http，当前稳定版 1.139.1） |
| **协议版本** | **2025-11-25**（握手型，有状态）——在 `IMcpAdapter.lockedProtocolVersion()` 显式返回此字符串 |
| **传输方式** | **Streamable HTTP（2025-11-25 语义）**：POST + `Mcp-Session-Id` 头 + SSE 响应流；不实现旧 HTTP+SSE 独立传输，不实现 2026-07-28 无状态语义 |
| **能力范围** | 首发工具集合即 `mcp/Index.ets` 冻结的 6 个工具；Resources/Prompts 不预置（§4.5.1） |

## 规范现状核实（2026-09-28）

- 规范最新正式版即 **2026-07-28**（其 RC 为 2026-05-21），**此后无更新日期版本**；直接前驱为 2025-11-25。命名规则为日期版本 `specification/YYYY-MM-DD`，无 semver、"MCP 2.0"只是 SDK 主版本号而非规范名。
- 2026-07-28 变更**逐条复核通过**（一手 changelog 全文）：移除 `Mcp-Session-Id` 与协议级会话（SEP-2567）；移除 `initialize` 握手改无状态、每请求 `_meta` 声明版本、版本不匹配返回 `UnsupportedProtocolVersionError(-32022)`（SEP-2575）；新增 `server/discover`；移除 SSE 流恢复（`Last-Event-ID`）；HTTP+SSE 旧传输归类 Deprecated。
- 官方 SDK 现状：`@modelcontextprotocol/sdk` v1 线 1.30.1（2026-09-23，仍为 2025-11-25 代）；**v2 线已 stable**（`@modelcontextprotocol/client` 2.0.0 于 2026-07-27 转 stable，2.1.0 于 2026-09-23，对应 2026-07-28 stateless）；PyPI `mcp` 2.2.0 对应 v2。

## 候选 Host 评估（局域网可达性是硬门槛）

ClipNote 是局域网 MCP **Server**（手机监听，桌面 Host 连接），因此 Host 必须能**手动添加 `http://192.168.x.x` 自定义端点**。

| Host | 直连局域网端点 | Streamable HTTP | 协议代际（证据） | 活跃度 | 结论 |
|---|---|---|---|---|---|
| **Cherry Studio** | ✅ 手动添加 streamableHttp URL + 自定义 Header | ✅（2025-04 起） | 2025-11-25（依赖 `@modelcontextprotocol/sdk` 1.27.1，`main` 分支 package.json 实测） | ✅ 极活跃（v2.1.3，2026 年连续发版） | **首发** |
| **VS Code** | ✅ `mcp.json` `type:"http"` 任意 URL | ✅（2025-05 起） | 2025-11-25 为主；2026-07-28 跟进未证实（内部自有客户端实现） | ✅（1.139.1，2026-09-23） | **备选/第二联调目标** |
| LibreChat | ✅（streamable-http 配置） | ✅ | 未显式声明 | ✅（v0.8.6，2026-05） | 多端回归参考 |
| Open WebUI | ✅ | ✅ 仅 Streamable HTTP（v0.6.31+） | 未显式声明 | ✅ 极活跃 | 多端回归参考 |
| Claude Desktop | ❌ 远程必须经 Anthropic 云端 Custom Connectors，需公网 HTTPS + OAuth；`claude_desktop_config.json` 写 `url` 被静默丢弃 | ✅（仅云中转） | 未公开 | ✅ | **否决**（架构上不可达局域网） |
| 5ire | ✅ | ✅ | — | ❌ v0.15.4（2026-03-18）后停更，且有 CVE-2026-22792 | 淘汰 |

## 锁定理由

1. **协议版本锁 2025-11-25**：首发 Host（Cherry Studio）与备选 Host（VS Code）的客户端实现均处于 2025-11-25 代际，其 `initialize` 协商行为（客户端声明最新支持版本、服务器回退自己版本、不匹配则断开）已稳定实现多年。锁定 2026-07-28 将导致首发 Host 全部握手失败，直接违反 §4.5.1"以目标 Host 实测支持为准"。
2. **传输锁 Streamable HTTP**：旧 HTTP+SSE 独立传输已被规范 Deprecated；WSS 仅保留为自有隧道内部协议（§4.5.1）。2025-11-25 语义的 Streamable HTTP（单端点、SSE 响应、`Mcp-Session-Id`）是 Cherry Studio / VS Code 的实际实现路径。
3. **演进路径留口**：适配层按 `IMcpAdapter` 隔离，协议版本字符串单点返回（`lockedProtocolVersion()`），未来 Host 生态跟进 2026-07-28 时只需新增一个适配实现 + 传输语义切换，不动工具契约与授权语义（§4.5.5 不随协议变化）。

## 否决项记录

| 否决项 | 理由 |
|---|---|
| 首发协议选 2026-07-28 | 无首发 Host 支持（SDK v2 刚转 stable 一个月），G3 联调当场失败；属演进方向而非首发基线 |
| 传输选旧 HTTP+SSE | 规范已 Deprecated；Cherry Studio / VS Code 均优先 Streamable HTTP |
| Claude Desktop 作首发 Host | 远程连接强制云端 Custom Connectors 中转，局域网端点不可达；笔记正文须出设备上公网，与"数据默认不出设备"安全目标冲突 |
| 5ire | 近 6 个月无 release + CVE-2026-22792，不满足活跃度门槛 |
| WSS 作为对外传输 | 设计已定：仅作自有隧道/代理内部协议，不对 Host 暴露 |
| 自研完整 HTTP/TLS 栈 | §4.5.3 已有结论：优先移植成熟实现，本决议不 reopened |

## 实现与验收注记（给 Stage 6 / G3）

- 服务端 `protocolVersion` 字段显式返回 `"2025-11-25"`；`initialize` 回退协商按 2025-11-25 lifecycle 规范实现（不支持 `-32002` 以外自创码）。
- G3 联调顺序：Cherry Studio 主验（配对、证书、工具级授权、撤销、≥100 次连续调用）→ VS Code 复验互操作。
- **重评估触发条件**（满足任一即重开 §4.5.1）：① Cherry Studio 或 VS Code 任一升级至 2026-07-28 代 SDK 并发版；② 规范发布晚于 2026-07-28 的新日期版本；③ G3 联调发现锁定版本与 Host 实测不符。
- 联调时以抓包确认各 Host 实际声明的 `protocolVersion`（其代码未显式暴露，本决议表格中 Host 代际为 SDK 依赖推断，置信中高）。

## 证据来源

| # | 结论 | 来源 | 置信度 |
|---|---|---|---|
| M1 | 最新规范 2026-07-28、changelog 全部条目 | modelcontextprotocol.io/specification/2026-07-28/changelog（一手全文）；官方博客 2026-07-28 | 高 |
| M2 | 版本命名与时间线 | skycloak.io 分析（2026-09-11）；hidekazu-konishi.com 版本时间线（2026-07-26） | 高 |
| M3 | SDK 版本（TS v1 1.30.1 / v2 2.1.0、PyPI 2.2.0、C# 2.0） | npm registry / PyPI 一手查询；devblogs.microsoft.com（2026-07-28） | 高 |
| M4 | Cherry Studio 传输支持、SDK 1.27.1、v2.1.3 发版 | github.com/CherryHQ/cherry-studio releases；main 分支 package.json 实测；jishuzhan.net 教程（2025-04） | 高 |
| M5 | VS Code MCP 与 streamable HTTP 时间线、1.139.1 | code.visualstudio.com MCP 指南（2026-09-09 更新）与 updates 页；@code 推文（2025-05-08） | 高（2026-07-28 跟进状态未证实） |
| M6 | Claude Desktop 云端 Connectors 限制 | claude.com/docs/connectors（2026-09-25）；startdebugging.net（2026-05-28）；mcpverdict.com（2026-06） | 高 |
| M7 | LibreChat / Open WebUI 支持矩阵 | librechat.ai docs / changelog（v0.8.6）；docs.openwebui.com MCP | 高 |
| M8 | 5ire 停更与 CVE | github.com/nanbingxyz/5ire releases；sentinelone.com CVE-2026-22792 | 高 |
| M9 | 2025-11-25 协商规则 | modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle（一手全文） | 高 |
