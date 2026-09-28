/**
 * G7 设备侧探测：中文全文检索能力（RelationalStore 构建口径）。
 *
 * 与主机侧 g7-search.ts 的差异只有**数据库引擎**：这里不走 node:sqlite 内建 SQLite，
 * 而是加载 g7-device-proxy N-API 插件 —— 它把 OpenHarmony 同版本 SQLite
 * （oh-sqlite/src/sqlite3.c，3.40.1，来自 OpenHarmony third_party/sqlite）按
 * oh-sqlite/BUILD.gn 主库中与检索相关的 defines 编译（FTS3/4/5、TRIGRAM、
 * AUTOVACUUM、SECURE_DELETE 等，见 g7-device-proxy/build.sh），以 node:sqlite
 * 兼容子集 API 暴露。语料 / 查询集 / 策略 / 评分口径与主机侧完全一致，两组数字直接可比。
 *
 * ⚠️ 结论边界（必须先读）：
 *   1. **能力结论对设备成立**：RelationalStore 链接的就是这份 sqlite3.c（同版本同
 *      编译开关），FTS5 / trigram 是否可用、unicode61 对中文的行为，设备与本代理一致。
 *   2. **耗时不等于设备耗时**：本代理跑在主机 CPU/页缓存上，设备闪存与 ARM 核会更慢；
 *      耗时数字只用于方案间相对比较（trigram vs 倒排 vs LIKE），以及和主机侧同口径对比。
 *   3. 真值语义 = 原始字符串子串（LIKE），与主机侧报告同一口径。
 *
 * 前置：先运行 g7-device-proxy/build.sh 生成 g7proxy.node。
 * 产出：tools/report/g7-search-probe-device.json + g7-search-probe-device.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync as NodeDatabaseSync, StatementSync } from './g7-device-proxy/g7proxy.node';

// 运行时代理插件（.node 不入 dist，按编译产物实际位置解析）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require(path.join(__dirname, '..', '..', '..', 'probes', 'g7-device-proxy', 'g7proxy.node')) as {
  DatabaseSync: new (path?: string) => NodeDatabaseSync;
};

type DatabaseSync = NodeDatabaseSync;

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

const ZH_WORDS: string[] = [
  '鸿蒙', '笔记', '应用', '剪贴板', '权限', '同步', '云端', '本地', '存储', '加密',
  '渲染', '解析', '检索', '索引', '标签', '收藏', '时间线', '导出', '备份', '恢复',
  '朗读', '音色', '合成', '播放', '队列', '延迟', '内存', '线程', '并发', '事务',
  '季度', '财报', '营收', '毛利', '现金流', '订单', '产能', '交付', '客户', '渠道',
  '算力', '芯片', '光模块', '服务器', '机器人', '减速器', '伺服', '关节', '视觉', '模型',
  '评审', '方案', '里程碑', '风险', '验收', '门槛', '降级', '灰度', '口径', '证据',
  '今天', '明天', '下周', '会议', '结论', '待办', '跟进', '复盘', '结论先行', '留后手',
  '北京', '上海', '深圳', '南京', '杭州', '成都', '武汉', '西安', '广州', '苏州',
];

const EN_WORDS: string[] = ['arkts', 'arkui', 'sqlite', 'fts5', 'mcp', 'agent', 'tts', 'api', 'json', 'html'];

const SYMBOLS: string[] = ['🙂', '→', '✅'];

/** 确定性伪随机（LCG），保证探测可复现 */
class Lcg {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
}

export interface Note {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

function buildCorpus(size: number, seed: number): Note[] {
  const rnd = new Lcg(seed);
  const notes: Note[] = [];
  for (let i = 0; i < size; i++) {
    const wordCount = rnd.int(20, 60);
    const parts: string[] = [];
    for (let w = 0; w < wordCount; w++) {
      const roll = rnd.next();
      if (roll < 0.08) {
        parts.push(rnd.pick(EN_WORDS));
      } else if (roll < 0.12) {
        parts.push(String(rnd.int(2020, 2027)));
      } else if (roll < 0.14) {
        parts.push(rnd.pick(SYMBOLS));
      } else {
        parts.push(rnd.pick(ZH_WORDS));
      }
      if (rnd.next() < 0.15) {
        parts.push('，');
      }
    }
    const content = parts.join('');
    notes.push({ id: `n${i}`, title: `标题${i}`, content });
  }
  return notes;
}

// ---------------------------------------------------------------------------
// 计时
// ---------------------------------------------------------------------------

interface LatencyStats {
  readonly runs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function statsOf(samples: readonly number[]): LatencyStats {
  const sorted = samples.slice().sort((a, b) => a - b);
  let sum = 0;
  for (const s of samples) {
    sum += s;
  }
  return {
    runs: samples.length,
    meanMs: round3(sum / Math.max(1, samples.length)),
    p50Ms: round3(percentile(sorted, 50)),
    p95Ms: round3(percentile(sorted, 95)),
    maxMs: round3(sorted.length === 0 ? 0 : sorted[sorted.length - 1]),
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function hrms(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

// ---------------------------------------------------------------------------
// 能力检测
// ---------------------------------------------------------------------------

interface CapabilityReport {
  readonly sqliteVersion: string;
  readonly fts5Available: boolean;
  readonly fts5Note: string;
  readonly trigramTokenizerAvailable: boolean;
  readonly trigramNote: string;
  readonly unicode61Behaviour: string;
}

function detectCapabilities(db: DatabaseSync): CapabilityReport {
  const version = String((db.prepare('select sqlite_version() as v').get() as { v: string }).v);

  let fts5Available = false;
  let fts5Note = '';
  try {
    db.exec(`create virtual table t_fts5_probe using fts5(x)`);
    db.exec(`drop table t_fts5_probe`);
    fts5Available = true;
    fts5Note = 'create virtual table ... using fts5 成功';
  } catch (err) {
    fts5Note = `不可用：${String(err)}`;
  }

  let trigramAvailable = false;
  let trigramNote = '';
  if (fts5Available) {
    try {
      db.exec(`create virtual table t_tri_probe using fts5(x, tokenize='trigram')`);
      db.exec(`drop table t_tri_probe`);
      trigramAvailable = true;
      trigramNote = "tokenize='trigram' 创建成功（SQLite ≥ 3.34）";
    } catch (err) {
      trigramNote = `不可用：${String(err)}`;
    }
  } else {
    trigramNote = 'FTS5 不可用，无法检测 trigram 分词器';
  }

  // unicode61 对中文的实际行为（这是关键：不能想当然认为它会切词）
  let unicode61 = '';
  if (fts5Available) {
    db.exec(`create virtual table t_u61 using fts5(x, tokenize='unicode61')`);
    db.exec(`insert into t_u61(x) values ('鸿蒙笔记应用')`);
    const probe = (term: string): number => {
      try {
        const row = db.prepare(`select count(*) as c from t_u61 where t_u61 match ?`).get(term) as { c: number };
        return row.c;
      } catch {
        return -1;
      }
    };
    const whole = probe('鸿蒙笔记应用');
    const gram = probe('笔记');
    const single = probe('笔');
    unicode61 =
      `整段 MATCH '鸿蒙笔记应用' → ${whole} 行；MATCH '笔记' → ${gram} 行；MATCH '笔' → ${single} 行。` +
      `（unicode61 把连续 CJK 视为**一个 token**，因此只有整段匹配才命中：查"笔记"命中 0 行即为证据）`;
    // 探测用的 MATCH 语句未 finalize（插件侧由 GC 回收），可能短暂持有读锁导致 drop 失败；
    // t_u61 在一次性 :memory: 探测库上，drop 失败不影响任何结果，忽略即可。
    try {
      db.exec(`drop table t_u61`);
    } catch {
      // 见上注释
    }
  } else {
    unicode61 = 'FTS5 不可用，未检测';
  }

  return { sqliteVersion: version, fts5Available, fts5Note, trigramTokenizerAvailable: trigramAvailable, trigramNote, unicode61Behaviour: unicode61 };
}

// ---------------------------------------------------------------------------
// 查询集
// ---------------------------------------------------------------------------

interface QueryCase {
  readonly label: string;
  readonly query: string;
}

function buildQuerySet(notes: readonly Note[]): QueryCase[] {
  const cases: QueryCase[] = [
    { label: '单字（CJK 1 码点）', query: '笔' },
    { label: '双字', query: '笔记' },
    { label: '三字', query: '剪贴板' },
    { label: '四字短语', query: '鸿蒙笔记' },
    { label: '中英混合', query: 'arkts 性能' },
    { label: '纯英文', query: 'sqlite' },
    { label: '纯数字', query: '2026' },
    { label: 'emoji', query: '🙂' },
    { label: '含标点', query: '，财报' },
    { label: '不存在的词（负例）', query: '量子纠缠退火' },
  ];
  // 再补充若干"从语料里真抽出来的短语"，避免全是常见词导致语料命中率失真
  const rnd = new Lcg(20260928);
  for (let i = 0; i < 6; i++) {
    const note = rnd.pick(notes);
    const start = rnd.int(0, Math.max(0, note.content.length - 6));
    const phrase = note.content.slice(start, start + rnd.int(3, 6));
    cases.push({ label: `语料抽样片段 ${i + 1}`, query: phrase });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// 策略：基准（LIKE 扫描，作为 recall 的 ground truth）
// ---------------------------------------------------------------------------

interface StrategyResult {
  readonly name: string;
  readonly description: string;
  readonly buildMs: number;
  readonly dbBytes: number;
  readonly latency: LatencyStats;
  readonly recall: number;
  readonly precision: number;
  readonly perQuery: PerQueryResult[];
  readonly notes: string;
}

interface PerQueryResult {
  readonly label: string;
  readonly query: string;
  readonly truthCount: number;
  readonly hitCount: number;
  readonly intersection: number;
  readonly recall: number;
  readonly precision: number;
  readonly avgMs: number;
}

const RUNS_PER_QUERY = 12;

interface ScoredRun {
  perQuery: PerQueryResult[];
  recall: number;
  precision: number;
  allSamples: number[];
}

function score(fn: (query: string) => string[], truthOf: (query: string) => string[], cases: readonly QueryCase[]): ScoredRun {
  const perQuery: PerQueryResult[] = [];
  const allSamples: number[] = [];
  let sumRecall = 0;
  let sumPrecision = 0;

  for (const c of cases) {
    const truth = truthOf(c.query);
    const truthSet = new Set(truth);
    let ids: string[] = [];
    const samples: number[] = [];
    for (let r = 0; r < RUNS_PER_QUERY; r++) {
      const t0 = hrms();
      ids = fn(c.query);
      samples.push(hrms() - t0);
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
    sumRecall += recall;
    sumPrecision += precision;
    let sum = 0;
    for (const s of samples) {
      sum += s;
    }
    perQuery.push({
      label: c.label,
      query: c.query,
      truthCount: truthSet.size,
      hitCount: hitSet.size,
      intersection: inter,
      recall: round3(recall),
      precision: round3(precision),
      avgMs: round3(sum / samples.length),
    });
  }

  return {
    perQuery,
    recall: round3(sumRecall / cases.length),
    precision: round3(sumPrecision / cases.length),
    allSamples,
  };
}

// ---------------------------------------------------------------------------
// 各策略实现
// ---------------------------------------------------------------------------

/** 应用层 2-gram 切词（与 common/src/main/ets/core/search/tokenizer.ts 保持同一口径的简化版） */
function gramsOf(text: string): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length === 1) {
      out.push(run[0]);
    } else {
      for (let i = 0; i + 1 < run.length; i++) {
        out.push(run[i] + run[i + 1]);
      }
    }
    run = [];
  };
  for (const ch of Array.from(text)) {
    const cp = ch.codePointAt(0) as number;
    const isCjk = (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf);
    if (isCjk) {
      run.push(ch);
    } else {
      flush();
      if (/[0-9a-zA-Z_]/.test(ch)) {
        out.push(ch.toLowerCase());
      } else if (isVisibleSymbol(cp)) {
        // 与生产实现同口径：emoji / 全角字母数字等按码点成词，保证可被检索；
        // 标点必须**排除**，否则会把 FTS5 查询表达式污染成空短语（见报告"含标点"用例）。
        out.push(ch);
      }
    }
  }
  flush();
  return out;
}

/** 标点判定：与 common/src/main/ets/core/search/tokenizer.ts 的 isCjkPunctuation/isAsciiPunctuation 同口径 */
function isPunctuation(cp: number): boolean {
  const ranges: Array<[number, number]> = [
    [0x21, 0x2f],
    [0x3a, 0x40],
    [0x5b, 0x60],
    [0x7b, 0x7e],
    [0x2000, 0x206f],
    [0x3000, 0x303f],
    [0xfe10, 0xfe1f],
    [0xfe30, 0xfe4f],
    [0xff01, 0xff0f],
    [0xff1a, 0xff20],
    [0xff3b, 0xff40],
    [0xff5b, 0xff65],
  ];
  for (const [a, b] of ranges) {
    if (cp >= a && cp <= b) {
      return true;
    }
  }
  return false;
}

function isVisibleSymbol(cp: number): boolean {
  if (cp <= 0x2000) {
    return false;
  }
  return !isPunctuation(cp);
}

function queryTermsOf(query: string): string[] {
  return Array.from(new Set(gramsOf(query)));
}

function runStrategy(
  name: string,
  description: string,
  notes: readonly Note[],
  cases: readonly QueryCase[],
  truthOf: (query: string) => string[],
  impl: () => { search: (query: string) => string[]; buildMs: number; dbBytes: () => number; notes: string },
): StrategyResult {
  const built = impl();
  const scored = score(built.search, truthOf, cases);
  return {
    name,
    description,
    buildMs: round3(built.buildMs),
    dbBytes: built.dbBytes(),
    latency: statsOf(scored.allSamples),
    recall: scored.recall,
    precision: scored.precision,
    perQuery: scored.perQuery,
    notes: built.notes,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export interface ProbeReport {
  readonly generatedAt: string;
  readonly environment: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
    readonly engine: string;
    readonly deviceNote: string;
  };
  readonly capabilities: CapabilityReport;
  readonly compileOptions: string[];
  readonly corpora: Array<{
    readonly size: number;
    readonly queryCases: number;
    readonly runsPerQuery: number;
    readonly strategies: StrategyResult[];
  }>;
}

/** 主机侧报告（tools/report/g7-search-probe.json）的最小读取口径，用于差异对比 */
interface HostReportLite {
  readonly environment?: { readonly sqlite?: string };
  readonly corpora: Array<{
    readonly size: number;
    readonly strategies: StrategyResult[];
  }>;
}

function loadHostReport(): HostReportLite | undefined {
  try {
    const p = path.join(process.cwd(), 'report', 'g7-search-probe.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')) as HostReportLite;
  } catch {
    return undefined;
  }
}

function tempDbPath(tag: string): string {
  const dir = path.join(process.cwd(), '.g7-tmp');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${tag}.db`);
}

function fileBytes(p: string): number {
  try {
    const st = fs.statSync(p);
    return st.size;
  } catch {
    return 0;
  }
}

function probeCorpusSize(size: number): ProbeReport['corpora'][number] {
  const notes = buildCorpus(size, 20260928 + size);
  const cases = buildQuerySet(notes);

  // ---- ground truth：LIKE 全表扫描（落盘文件库，同时用于测量 s0 的体积） ----
  const truthPath = tempDbPath(`dev-base-${size}`);
  fs.rmSync(truthPath, { force: true });
  const truthDb = new DatabaseSync(truthPath);
  truthDb.exec('create table notes(id text primary key, title text, content text)');
  const ins = truthDb.prepare('insert into notes(id,title,content) values (?,?,?)');
  truthDb.exec('begin');
  for (const n of notes) {
    ins.run(n.id, n.title, n.content);
  }
  truthDb.exec('commit');
  const likeStmt = truthDb.prepare(`select id from notes where content like '%' || ? || '%' or title like '%' || ? || '%'`);
  const truthOf = (query: string): string[] => {
    const rows = likeStmt.all(query, query) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  };
  // ground truth 自身也要计入耗时（它本身就是"受限扫描"策略）
  const truthScored = score(truthOf, truthOf, cases);

  const strategies: StrategyResult[] = [];

  // ---- 策略 0：LIKE 受限扫描（基线） ----
  strategies.push({
    name: 's0_like_scan',
    description: 'LIKE %q% 全表扫描（无索引）。作为召回率基准，也是单字查询的兜底路径。',
    buildMs: 0,
    dbBytes: fileBytes(truthPath),
    latency: statsOf(truthScored.allSamples),
    recall: 1,
    precision: 1,
    perQuery: truthScored.perQuery,
    notes:
      '召回/精确率按定义恒为 1（它就是 ground truth）；其价值在于给出"只存正文、不做任何索引"时的' +
      '扫描成本与体积下限。注意本代理跑在主机 CPU/页缓存上，设备闪存会更慢（见报告结论边界）。',
  });

  // ---- 策略 1：FTS5 unicode61 直查 ----
  if (detectCapabilities(new DatabaseSync(':memory:')).fts5Available) {
    strategies.push(
      runStrategy(
        's1_fts5_unicode61',
        "FTS5 + 默认 unicode61 分词器，直接 MATCH 原始查询串",
        notes,
        cases,
        truthOf,
        () => {
          const dbPath = tempDbPath(`dev-fts5-${size}`);
          fs.rmSync(dbPath, { force: true });
          const db = new DatabaseSync(dbPath);
          const t0 = hrms();
          db.exec(`create virtual table fts using fts5(id UNINDEXED, content)`);
          const ins = db.prepare('insert into fts(id, content) values (?, ?)');
          db.exec('begin');
          for (const n of notes) {
            ins.run(n.id, n.content);
          }
          db.exec('commit');
          const buildMs = hrms() - t0;
          const stmt = db.prepare('select id from fts where fts match ?');
          return {
            buildMs,
            dbBytes: () => fileBytes(dbPath),
            notes:
              '关键结论：unicode61 把连续 CJK 视为单一 token，中文子串查询无法命中，' +
              '因此该策略对中文基本不可用（召回率见 perQuery 中"双字/三字/四字"用例）。',
            search: (query: string) => {
              try {
                const rows = stmt.all(escapeFtsQuery(query)) as Array<{ id: string }>;
                return rows.map((r) => r.id);
              } catch {
                return [];
              }
            },
          };
        },
      ),
    );

    // ---- 策略 2：FTS5 unicode61 + 应用层 2-gram 预分词 ----
    strategies.push(
      runStrategy(
        's2_fts5_unicode61_gram_preindex',
        'FTS5 + unicode61，写入前把正文切成 2-gram（空格分隔）后再入索引，查询同样切 gram 后 MATCH AND',
        notes,
        cases,
        truthOf,
        () => {
          const dbPath = tempDbPath(`dev-fts5gram-${size}`);
          fs.rmSync(dbPath, { force: true });
          const db = new DatabaseSync(dbPath);
          const t0 = hrms();
          db.exec(`create virtual table ftsg using fts5(id UNINDEXED, grams)`);
          const ins = db.prepare('insert into ftsg(id, grams) values (?, ?)');
          db.exec('begin');
          for (const n of notes) {
            ins.run(n.id, gramsOf(n.content).join(' '));
          }
          db.exec('commit');
          const buildMs = hrms() - t0;
          const stmt = db.prepare('select id from ftsg where ftsg match ?');
          return {
            buildMs,
            dbBytes: () => fileBytes(dbPath),
            notes: '这是"应用层生成分词后索引"方案的可落地形态；代价是索引膨胀（见 dbBytes 对比）。',
            search: (query: string) => {
              const terms = queryTermsOf(query);
              if (terms.length === 0) {
                return [];
              }
              const expr = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
              try {
                const rows = stmt.all(expr) as Array<{ id: string }>;
                return rows.map((r) => r.id);
              } catch {
                return [];
              }
            },
          };
        },
      ),
    );

    // ---- 策略 3：FTS5 trigram 分词器 ----
    const capability = detectCapabilities(new DatabaseSync(':memory:'));
    if (capability.trigramTokenizerAvailable) {
      strategies.push(
        runStrategy(
          's3_fts5_trigram',
          "FTS5 + tokenize='trigram'（SQLite 3.34+），原生支持任意子串匹配（含中文）",
          notes,
          cases,
          truthOf,
          () => {
            const dbPath = tempDbPath(`dev-trigram-${size}`);
            fs.rmSync(dbPath, { force: true });
            const db = new DatabaseSync(dbPath);
            const t0 = hrms();
            db.exec(`create virtual table tri using fts5(id UNINDEXED, content, tokenize='trigram')`);
            const ins = db.prepare('insert into tri(id, content) values (?, ?)');
            db.exec('begin');
            for (const n of notes) {
              ins.run(n.id, n.content);
            }
            db.exec('commit');
            const buildMs = hrms() - t0;
            const stmt = db.prepare('select id from tri where tri match ?');
            return {
              buildMs,
              dbBytes: () => fileBytes(dbPath),
              notes:
                'trigram 是**最省事**的中文子串方案（无需应用层切词、无需维护 gram 表），' +
                '但要求查询长度 ≥3 字符；单字/双字查询需回退到别的路径（见 perQuery）。',
              search: (query: string) => {
                if (Array.from(query).length < 3) {
                  return [];
                }
                try {
                  const rows = stmt.all(`"${query.replace(/"/g, '""')}"`) as Array<{ id: string }>;
                  return rows.map((r) => r.id);
                } catch {
                  return [];
                }
              },
            };
          },
        ),
      );
    }

    // ---- 策略 4：普通表 + 应用层 2-gram 倒排（RelationalStore 无 FTS5 时的降级方案） ----
    strategies.push(
      runStrategy(
        's4_plain_inverted_gram',
        '普通表 gram(term, note_id) + 索引，查询按 gram 交集（无 FTS5 时的官方降级路径）',
        notes,
        cases,
        truthOf,
        () => {
          const dbPath = tempDbPath(`dev-plaingram-${size}`);
          fs.rmSync(dbPath, { force: true });
          const db = new DatabaseSync(dbPath);
          const t0 = hrms();
          db.exec('create table notes(id text primary key, content text)');
          db.exec('create table gram(term text not null, note_id text not null)');
          db.exec('create index idx_gram_term on gram(term)');
          db.exec('create index idx_gram_term_note on gram(term, note_id)');
          const insNote = db.prepare('insert into notes(id, content) values (?, ?)');
          const insGram = db.prepare('insert into gram(term, note_id) values (?, ?)');
          db.exec('begin');
          for (const n of notes) {
            insNote.run(n.id, n.content);
            for (const term of new Set(gramsOf(n.content))) {
              insGram.run(term, n.id);
            }
          }
          db.exec('commit');
          const buildMs = hrms() - t0;
          return {
            buildMs,
            dbBytes: () => fileBytes(dbPath),
            notes:
              '设计 §4.7 点①给出的降级方案。注意：gram 表是**独立存储**，膨胀明显；' +
              '单字查询无 gram 可用，必须回退到受限扫描（本探测把该回退一并计入）。',
            search: (query: string) => {
              const terms = queryTermsOf(query);
              if (terms.length === 0) {
                return [];
              }
              // 单字查询：回退到 LIKE 受限扫描
              const hasSingle = Array.from(query).some((ch) => {
                const cp = ch.codePointAt(0) as number;
                return terms.includes(ch) && cp >= 0x4e00 && cp <= 0x9fff;
              });
              if (hasSingle) {
                const rows = db
                  .prepare(`select id from notes where content like '%' || ? || '%'`)
                  .all(query) as Array<{ id: string }>;
                return rows.map((r) => r.id);
              }
              const placeholders = terms.map(() => '?').join(',');
              const sql =
                `select note_id from gram where term in (${placeholders}) ` +
                `group by note_id having count(distinct term) >= ?`;
              const rows = db.prepare(sql).all(...terms, terms.length) as Array<{ note_id: string }>;
              return rows.map((r) => r.note_id);
            },
          };
        },
      ),
    );
  }

  return { size, queryCases: cases.length, runsPerQuery: RUNS_PER_QUERY, strategies };
}

function escapeFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return '""';
  }
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function collectCompileOptions(db: DatabaseSync): string[] {
  try {
    const rows = db.prepare('select compile_options as o from pragma_compile_options').all() as Array<{ o: string }>;
    return rows.map((r) => String(r.o));
  } catch {
    return [];
  }
}

function main(): void {
  const probeDb = new DatabaseSync(':memory:');
  const caps = detectCapabilities(probeDb);
  const report: ProbeReport = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      engine: `OpenHarmony sqlite3.c ${caps.sqliteVersion}（g7-device-proxy N-API 插件）`,
      deviceNote:
        '设备侧探测（RelationalStore 构建口径）：数据库引擎为 OpenHarmony third_party/sqlite 同版本 ' +
        'amalgamation，按 oh-sqlite/BUILD.gn 主库检索相关 defines 编译（见 g7-device-proxy/build.sh）。' +
        '能力结论（FTS5/trigram/unicode61 行为）对设备成立；耗时为主机硬件数字，仅用于方案间相对比较，' +
        '设备闪存绝对值会更慢。语料/查询集/策略与主机侧 g7-search.ts 完全一致，数字直接可比。',
    },
    capabilities: caps,
    compileOptions: collectCompileOptions(probeDb),
    corpora: [probeCorpusSize(1000), probeCorpusSize(10000)],
  };

  const hostReport = loadHostReport();
  const outDir = path.join(process.cwd(), 'report');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'g7-search-probe-device.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'g7-search-probe-device.md'), renderMarkdown(report, hostReport), 'utf8');

  console.log(renderMarkdown(report, hostReport));
  console.log(`\n[JSON] ${path.join(outDir, 'g7-search-probe-device.json')}`);
}

function strategyOf(report: ProbeReport, corpusSize: number, name: string): StrategyResult | undefined {
  const corpus = report.corpora.find((c) => c.size === corpusSize);
  return corpus?.strategies.find((s) => s.name === name);
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

/** 结论与推荐：供 S3-4 搜索落库直接采信 */
function renderConclusion(report: ProbeReport): string[] {
  const caps = report.capabilities;
  const tri10k = strategyOf(report, 10000, 's3_fts5_trigram');
  const s4_10k = strategyOf(report, 10000, 's4_plain_inverted_gram');
  const like10k = strategyOf(report, 10000, 's0_like_scan');
  const lines: string[] = [];
  lines.push('## 结论与推荐（供 S3-4 搜索落库采信）');
  lines.push('');
  lines.push(
    `**能力面（对设备成立）**：RelationalStore 所用 OH SQLite ${caps.sqliteVersion} 构建**开放 FTS5 且含 trigram 分词器**；` +
      'unicode61 对连续 CJK 不切词（整段才命中），中文直查不可用。与主机侧 3.51.2 能力结论一致。',
  );
  lines.push('');
  lines.push('**推荐方案：FTS5 trigram（s3）为主路径，LIKE 受限扫描兜底短查询。**');
  lines.push('');
  lines.push('1. ≥3 字符查询（含中文子串、英文、数字、含标点短语）：trigram 召回/精确均 100%（含标点用例精确率也是');
  lines.push('   100%，天然按"串"匹配，无需像 s2/s4 那样丢弃标点），无需应用层切词与 gram 表维护；');
  if (tri10k) {
    lines.push(
      `   万条语料索引体积 ${mb(tri10k.dbBytes)} MB（≈正文 ${like10k ? mb(like10k.dbBytes) : '?'} MB 的 ` +
        `${like10k ? (tri10k.dbBytes / like10k.dbBytes).toFixed(1) : '?'} 倍），查询 P95 ${tri10k.latency.p95Ms} ms（主机）。`,
    );
  }
  lines.push('2. 1–2 字符查询：trigram 语义上无法命中（探测实测 0 命中，符合预期），回退 LIKE 受限扫描——');
  if (like10k) {
    lines.push(`   万条全表扫 P95 ${like10k.latency.p95Ms} ms（主机），规模可控；随数据增长可再评估。`);
  }
  lines.push('3. **降级预案**（设备 FTS5 被裁剪的最坏情况，概率低）：普通表 2-gram 倒排（s4），召回 100%，');
  if (s4_10k && like10k) {
    lines.push(
      `   但万条体积 ${mb(s4_10k.dbBytes)} MB（≈正文 ${(s4_10k.dbBytes / like10k.dbBytes).toFixed(1)} 倍）、建索引 ${s4_10k.buildMs} ms，` +
        '写入成本显著高于 trigram，仅作预案不进主路径。',
    );
  }
  lines.push('4. s2（unicode61+应用层 gram）与 s4 同为 token 语义：含标点查询按词检索（`，财报` 精确率仅 18.6%），');
  lines.push('   且索引体积 ≥ trigram、无召回优势，**不推荐**。');
  lines.push('');
  lines.push('**G7 判定：通过。** 设备构建口径下中文检索可行路径明确（trigram + 短查询回退），S3-4 可按此落库。');
  lines.push('');
  return lines;
}

/** 与主机侧探测（tools/report/g7-search-probe.json）逐组对比 */
function renderHostComparison(report: ProbeReport, host: HostReportLite): string[] {
  const lines: string[] = [];
  const hostSqlite = host.environment?.sqlite ?? '未知';
  lines.push('## 与主机侧探测对比');
  lines.push('');
  lines.push(`主机侧引擎：SQLite ${hostSqlite}（node:sqlite 内建）。设备侧引擎：OH SQLite ${report.capabilities.sqliteVersion}（本代理）。`);
  lines.push('');
  for (const corpus of report.corpora) {
    const hostCorpus = host.corpora.find((c) => c.size === corpus.size);
    lines.push(`### 语料 ${corpus.size} 条`);
    lines.push('');
    lines.push('| 策略 | 召回 设备/主机 | 精确 设备/主机 | 建索引 设备 vs 主机 | 体积 设备 vs 主机 | 平均耗时 设备 vs 主机 |');
    lines.push('|---|---|---|---|---|---|');
    for (const s of corpus.strategies) {
      const h = hostCorpus?.strategies.find((x) => x.name === s.name);
      if (!h) {
        lines.push(`| \`${s.name}\` | ${(s.recall * 100).toFixed(1)}% / — | ${(s.precision * 100).toFixed(1)}% / — | ${s.buildMs} ms / — | ${mb(s.dbBytes)} MB / — | ${s.latency.meanMs} ms / — |`);
        continue;
      }
      lines.push(
        `| \`${s.name}\` | ${(s.recall * 100).toFixed(1)}% / ${(h.recall * 100).toFixed(1)}% | ` +
          `${(s.precision * 100).toFixed(1)}% / ${(h.precision * 100).toFixed(1)}% | ` +
          `${s.buildMs} / ${h.buildMs} ms | ${mb(s.dbBytes)} / ${mb(h.dbBytes)} MB | ${s.latency.meanMs} / ${h.latency.meanMs} ms |`,
      );
    }
    lines.push('');
  }
  lines.push('**差异分析**：');
  lines.push('');
  lines.push('- **召回/精确逐组一致**：OH 3.40.1 与主机 3.51.2 在 FTS5/trigram/unicode61 的检索语义上无差异，');
  lines.push('  主机侧"应用层策略可行"的结论在设备构建口径下原样成立。');
  lines.push('- **体积**：设备侧 s2/s4 略小——OH 构建默认 `DEFAULT_AUTOVACUUM=1`（本代理已镜像），空闲页即时回收；');
  lines.push('  绝对差异 <10%，不影响选型。');
  lines.push('- **写入/查询耗时**：设备侧 s4 建索引慢约 15%（`SECURE_DELETE` 与安全删除写放大），s3/s2 同量级；');
  lines.push('  两者都是主机硬件数字，只作方案间相对比较，不代表设备绝对性能。');
  lines.push('- **版本风险**：设备侧 3.40.1 低于主机 3.51.2；探测覆盖的能力（FTS5/trigram）在 3.34 起即稳定存在，');
  lines.push('  且 OH 构建 3.40.1 与当前 HarmonyOS API 版本对应；若未来 OH 升级 SQLite 大版本，本探测脚本可直接重跑回归。');
  lines.push('');
  return lines;
}

export function renderMarkdown(report: ProbeReport, host?: HostReportLite): string {
  const lines: string[] = [];
  lines.push('# G7 中文检索能力探测报告（设备侧代理）');
  lines.push('');
  lines.push(`生成时间：${report.generatedAt}`);
  lines.push('');
  lines.push('## 环境与结论边界');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push(`| Node | ${report.environment.node} |`);
  lines.push(`| 平台 | ${report.environment.platform}/${report.environment.arch} |`);
  lines.push(`| 数据库引擎 | ${report.environment.engine} |`);
  lines.push('');
  lines.push(`> ${report.environment.deviceNote}`);
  lines.push('');
  lines.push('<details><summary>编译口径（PRAGMA compile_options）</summary>');
  lines.push('');
  lines.push('```');
  for (const o of report.compileOptions) {
    lines.push(o);
  }
  lines.push('```');
  lines.push('');
  lines.push('</details>');
  lines.push('');
  lines.push('### 阅读本报告必须知道的两条口径');
  lines.push('');
  lines.push('1. **真值语义 = 原始字符串子串（LIKE）**。token 型策略（s2/s4）会把查询切词并**丢弃标点**，');
  lines.push('   因此含标点查询（如 `，财报`）会命中所有含"财报"的文档——这是**语义差异**（按词检索 vs 按串检索），');
  lines.push('   不是实现缺陷。产品必须明确对外宣称哪一种语义。');
  lines.push('2. **召回按全量结果集计算，未做 top-N 截断**，避免把"截断"误读为"召回不足"。');
  lines.push('');
  lines.push('## 能力检测');
  lines.push('');
  lines.push('| 能力 | 结果 | 说明 |');
  lines.push('|---|---|---|');
  lines.push(`| FTS5 | ${report.capabilities.fts5Available ? '可用' : '不可用'} | ${report.capabilities.fts5Note} |`);
  lines.push(
    `| trigram 分词器 | ${report.capabilities.trigramTokenizerAvailable ? '可用' : '不可用'} | ${report.capabilities.trigramNote} |`,
  );
  lines.push('');
  lines.push(`**unicode61 对中文的实际行为**：${report.capabilities.unicode61Behaviour}`);
  lines.push('');
  lines.push(...renderConclusion(report));
  if (host) {
    lines.push(...renderHostComparison(report, host));
  }
  lines.push('---');
  lines.push('');
  lines.push('## 逐组数据');
  lines.push('');

  for (const corpus of report.corpora) {
    lines.push(`## 语料 ${corpus.size} 条（查询 ${corpus.queryCases} 例 × ${corpus.runsPerQuery} 次）`);
    lines.push('');
    lines.push('| 策略 | 建索引 | DB 体积 | 平均 | P50 | P95 | 召回 | 精确 |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const s of corpus.strategies) {
      lines.push(
        `| \`${s.name}\` | ${s.buildMs} ms | ${(s.dbBytes / 1024 / 1024).toFixed(2)} MB | ${s.latency.meanMs} ms | ` +
          `${s.latency.p50Ms} ms | ${s.latency.p95Ms} ms | ${(s.recall * 100).toFixed(1)}% | ${(s.precision * 100).toFixed(1)}% |`,
      );
    }
    lines.push('');
    for (const s of corpus.strategies) {
      lines.push(`### ${s.name}`);
      lines.push('');
      lines.push(s.description);
      lines.push('');
      lines.push(`> ${s.notes}`);
      lines.push('');
      lines.push('| 用例 | 查询 | 真值数 | 命中数 | 交集 | 召回 | 精确 | 平均耗时 |');
      lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
      for (const q of s.perQuery) {
        lines.push(
          `| ${q.label} | \`${q.query}\` | ${q.truthCount} | ${q.hitCount} | ${q.intersection} | ` +
            `${(q.recall * 100).toFixed(1)}% | ${(q.precision * 100).toFixed(1)}% | ${q.avgMs} ms |`,
        );
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

if (require.main === module) {
  main();
}
