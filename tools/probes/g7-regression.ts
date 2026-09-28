/**
 * G7 落库回归（S3-4）：用 S1-3 探测**同一语料与查询集**（buildCorpus/buildQuerySet 直接复用
 * g7-search.ts，种子不变）验证生产检索路径 —— schema V2 迁移 + 触发器同步 + SearchRepository ——
 * 的召回/精确率不低于探测基线（g7-search-probe.json 中 s3_fts5_trigram，短查询取 s0_like_scan）。
 *
 * 与探测的口径差异（显式登记）：
 *  - 探测 s3 对 <3 字符查询直接返回 0 命中（把回退计入同表）；落库版走 LIKE 兜底，真实命中，
 *    因此短查询基线取 s0（LIKE ground truth）而不是 s3 的 0%；
 *  - 真值语义不变：title LIKE OR content LIKE（LIKE 子串），与探测一致。
 *
 * 产出：tools/report/g7-search-regression.json + g7-search-regression.md；
 * 任一用例召回/精确率低于基线时进程退出码非 0（可直接作验收门槛）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { QueryCase, buildCorpus, buildQuerySet } from './g7-search';
import { SchemaMigrator } from '../../common/src/main/ets/core/data/migrator';
import { NoteRepository } from '../../common/src/main/ets/core/data/note-repository';
import { SearchRepository } from '../../common/src/main/ets/core/data/search-repository';
import { transact } from '../../common/src/main/ets/core/data/rdb';
import { NoteSource } from '../../common/src/main/ets/core/model';
import { NodeSqliteExecutor } from '../test/support/sqlite-executor';
import { CapturingLogger, FixedClock } from '../test/support/platform';
import { IRandom } from '../../common/src/main/ets/core/ports';

/** 确定性伪随机（LCG，同 g7-search.ts 口径）：10k 语料下保证 id 唯一且可复现 */
class LcgRandom implements IRandom {
  private state: number = 20260928;
  nextBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      this.state = (this.state * 1664525 + 1013904223) >>> 0;
      // 取 state 的不同字节位，避免低字节独立循环导致窗口重复
      out[i] = (this.state >>> (8 * (i & 3))) & 0xff;
    }
    return out;
  }
}

const RUNS_PER_QUERY: number = 12;
const CORPUS_SIZES: readonly number[] = [1000, 10000];
/** 回归要拿全量结果集（与探测一致，不做 top-N 截断） */
const FULL_LIMIT: number = 100000;

interface BaselineRow {
  readonly recall: number;
  readonly precision: number;
}

interface ProbeBaseline {
  /** key: `${size}:${label}` */
  readonly rows: Map<string, BaselineRow>;
}

/** 读取 S1-3 主机探测报告作为基线（s0 / s3 的逐用例召回精确率） */
function loadBaseline(reportPath: string): ProbeBaseline {
  const raw = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
    corpora: Array<{
      size: number;
      strategies: Array<{ name: string; perQuery: Array<{ label: string; recall: number; precision: number }> }>;
    }>;
  };
  const rows = new Map<string, BaselineRow>();
  for (const corpus of raw.corpora) {
    for (const strategy of corpus.strategies) {
      if (strategy.name !== 's0_like_scan' && strategy.name !== 's3_fts5_trigram') {
        continue;
      }
      for (const q of strategy.perQuery) {
        rows.set(`${strategy.name}:${corpus.size}:${q.label}`, { recall: q.recall, precision: q.precision });
      }
    }
  }
  return { rows };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function hrms(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

function fileBytes(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function tempDbPath(tag: string): string {
  const dir = path.join(process.cwd(), '.g7-tmp');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${tag}.db`);
}

// ---------------------------------------------------------------------------
// 语料装载：走生产路径（迁移 → NoteRepository.create → 触发器建索引）
// ---------------------------------------------------------------------------

interface LoadedCorpus {
  readonly db: NodeSqliteExecutor;
  readonly dbPath: string;
  readonly notes: NoteRepository;
  readonly search: SearchRepository;
  readonly buildMs: number;
}

async function loadCorpus(size: number): Promise<LoadedCorpus> {
  const corpus = buildCorpus(size, 20260928 + size);
  const dbPath = tempDbPath(`regression-${size}`);
  fs.rmSync(dbPath, { force: true });
  const db = NodeSqliteExecutor.openFile(dbPath);
  const logger = new CapturingLogger();
  await new SchemaMigrator(db, logger).migrate();
  const notes = new NoteRepository({ db, clock: new FixedClock(1759000000000), random: new LcgRandom(), logger });
  const search = new SearchRepository({ db });

  const t0 = hrms();
  await transact(db, async () => {
    for (let i = 0; i < corpus.length; i++) {
      const n = corpus[i];
      await notes.create({ title: n.title, contentMd: n.content, source: NoteSource.MANUAL });
    }
  });
  const buildMs = hrms() - t0;
  return { db, dbPath, notes, search, buildMs };
}

// ---------------------------------------------------------------------------
// 评分（口径与 g7-search.ts 一致：真值 = LIKE 子串，全量结果集）
// ---------------------------------------------------------------------------

interface RegressQueryResult {
  readonly label: string;
  readonly query: string;
  readonly truthCount: number;
  readonly hitCount: number;
  readonly intersection: number;
  readonly recall: number;
  readonly precision: number;
  readonly avgMs: number;
  readonly baseline: BaselineRow;
  readonly verdict: 'PASS' | 'FAIL';
}

interface RegressCorpusResult {
  readonly size: number;
  readonly queryCases: number;
  readonly runsPerQuery: number;
  readonly buildMs: number;
  readonly dbBytes: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly recall: number;
  readonly precision: number;
  readonly perQuery: RegressQueryResult[];
  readonly syncChecks: Array<{ readonly name: string; readonly ok: boolean }>;
}

async function regressCorpus(size: number, cases: readonly QueryCase[], baseline: ProbeBaseline): Promise<RegressCorpusResult> {
  const loaded = await loadCorpus(size);
  const { db, notes, search } = loaded;

  // ground truth：LIKE 子串（与探测同口径），搜索范围同生产：排除回收站
  const truthOf = async (query: string): Promise<string[]> => {
    const rows = await db.query(
      `SELECT id FROM note WHERE deleted_at IS NULL AND (content_md LIKE '%' || ? || '%' OR title LIKE '%' || ? || '%')`,
      [query, query],
    );
    return rows.map((r) => String(r['id']));
  };

  const perQuery: RegressQueryResult[] = [];
  const allSamples: number[] = [];
  let sumRecall = 0;
  let sumPrecision = 0;

  for (const c of cases) {
    const truth = await truthOf(c.query);
    const truthSet = new Set(truth);
    let ids: string[] = [];
    const samples: number[] = [];
    for (let r = 0; r < RUNS_PER_QUERY; r++) {
      const t0 = hrms();
      const hits = await search.search(c.query, { limit: FULL_LIMIT, maxScanDocs: FULL_LIMIT });
      samples.push(hrms() - t0);
      ids = hits.map((h) => h.id);
    }
    allSamples.push(...samples);

    const hitSet = new Set(ids);
    let inter = 0;
    hitSet.forEach((id) => {
      if (truthSet.has(id)) {
        inter++;
      }
    });
    const recall = truthSet.size === 0 ? 1 : inter / truthSet.size;
    const precision = hitSet.size === 0 ? (truthSet.size === 0 ? 1 : 0) : inter / hitSet.size;

    const strategy = Array.from(c.query).length >= 3 ? 's3_fts5_trigram' : 's0_like_scan';
    const base = baseline.rows.get(`${strategy}:${size}:${c.label}`) ?? { recall: 0, precision: 0 };
    const pass = recall >= base.recall - 1e-9 && precision >= base.precision - 1e-9;
    sumRecall += recall;
    sumPrecision += precision;
    const sum = samples.reduce((a, b) => a + b, 0);
    perQuery.push({
      label: c.label,
      query: c.query,
      truthCount: truthSet.size,
      hitCount: hitSet.size,
      intersection: inter,
      recall: round3(recall),
      precision: round3(precision),
      avgMs: round3(sum / samples.length),
      baseline: base,
      verdict: pass ? 'PASS' : 'FAIL',
    });
  }

  const syncChecks = await runSyncChecks(notes, search);

  const sorted = allSamples.slice().sort((a, b) => a - b);
  return {
    size,
    queryCases: cases.length,
    runsPerQuery: RUNS_PER_QUERY,
    buildMs: round3(loaded.buildMs),
    dbBytes: fileBytes(loaded.dbPath),
    meanMs: round3(allSamples.reduce((a, b) => a + b, 0) / Math.max(1, allSamples.length)),
    p50Ms: round3(percentile(sorted, 50)),
    p95Ms: round3(percentile(sorted, 95)),
    recall: round3(sumRecall / cases.length),
    precision: round3(sumPrecision / cases.length),
    perQuery,
    syncChecks,
  };
}

/** 增删改同步抽查（G7「增删改」项的落库口径，全语料跑完后再验证） */
async function runSyncChecks(
  notes: NoteRepository,
  search: SearchRepository,
): Promise<Array<{ readonly name: string; readonly ok: boolean }>> {
  const marker = '回执校验单号';
  const out: Array<{ readonly name: string; readonly ok: boolean }> = [];

  const n = await notes.create({ title: 'sync-check', contentMd: `前缀 ${marker} 后缀`, source: NoteSource.MANUAL });
  out.push({ name: '新增可检索', ok: (await search.search(marker, { limit: FULL_LIMIT })).some((h) => h.id === n.id) });

  await notes.update(n.id, 'sync-check', '内容已改 ZZZQ 口径');
  const afterUpdate = await search.search(marker, { limit: FULL_LIMIT });
  out.push({ name: '更新后旧词失效', ok: !afterUpdate.some((h) => h.id === n.id) });
  out.push({ name: '更新后新词命中', ok: (await search.search('ZZZQ', { limit: FULL_LIMIT })).some((h) => h.id === n.id) });

  await notes.softDelete(n.id);
  out.push({ name: '软删除后无泄露', ok: !(await search.search('ZZZQ', { limit: FULL_LIMIT })).some((h) => h.id === n.id) });

  await notes.restore(n.id);
  out.push({ name: '恢复后重新命中', ok: (await search.search('ZZZQ', { limit: FULL_LIMIT })).some((h) => h.id === n.id) });

  return out;
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

export interface RegressionReport {
  readonly generatedAt: string;
  readonly environment: { readonly node: string; readonly platform: string; readonly arch: string };
  readonly strategy: string;
  readonly corpora: RegressCorpusResult[];
}

function renderMarkdown(report: RegressionReport): string {
  const lines: string[] = [];
  lines.push('# G7 落库回归报告（S3-4）');
  lines.push('');
  lines.push(`生成时间：${report.generatedAt}`);
  lines.push('');
  lines.push('## 口径');
  lines.push('');
  lines.push(`- 被测路径：${report.strategy}`);
  lines.push('- 语料/查询集与 S1-3 探测完全相同（buildCorpus/buildQuerySet，种子 20260928+size）；');
  lines.push('- 真值 = LIKE 子串（title OR content），全量结果集无 top-N 截断，每查询 12 次取耗时；');
  lines.push('- 基线：tools/report/g7-search-probe.json —— ≥3 字符查询取 s3_fts5_trigram，1–2 字符取 s0_like_scan；');
  lines.push('- 判定：逐用例召回与精确率均不低于基线（浮点容差 1e-9）。');
  lines.push('');
  for (const corpus of report.corpora) {
    lines.push(`## 语料 ${corpus.size} 条（查询 ${corpus.queryCases} 例 × ${corpus.runsPerQuery} 次）`);
    lines.push('');
    lines.push('| 建索引(含触发器) | DB 体积 | 平均 | P50 | P95 | 召回 | 精确 |');
    lines.push('|---:|---:|---:|---:|---:|---:|---:|');
    lines.push(
      `| ${corpus.buildMs} ms | ${(corpus.dbBytes / 1024 / 1024).toFixed(2)} MB | ${corpus.meanMs} ms | ` +
        `${corpus.p50Ms} ms | ${corpus.p95Ms} ms | ${(corpus.recall * 100).toFixed(1)}% | ${(corpus.precision * 100).toFixed(1)}% |`,
    );
    lines.push('');
    lines.push('| 用例 | 查询 | 真值数 | 命中数 | 召回 | 精确 | 基线(召回/精确) | 判定 | 平均耗时 |');
    lines.push('|---|---|---:|---:|---:|---:|---|---|---:|');
    for (const q of corpus.perQuery) {
      lines.push(
        `| ${q.label} | \`${q.query}\` | ${q.truthCount} | ${q.hitCount} | ${(q.recall * 100).toFixed(1)}% | ` +
          `${(q.precision * 100).toFixed(1)}% | ${(q.baseline.recall * 100).toFixed(1)}% / ${(q.baseline.precision * 100).toFixed(1)}% | ` +
          `${q.verdict} | ${q.avgMs} ms |`,
      );
    }
    lines.push('');
    lines.push('增删改同步抽查：');
    lines.push('');
    for (const chk of corpus.syncChecks) {
      lines.push(`- ${chk.ok ? '✅' : '❌'} ${chk.name}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const baseline = loadBaseline(path.join(process.cwd(), 'report', 'g7-search-probe.json'));
  const corpora: RegressCorpusResult[] = [];
  for (const size of CORPUS_SIZES) {
    const notes = buildCorpus(size, 20260928 + size);
    corpora.push(await regressCorpus(size, buildQuerySet(notes), baseline));
  }

  const report: RegressionReport = {
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    strategy: 'schema V2 (FTS5 trigram contentless + 触发器) + SearchRepository（≥3 字符 trigram 短语，1–2 字符 LIKE 受限扫描）',
    corpora,
  };

  const outDir = path.join(process.cwd(), 'report');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'g7-search-regression.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'g7-search-regression.md'), renderMarkdown(report), 'utf8');

  console.log(renderMarkdown(report));

  const failed = corpora.flatMap((c) => c.perQuery.filter((q) => q.verdict === 'FAIL'));
  const syncFailed = corpora.flatMap((c) => c.syncChecks.filter((s) => !s.ok));
  if (failed.length > 0 || syncFailed.length > 0) {
    console.error(`\n[REGRESSION FAIL] 低于基线用例 ${failed.length} 个，同步抽查失败 ${syncFailed.length} 个`);
    process.exitCode = 1;
  } else {
    console.log('\n[REGRESSION PASS] 全部用例召回/精确率不低于探测基线，增删改同步抽查通过');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
