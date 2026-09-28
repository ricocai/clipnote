/**
 * MD 阅读链路性能探测（S3-2；设计 §8 性能口径：长文 ≥5 万字首屏与滚动流畅度）。
 *
 * 测量的是**真实交付链路**的三段（不是替身）：
 *   1. reader.tokenize          — ArkWeb 内 markdown-it 解析 + 桥接 Schema 序列化
 *                                 （Node/V8 主机基线；ArkWeb 同为 V8 系内核，量级可参考，
 *                                  但首屏真机数字必须以设备为准 —— 见报告「边界」节）；
 *   2. mdTokensFromJson + parseDocument — ArkTS 块模型构建（鸿蒙侧同一份 ArkTS 代码）；
 *   3. reader.buildReaderHtml   — 渲染 HTML 构建（Web 内执行的同一份 JS）。
 *
 * 阅读页首屏耗时 = 1 + 2 + 3 + Web 内核排版/绘制；其中 4 只能在真机测，
 * reader.html 已内建 window.__clipnotePerf（bridge.js 计时），真机侧一行可读。
 *
 * 产出：tools/report/md-reader-perf.json + md-reader-perf.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import MarkdownIt from 'markdown-it';

import { parseDocument, mdTokensFromJson } from '../../common/src/main/ets/core/markdown';
import { MarkdownItTokenizer } from '../test/support/platform';

const READER_DIR = path.join(__dirname, '..', '..', '..', '..', 'entry', 'src', 'main', 'resources', 'rawfile', 'reader');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const reader = require(path.join(READER_DIR, 'reader.js')) as {
  tokenize: (source: string) => string;
  buildReaderHtml: (blocks: unknown[], markdown: string) => string;
};
(globalThis as Record<string, unknown>)['markdownit'] = MarkdownIt;

// ---------------------------------------------------------------------------
// 语料：确定性生成 ≥5 万字长文（标题/段落/列表/代码/表格/引用混合）
// ---------------------------------------------------------------------------

class Lcg {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

const SENTENCES: string[] = [
  '剪贴板采集在前台授权下进行，分享接收与一键粘贴构成多入口矩阵。',
  'Markdown 单一解析入口保证屏幕、朗读与导出内容一致。',
  '附件经内容寻址存储，路径完全由摘要派生，天然无越界风险。',
  '渲染隔离要求不可信内容默认禁脚本，远程资源一律收敛。',
  '块模型携带源范围，编辑器与朗读高亮可以双向映射。',
  '备份强调可读导出不等于可恢复备份，恢复先校验暂存再导入。',
  '中文检索采用二字 gram 倒排，增删改后索引保持一致。',
  '回收站语义是软删除，GC 必须经宽限期并二次确认。',
  '离线朗读优先系统引擎，端侧模型以真机实测择一。',
  '性能口径是不一次载入全库，列表与阅读都受分页约束。',
];

const CODE_LINES: string[] = [
  'const note = await noteService.getById(id);',
  'const blocks = parseDocument(tokenizer, md, { docRevision: rev });',
  'await blobCas.putBytes(bytes);',
  'logger.info("note_saved", { id: note.id });',
];

function buildLongDoc(targetChars: number): string {
  const rng = new Lcg(20260928);
  const parts: string[] = ['# 长文性能样本：采集系统设计纪要\n'];
  let chars = 0;
  let section = 0;
  while (chars < targetChars) {
    section += 1;
    parts.push(`\n## 第 ${section} 节 主题 ${rng.pick(['采集', '渲染', '检索', '备份', '朗读'])}`);
    const paragraphs = 3 + Math.floor(rng.next() * 4);
    for (let p = 0; p < paragraphs; p++) {
      const n = 3 + Math.floor(rng.next() * 4);
      let para = '';
      for (let s = 0; s < n; s++) {
        para += rng.pick(SENTENCES);
      }
      parts.push(`\n${para}`);
      chars += para.length;
    }
    if (section % 3 === 0) {
      parts.push('\n- 要点一：授权边界清晰');
      parts.push('- 要点二：失败提示如实');
      parts.push('- 要点三：不预付复杂度');
      parts.push('\n```ts\n' + CODE_LINES.join('\n') + '\n```');
      parts.push('\n| 指标 | 口径 | 边界 |');
      parts.push('|---|---|---|');
      parts.push('| 首屏 | 解析+渲染 | 真机实测 |');
      parts.push('| 滚动 | content-visibility | 真机实测 |');
      parts.push('\n> 整段引用保留原文，渲染不猜测语义。');
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// 计时
// ---------------------------------------------------------------------------

function bench(label: string, runs: number, fn: () => void): { label: string; runs: number; meanMs: number; minMs: number; maxMs: number } {
  // 预热一次（JIT 稳态）
  fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  const meanMs = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { label, runs, meanMs: Number(meanMs.toFixed(3)), minMs: Number(Math.min(...samples).toFixed(3)), maxMs: Number(Math.max(...samples).toFixed(3)) };
}

function main(): void {
  const md = buildLongDoc(50_000);
  const tokenizer = new MarkdownItTokenizer(new MarkdownIt({ html: true }));

  const timings = [
    bench('markdown-it parse + 桥接序列化（reader.tokenize）', 10, () => {
      reader.tokenize(md);
    }),
    bench('mdTokensFromJson + parseDocument（ArkTS 块模型）', 10, () => {
      const payload = reader.tokenize(md);
      const tokens = mdTokensFromJson(payload);
      parseDocument({ parse: () => tokens }, md, { docRevision: 1 });
    }),
    bench('buildReaderHtml（渲染 HTML 构建）', 10, () => {
      const tokens = mdTokensFromJson(reader.tokenize(md));
      const blocks = parseDocument({ parse: () => tokens }, md, { docRevision: 1 });
      reader.buildReaderHtml(blocks as unknown[], md);
    }),
  ];

  const tokens = mdTokensFromJson(reader.tokenize(md));
  const blocks = parseDocument({ parse: () => tokens }, md, { docRevision: 1 });
  const html = reader.buildReaderHtml(blocks as unknown[], md);

  const report = {
    generatedAt: new Date().toISOString(),
    host: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      markdownIt: '14.x',
    },
    corpus: { targetChars: 50_000, actualChars: md.length, utf8Bytes: Buffer.byteLength(md, 'utf8') },
    output: { blocks: blocks.length, htmlChars: html.length, htmlUtf8Bytes: Buffer.byteLength(html, 'utf8') },
    timings,
    boundary:
      '本探测是主机基线：ArkWeb 与 Node 同为 V8 系内核，三段 CPU 耗时量级可参考；' +
      '但首屏含 Web 内核排版/绘制、滚动流畅度含合成器帧率，只能真机实测。' +
      'reader.html 已内建 window.__clipnotePerf（bridge.js 记录 renderMs/blocks/htmlBytes），' +
      '真机打开 ≥5 万字笔记后读取该值即可；滚动帧率建议用 DevEco Profiler 观察。',
  };

  fs.mkdirSync(path.join(process.cwd(), 'report'), { recursive: true });
  const jsonPath = path.join(process.cwd(), 'report', 'md-reader-perf.json');
  const mdPath = path.join(process.cwd(), 'report', 'md-reader-perf.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const lines: string[] = [];
  lines.push('# MD 阅读链路性能探测（S3-2 长文口径）');
  lines.push('');
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 主机：Node ${report.host.node}（${report.host.platform}）`);
  lines.push(`- 语料：目标 ≥50,000 字，实际 ${report.corpus.actualChars} 字符 / ${report.corpus.utf8Bytes} UTF-8 字节（确定性 LCG 生成）`);
  lines.push(`- 产出：${report.output.blocks} 个块，渲染 HTML ${report.output.htmlChars} 字符 / ${report.output.htmlUtf8Bytes} 字节`);
  lines.push('');
  lines.push('| 阶段 | 次数 | 平均 | 最小 | 最大 |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const t of timings) {
    lines.push(`| ${t.label} | ${t.runs} | ${t.meanMs} ms | ${t.minMs} ms | ${t.maxMs} ms |`);
  }
  lines.push('');
  lines.push(`> 边界：${report.boundary}`);
  lines.push('');
  fs.writeFileSync(mdPath, lines.join('\n'));

  console.log(lines.join('\n'));
}

if (require.main === module) {
  main();
}
