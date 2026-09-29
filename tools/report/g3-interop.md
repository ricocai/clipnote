# G3 主机侧互操作台架报告

- 日期：2026-09-29T07:17:44.066Z
- 环境：Node v22.22.2 / darwin 25.6.0 / arm64
- 栈：真 McpServer + StreamableHttpEndpoint + ClipNoteMcpDispatcher + AccessPolicy/PolicyGate（内存审计 sink）；TCP 为 Node `net` 适配器（localhost 明文，TLS 属鸿蒙适配器真机项 R-A）
- Host：mini Host 仿真 Cherry Studio（决议 M4：POST /mcp、自定义 Bearer Header、Accept: application/json, text/event-stream，完整 2025-11-25 生命周期）

## 场景结果

### ✅ S1 ≥100 次连续调用（混合 6 工具 + ping），零协议错误

- PASS：initialize 200 并签发 Mcp-Session-Id（status=200）
- PASS：协议版本锁定 2025-11-25
- PASS：notifications/initialized → 202
- PASS：tools/list 返回 6 个已授权工具
- PASS：≥100 次连续 tools/call 零协议错误（tools/call=120（成功=120，业务isError=0），ping=120，协议错误=0，耗时=31ms）
- PASS：审计轨迹全部 ok（连续调用无非授权拒绝）（审计记录=120）

### ✅ S2 断线恢复：kill TCP 后带原会话继续；未知会话 404 → 重新 initialize

- PASS：断线前调用正常
- PASS：kill TCP 后新连接带原 Mcp-Session-Id 继续调用成功
- PASS：未知/过期会话 → 404（Host 须重新 initialize）（status=404）
- PASS：重新 initialize 恢复（新会话可用）

### ✅ S3 未授权访问全拒绝（401 / -32002）

- PASS：无 Bearer → initialize 401（status=401）
- PASS：错误 Bearer → initialize 401（status=401）
- PASS：已认证但未授予工具 → JSON-RPC -32002（{"id":2,"error":{"code":-32002,"message":"tool not granted"}}）
- PASS：已授予工具仍可用（-32002 非传输故障）

### ✅ S4 撤销即时生效（revoke 后下一调用即拒）

- PASS：撤销前调用正常
- PASS：revoke 后下一调用即 -32002（{"id":3,"error":{"code":-32002,"message":"no grant for client"}}）
- PASS：撤销产生 denied 审计
- PASS：重新 grant 后恢复

### ✅ S5 Origin/Host 异常 → 403；超限体积 → 413

- PASS：Host 异常 → 403（status=403）
- PASS：Origin 异常 → 403（status=403）
- PASS：超限体积 → 413（status=413）

## 审计汇总

- 总记录 125：ok=123 / denied=2 / error=0（只记元数据，无正文无令牌）

## 结论

- **G3 主机侧台架全部通过（21/21 硬断言）**：连续调用零协议错误、断线恢复、401/-32002 全拒绝、撤销即时生效、403/413 安全闸均符合 design §8 G3 口径。
- **遗留真机项**：Cherry Studio 实机 ↔ 真机（HarmonyOS TLS 适配器 + 自签证书 TOFU）互操作复核；设备侧证书生成/轮换、SSE 心跳真机行为、Android/iOS Host 兼容不在本台架范围。
