# 拾记 ClipNote × LM Studio —— MCP 客户端配置说明书

> 适用版本：ClipNote（HarmonyOS）含 S6 局域网 MCP 服务端；LM Studio 0.3.17+（MCP Host 能力）。
> 本文给出「手机端开启服务 → 配对拿 Token → 在 LM Studio 配置连接」的完整流程与配置示例。

---

## 0. 拓扑与地址约定

本说明以你给的环境为例：

| 角色 | 设备 | 地址 |
|---|---|---|
| **MCP Server（服务端）** | 拾记 App 所在手机 | `192.168.43.1`（手机开的热点，自身即网关） |
| **MCP Host/Client（客户端）** | 你的 Mac | `192.168.43.9`（连上手机热点后分到） |

> 前提：Mac 必须连上手机热点（或同处一个二层局域网），且**手机与 Mac 互通**（`ping 192.168.43.1` 通）。
> 换网络后手机 IP 会变，服务地址随之变——以手机「设置 → MCP」页展示的地址为准。

---

## 1. 手机端（服务端）准备

拾记的 MCP 服务遵循**安全默认 = 默认拒绝**：

1. 打开拾记 App，进入 **设置 → MCP 局域网服务**，开启开关。
   - 该服务**默认关闭**，且**仅在 App 处于前台时监听**，退到后台即停止（设计口径）。
   - 开启即监听 `0.0.0.0:8765`。
2. 首次开启会自动生成一张**自签 TLS 证书**（RSA-2048，有效期 5 年）：
   - 主题 `CN=clipnote-device`
   - SAN 仅 `DNS:clipnote.local`，**不含任何 IP 地址**
   - 设置页会展示证书 **SHA-256 指纹**（分组形如 `AB:CD:…`），用于首次连接的 TOFU 核对。
3. 记下设置页显示的「本机连接地址」，形如 `https://192.168.43.1:8765`。

> 端点路径固定为 `/mcp`，即完整地址 `https://192.168.43.1:8765/mcp`。
> 传输语义为 **Streamable HTTP（2025-11-25 草案）**：`POST` + `Mcp-Session-Id` 头 + SSE 响应流，需要 `initialize` 握手（有状态）。服务端恒回协议版本 `2025-11-25`；发 2026-07-28 无状态语义会被拒。

---

## 2. 配对获取 Token（一次性，每次换证书需重做）

ClipNote 不做「匿名可连」。每个客户端必须先配对，拿到一次性 Bearer Token：

1. 手机设置页点 **「生成配对码」**，得到 6 位数字码（**5 分钟内有效**，错 5 次作废）。
2. 在 Mac 上用任意 HTTP 客户端向服务端发起配对（会**挂起/长轮询**，直到你在手机确认）：

   ```bash
   curl -k -X POST https://192.168.43.1:8765/pair \
     -H 'Content-Type: application/json' \
     -d '{"code":"<手机上显示的6位码>","clientName":"LM Studio Mac"}'
   ```

3. 手机端会**自动出现**「**待确认配对**」条目（显示 `LM Studio Mac` / 来源 IP `192.168.43.9`）——设置页已改为 MCP 运行期间每 1.2s 自动刷新挂起列表，无需手动点「刷新配对状态」；点 **确认**。
4. 确认后：
   - 上述 `curl` 返回 `{"status":"paired","clientId":"…"}`；
   - 手机弹出「配对成功」，**点「我要复制」即把一次性 Bearer Token 存入系统剪贴板**（弹窗文本不可选中/长按，必须用此按钮复制；Token 只显示这一次）。
   - 若复制失败（如剪贴板权限受限），弹窗提示「请手动长按选择令牌」，此时需从弹窗文本中手动选取。
5. 把该 Token 用于下一步 LM Studio 的 `Authorization` 头。

> **Token 时效与存活（重要，见 §5.5）**：名义有效期 **30 天**，但**本质是「会话级、随服务关停即作废」**——只要 App 进程重启、或 MCP 服务被关闭过一次（关开关 / 退后台停服 / App 重启），旧 Token **立即整体失效**，必须重新走一遍第 2 步配对。想「配一次、重启 App 后 LM Studio 还能接着用」当前**做不到**。

---

## 3. LM Studio 客户端配置（配置示例）

LM Studio 遵循 **Cursor 风格的 `mcp.json`** 写法。配置文件位置：

- macOS / Linux：`~/.lmstudio/mcp.json`
- Windows：`%USERPROFILE%\.lmstudio\mcp.json`

也可在 LM Studio 内：**Program 标签 → Install → Edit mcp.json** 打开内置编辑器。

### 配置示例（对应本环境）

```json
{
  "mcpServers": {
    "clipnote": {
      "url": "https://192.168.43.1:8765/mcp",
      "headers": {
        "Authorization": "Bearer <把第 2 步手机屏幕显示的 Token 粘到这里>"
      }
    }
  }
}
```

### 填好后

1. 保存文件 → LM Studio **自动加载**该 MCP Server。
2. 需在 **Server Settings** 中开启 **「Allow calling servers from mcp.json」**（否则不会调用）。
3. 模型调用 ClipNote 工具时，LM Studio 会弹出**工具调用确认框**（可逐项设为 `always allow`）。
4. 在聊天里让模型「查看/搜索我的笔记」即可触发；可用 LM Studio 的 MCP 状态面板确认 `clipnote` 已连接、`tools/list` 返回 6 个工具。

---

## 4. 验证连通（先排除服务端问题）

在 Mac 上先用 `curl` 验证握手与证书（不依赖 LM Studio）：

```bash
# -k 跳过证书校验，仅验证端点可达 + 看证书指纹
curl -k -i https://192.168.43.1:8765/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

- 返回 `200` 且带 `Mcp-Session-Id` 头 → 服务端正常，问题在客户端配置。
- 连接被拒/超时 → 检查手机是否前台、开关是否开、Mac 是否在同一热点。

---

## 5. ⚠️ 已知限制与排错（务必先读）

### 5.1 LM Studio 很可能**无法直连**本服务

根本原因在**服务端的 TLS 证书**，而非你的配置写错：

- 证书是**自签**的（非公共 CA 签发）→ 严格客户端会因「证书不受信任」拒绝握手；
- 证书的 SAN **只有 `clipnote.local`，不含 IP** → 即使忽略 CA，`https://192.168.43.1` 也会因「主机名不匹配」失败；
- LM Studio 的 `mcp.json` 目前**只暴露 `url` 与 `headers`**，**没有「跳过 TLS 校验 / 信任自签」开关**。

因此用 `https://192.168.43.1:8765/mcp` 直连时，LM Studio 大概率报：
`self signed certificate` / `Hostname/IP doesn't match certificate's altnames` / `certificate has expired or is not yet valid`。
**这些都不是配置写错，而是上述 TLS 限制。**

### 5.2 官方验证过的 Host 是 Cherry Studio / VS Code

拾记的设计决议（§4.5.3、传输选型）将 **Cherry Studio（首发）** 与 **VS Code（备选）** 列为已验证的 MCP Host——它们对「自签证书 + 局域网端点 + 自定义 Header」更宽容（可忽略证书、可填自定义 Header）。**LM Studio 不在官方验证列表中。**

### 5.3 可行的绕行方案（按推荐度）

1. **改用 Cherry Studio 或 VS Code 连接**（推荐，最稳）。两者均支持 Streamable HTTP + 自定义 Header + 忽略自签证书，配置写法与本节 `mcp.json` 示例一致。
2. **用 `clipnote.local` 主机名 + 本机 hosts（仍可能受自签 CA 限制）**：
   - Mac 上 `sudo sh -c 'echo "192.168.43.1 clipnote.local" >> /etc/hosts'`；
   - 把 LM Studio 的 `url` 改为 `https://clipnote.local:8765/mcp`（主机名对得上 SAN）；
   - 但仍需客户端**跳过 CA 校验**（自签），而 LM Studio 无此开关 → 多半仍不通，故该法主要供有「忽略证书」选项的客户端使用。
3. **本机反向代理（进阶）**：在 Mac 起一个本地 TLS 终止代理（如 Caddy / mitmproxy），对外呈现 LM Studio 信任的形态、对内转发到手机自签端点。涉及自签信任链与端口转发，**超出本说明书范围**，请自行评估安全性。

> 结论：若要「LM Studio 连拾记」真正跑通，最务实的路径是 **(a) 等 LM Studio 支持忽略自签/自定义 TLS 信任，或 (b) 用 Cherry Studio / VS Code 作为 Host**。本说明书的 `mcp.json` 示例在 TLS 不被拦截的客户端上是可直接生效的。

### 5.4 其它排查

- **App 退后台即断**：服务仅前台监听。连不上先确认手机亮屏且在前台、开关仍开。
- **开关/重装后指纹变化**：证书随「轮换证书」或沙箱清空而变；Token 按代际绑定，变了就重新配对（第 2 步）。
- **`401 missing or invalid bearer token`**：Token 错/过期/被轮换 → 重新配对。
- **`403 host or origin not allowed`**：Host 头不在白名单（白名单含 `clipnote.local` 与手机自身 IP）。**已知坑（已修）**：早期版本把 `wifiManager.getIpInfo().ipAddress` 当小端序解码，导致手机 IP 被显示/写入白名单成「八位组整体倒序」（如真实 `192.168.43.132` 变成 `132.43.168.192`），用真实 IP 直连就会 403。修复版改为大端解码后，直接 IP 直连应正常；若仍 403，先用 `clipnote.local` 兜住（见 5.3），并确认手机当前 IP 与白名单一致（UI 显示的地址应等于你访问的 IP）。
- **`404 unknown or expired session`**：会话过期，客户端会自动重新 `initialize`，无需人工处理。

### 5.5 Token 有效期与「跨重启 / 多次开关服务」行为（务必知悉）

**名义有效期：30 天。** 源码 `McpServiceCore.ts`：

```ts
const TOKEN_TTL_MS: number = 30 * 24 * 3600 * 1000;  // 30 天
```

从签发时刻 `issuedAtMs` 起算；30 天内须同时满足「未过期 + 未撤销 + 证书代际匹配」才有效。

**但 30 天只是上限，真正约束是「纯内存 + 关停即吊销」。** 源码事实：

1. **纯内存、不落盘**：`ClientCredentialStore` 用 `Map<string, StoredCredentialRecord>` 存储（`credentials.ts`），是 `McpServiceCore` 的成员变量，**不进 Preferences / 数据库**。App 进程一死，此 `Map` 直接消失。
2. **关服务即全量吊销**：`McpServiceCore.stop()` 在关停时执行 `policy.revokeAll()` 并逐条 `credentials.revoke(...)`，把内存里所有 Token 清掉。
3. **证书代际不强制变化（这条是好事，但被上面盖过）**：每次 `start()` 走 `certificateAuthority.current()`（读持久 `meta.json`），**不会** `rotate()`，所以「重开服务」本身不会因证书代际变化让旧 Token 失效——但内存清空 + stop 吊销已在前面两关把它杀了。

**现实结论（速查表）**：

| 场景 | 旧 Token 是否还有效 |
|---|---|
| App 多次**重启** | ❌ 失效（内存清空，必须重新配对） |
| 多次**关闭再开启** MCP 服务（关开关 / 退后台停服） | ❌ 失效（stop 全量吊销，必须重新配对） |
| App 没被杀、MCP 服务**一直运行未 stop**、且未超 30 天 | ✅ 有效（同一进程内 `Map` 还在、未吊销未过期） |

**对 LM Studio 用户的实操含义**：

- 如果你把 Mac 合盖睡眠、手机退后台、或手机 App 被杀，下次回来 LM Studio 报 `401` 是**预期行为**，不是配置坏了——重走第 2 步配对即可。
- 若希望「配一次、跨重启长期可用」，当前实现不支持。需服务端做两处改造（属有意的安全设计，是否改需拍板）：
  1. `ClientCredentialStore` 改为持久化到 Preferences / 数据库；
  2. `McpServiceCore.stop()` 不再全量 `revoke`（或仅清会话、保留凭证）。
  该改造尚未排期，如需请在项目里提需求。

---

## 6. 工具清单（首发 6 个）

经配对授权后，客户端 `tools/list` 可拿到以下工具（受 AccessPolicy 每客户端授权约束，可在手机配对确认页管理）：

| 工具名 | 作用 |
|---|---|
| `search_notes` | 关键词搜索笔记 |
| `get_note` | 读取单篇笔记全文 |
| `create_note` | 新建笔记 |
| `append_to_note` | 向已有笔记追加内容（带应用级幂等键） |
| `delete_note` | 删除笔记（软删，进垃圾桶） |
| `list_tags` | 列出标签 |

---

## 7. 安全与生命周期提示

- **默认拒绝 + 前台监听**：不上不发，退后台即关，配对码退后台即失效——滥用面受控。
- **Token 即凭证**：只在手机确认瞬间以明文出现一次，请妥善保管；不要提交进仓库或贴到公开处。
- **TOFU 核对**：首次连接建议核对手机设置页展示的证书指纹，防止中间人。
- **撤销**：手机端可随时「撤销该客户端」或「全部撤销」，撤销后对应 Token 立即失效。
- **证书轮换**：轮换会使所有已配对客户端掉线，需重新配对（设计「更新后重建信任」）。

---

*本说明书参数均取自 ClipNote 源码事实：端口 `MCP_PORT=8765`（`McpService.ets`）、端点 `/mcp` 与 `POST /pair` 长轮询（`endpoint.ts`/`server.ts`）、Bearer 鉴权（`server.authenticate`）、自签证书 SAN=`[clipnote.local]` 且无 IP（`harmony-certificate-authority.ets`）、6 工具（`dispatcher.ts`）、LM Studio 配置格式（`~/.lmstudio/mcp.json`，Cursor 风格 `url`+`headers`）。*
