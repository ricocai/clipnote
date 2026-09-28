# MD 阅读链路性能探测（S3-2 长文口径）

- 生成时间：2026-09-28T15:44:31.944Z
- 主机：Node v22.22.2（darwin/arm64）
- 语料：目标 ≥50,000 字，实际 62905 字符 / 161499 UTF-8 字节（确定性 LCG 生成）
- 产出：688 个块，渲染 HTML 70303 字符 / 168897 字节

| 阶段 | 次数 | 平均 | 最小 | 最大 |
|---|---:|---:|---:|---:|
| markdown-it parse + 桥接序列化（reader.tokenize） | 10 | 2.772 ms | 2.057 ms | 3.978 ms |
| mdTokensFromJson + parseDocument（ArkTS 块模型） | 10 | 3.568 ms | 3.055 ms | 4.2 ms |
| buildReaderHtml（渲染 HTML 构建） | 10 | 3.47 ms | 3.152 ms | 4.035 ms |

> 边界：本探测是主机基线：ArkWeb 与 Node 同为 V8 系内核，三段 CPU 耗时量级可参考；但首屏含 Web 内核排版/绘制、滚动流畅度含合成器帧率，只能真机实测。reader.html 已内建 window.__clipnotePerf（bridge.js 记录 renderMs/blocks/htmlBytes），真机打开 ≥5 万字笔记后读取该值即可；滚动帧率建议用 DevEco Profiler 观察。
