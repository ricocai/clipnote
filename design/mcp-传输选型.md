# MCP 传输选型（S6-2 spike 结论）

生成时间：2026-09-28（WHY-110 / S6-2 任务 1）
状态：**已决议**，供 S6-2 实现、S6-3 协议适配与 G3 验收直接引用；变更须走设计变更流程。
输入决议：`design/mcp-协议版本锁定决议.md`（协议 2025-11-25、Streamable HTTP、首发 Host Cherry Studio）。

## 1. 结论摘要

| 事项 | 决议 |
|---|---|
| HTTP 服务端 | **受限子集 HTTP/1.1 服务端自研**（ArkTS，mcp HAR core 层，零平台依赖可本机单测），跑在系统 `socket.TCPSocketServer` 上 |
| TLS | **系统 TLS 栈**（`socket.TLSSocketServer`，API 12+），**不自研 TLS**，不以关闭证书校验作为交付方案 |
| 证书 | 首次启用时设备侧生成自签 EC(P-256) 证书：cryptoFramework 密钥对 + 手写 ASN.1/DER 编码 + 系统 Sign 自签名，PEM 供 TLSSocketServer 加载 |
| 信任模型 | 指纹人工比对 TOFU（手机端展示 SHA-256 指纹）+ 配对码门控注册 + 每客户端高熵凭证绑定证书代际（轮换即失效重建信任） |
| 前台约束 | 服务端生命周期挂接 App 前后台：仅前台监听，退后台即关闭 |
| 桌面伴随桥 | **否决**（维持 §4.5.3 口径：桥接不是零成本保底，且 G3 目标是手机被 Host 直连） |

## 2. 候选方案评估

### 2.1 移植成熟 HTTP Server 实现 —— 生态无对象，否决

设计 §4.5.3 要求"优先评估可维护的成熟实现移植"，评估结果：

- **官方无 HTTP Server API**：HarmonyOS NetworkKit 只有客户端（`@ohos.net.http` / `rcp`）；服务端只有 socket 原语（TCP/UDP/TLS Socket Server）。
- **ohpm/OpenHarmony 三方仓无成熟 http-server 库**：社区问答明确"HarmonyOS Next 目前并未直接提供 http-server 的三方库"，需要 socket 层自实现（来源见 §5 E1）。
- **C/C++ 移植路线（mongoose/llhttp/libevent 经 NDK）**：本工程无 Native C++ 构建基建，引入交叉编译工具链 + 双端调试的成本远超受限子集自研；且 llhttp 只是解析器，不解决 socket/TLS/会话编排。
- **社区 MCP 参考实现（ohosvscode/mcp）**：stdio 型 ArkTS server，与局域网 HTTP 传输无关，仅证明 ArkTS 写 JSON-RPC 可行。

结论：**"移植"在本生态没有可移植对象**；V1.4 §4.5.3 的"自研完整 HTTP/TLS 栈"否决项针对的是全栈自研（含 TLS），本次自研范围刻意受限（见 §3），不 reopened 该否决项。

### 2.2 系统 socket + 受限子集 HTTP —— 采纳

- `socket.TCPSocketServer`（API 10+）监听局域网地址；`socket.TLSSocketServer`（API 12+）加载 PEM key/cert 做服务端 TLS（系统 mbedTLS 栈）。
- 自研面收敛为：**HTTP/1.1 请求解析**（请求行/头/Content-Length 体）、**响应编码**（定长 + chunked/SSE 帧）、**单端点 `/mcp` 会话编排**。这是 MCP Streamable HTTP 的唯一需求面，不含通用 Web 服务特性（路由、静态文件、分块请求体、cookies 等一律不做）。
- 解析语义对照 RFC 7230 与 Node llhttp 行为；领域代码放 `mcp/src/main/ets/core/*.ts`，零 `@kit.*`，沿用 common 的"本机 tsc + node --test 全量验证"纪律。

### 2.3 桌面伴随桥 —— 否决（维持设计口径）

桌面桥把 TLS/HTTP 难题转移到桌面进程，但引入第二端分发、维护与信任传递成本；§4.5.3 已定为"非零成本保底"。G3 目标 Host（Cherry Studio）直连手机，桥接不进入首发路径。

## 3. 实现边界（防范围蔓延清单）

**做**：POST/GET/DELETE `/mcp`；`Mcp-Session-Id` 签发与校验；SSE 响应流（`text/event-stream`）与 standalone JSON 双模式；`Origin` 与 `Host` 匹配检查（规范 DNS rebinding 防护要求）；请求体积上限；单连接顺序处理（keep-alive，不支持管线化）；配对端点与凭证校验；局域网地址绑定（`0.0.0.0` + 仅服务 RFC1918/回环 peer 拒答公网来源不做——绑定即局域网网卡地址，由 UI 展示实际地址）。

**不做**（明确排除）：HTTP 管线化、chunked 请求体、100-continue 之外的 Expect、多路复用/HTTP2、静态文件、反向代理、WSS 对外（仅自有隧道内部协议，§4.5.1）、客户端证书（mTLS）、OAuth 授权服务器（首发用 Bearer 凭证 + 配对码）。

## 4. TLS/TOFU 信任闭环设计

设计 §4.5.3 G3 验证点 2/3 的落地形态：

1. **证书**：首次启用局域网服务时生成自签证书（ECDSA P-256 + SHA-256，~5 年有效期），私钥不出设备（cryptoFramework/HUKS 生成，PEM 仅落应用沙箱供 TLSSocketServer 加载）。
2. **指纹钉扎 TOFU**：服务页展示证书 SHA-256 指纹（分组十六进制）；用户在 Host 侧核对首次连接指纹（Cherry Studio 的证书展示/跳过校验行为以 G3 联调实测为准并记录）。
3. **配对码门控**：`POST /pair` 携带 6 位配对码（5 分钟有效、5 次尝试限速、退后台即失效）；配对请求挂起等待**手机端配对确认 UI** 人工确认；确认后签发 `clientId` + 高熵 Bearer token（≥128 bit）。
4. **凭证生命周期**：token 绑定签发时的证书代际；支持过期（默认 30 天可续）与撤销；**证书轮换后旧代际凭证全部拒绝**，客户端必须重新配对——即"更新后重建信任"。
5. **异常拒答**：未知会话 404（规范：客户端必须重新 initialize）；`MCP-Protocol-Version` 头与协商不符 400；Origin/Host 不符 403；未授权 401；超限 413/429。

## 5. 证据来源

| # | 结论 | 来源 | 置信度 |
|---|---|---|---|
| E1 | HarmonyOS Next 无官方/三方 http-server 库，需 socket 自实现 | [itying 社区问答](https://bbs.itying.com/topic/6764e3e6ad669d01bf7334b8)；[ohpm 中心仓](https://ohpm.openharmony.cn/)检索 | 高 |
| E2 | `TLSSocketServer`（API 12+）支持 PEM key/cert 服务端 TLS | [CSDN TLS 服务端流程（API 12）](https://laval.csdn.net/66e14e4b59bcf8384a5ca33d.html)；[TLS 回声服务器示例](https://blog.csdn.net/wqad23256/article/details/144160623)；[OpenHarmony socket 文档](https://gitee.com/openharmony/docs/blob/7fb24fcec0fd36a765feecec515b8cb597ff8240/zh-cn/application-dev/connectivity/socket-connection.md) | 高 |
| E3 | Streamable HTTP 2025-11-25：单端点 POST/GET/DELETE；会话可选、404 即重建；`MCP-Protocol-Version` 不符 400；Origin 校验 | [规范 Transports（一手）](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)；[hidekazu-konishi 测试指南](https://hidekazu-konishi.com/entry/mcp_server_testing_and_debugging_guide.html)；[LibreChat #11868](https://github.com/danny-avila/LibreChat/issues/11868) | 高 |
| E4 | Cherry Studio 支持 streamableHttp 自定义 URL + 自定义 Header（配对码/凭证的载体） | 协议锁定决议 M4（WHY-92 一手实测 main 分支 package.json） | 高 |
| E5 | 设备侧自签证书无公开 cert-builder 框架，路径为 cryptoFramework 密钥 + 手写 DER + Sign | cert framework / HUKS 公开 API 面检索（无 X509CertBuilder）；OpenHarmony 证书体系（RFC5280）仅有签名工具链非运行时 API | 中（**真机验证项**：证书生成与 TLSSocketServer 加载须在 G3 前真机跑通） |

## 6. 工作量重估

WBS §7「一个 MCP 通道」预算 8~12 人日。按本决议拆分：

| 子项 | 估（人日） | 说明 |
|---|---:|---|
| 受限子集 HTTP/1.1 + Streamable HTTP 会话（core，含本机用例） | 3~4 | 解析器/帧编码/会话编排，本机可全量验证 |
| TLS/证书/配对/凭证（core + 鸿蒙适配器） | 2~3 | 适配器含证书生成，真机验证占其中 ~1 |
| 鸿蒙 socket 适配器 + 前台生命周期接线 + 配对确认 UI | 1~2 | entry 最薄装配层 |
| G3 联调（Cherry Studio 实测、抓包、证书行为记录） | 2~3 | 人工/真机依赖，不在本任务内 |
| **合计** | **8~12** | 与 WBS 一致，不突破 |

风险与缓解：

- **R-A 设备侧证书生成路径未真机验证**（E5 置信中）→ 缓解：证书层抽象为端口，鸿蒙适配器失败时服务降级为"不启动 + UI 明示"，绝不静默退回明文 HTTP；G3 前真机探测先行。
- **R-B Host 对自签证书的 UX 行为未知**（Cherry Studio 是否展示指纹/能否跳过校验）→ G3 联调抓包确认，必要时输出 Host 侧配置指引；不为此改协议。

## 7. 实测结论追记（2026-10-07，API 26 模拟器端到端）

R-A 已收口，三条平台实测事实（适配器文件头有同源记录，勿回退）：

1. **netstack TLS 服务端不支持 EC 私钥**（决议级变更）：`tls_context_server.cpp`
   的 `SetKeyAndCheck` 只有 RSA/DSA 分支，EC 私钥解析正常但装不进 SSL_CTX，
   `SSL_CTX_check_private_key` 必失败（日志 "Check if the certificate matches
   the private key is error"），握手挂死。**TLS 材料从 ECC P-256 改 RSA 2048**：
   cryptoFramework `createAsyKeyGenerator('RSA2048')` + `createSign('RSA2048|PKCS1|SHA256')`，
   私钥经 `priKey.getEncodedPem('PKCS8')` 直接产 PEM，公钥成分经
   `getAsyKeySpec(RSA_N_BN/RSA_PK_BN)` 取 bigint。core/x509-selfsign.ts 的签名端口
   按算法种类分派（`keyAlgorithm()`），EC 路径保留（本机 node 测试覆盖）。
   指纹算法不变（证书 DER 的 SHA-256），协议与配对流程不受影响；已配对设备升级后
   因密钥类型变化需重新配对（指纹改变，TOFU 语义正确）。
2. **socket 数据事件名是 'message' 而非 'data'**（SocketMessageInfo
   { message, remoteInfo }），连接对象无 remoteAddress 属性，对端地址随 message
   事件 remoteInfo 到达；'close'/'error' 事件名与 d.ts 一致。
3. **netstack 对 send 实参做原生类型检查**：`ArrayBuffer.prototype.slice` 的产物
   通不过（"first param is not string or arraybuffer"），须显式
   `new ArrayBuffer + Uint8Array 拷贝`；且 TLS 连接 `send(ArrayBuffer)` 直收数据，
   与 TCP 连接 `send(TCPSendOptions)` 对象形态不同。

端到端验证：模拟器（OpenHarmony 7.0.0.105, sdkApi=26）上 MCP 服务启动
（`mcp.server.started`），`curl -k https://127.0.0.1:8765/`（hdc fport）TLS 握手成功、
收到真实 HTTP 404 `{"error":"not found"}`（裸 GET 无配对属预期拒绝）；openssl 核对
证书为 rsaEncryption + sha256WithRSAEncryption，指纹与设置页 TOFU 展示逐位一致。
- **R-C 前台即停语义与 Host 重连风暴** → 退后台关闭服务即 404/连接断开，Host 必须重新 initialize（规范内行为）；配对码退后台失效，控制滥用面。
