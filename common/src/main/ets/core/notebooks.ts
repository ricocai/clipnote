/**
 * 笔记本服务（V5 / Feature 1）：笔记的分组容器。
 *
 * 口径：
 *  - 默认笔记本随库走（notebook.is_default 恰一行），不写 preferences —— 单设备单库，
 *    换默认即UPDATE 两行（同一事务）；
 *  - 内置默认笔记本（nb-default，V5 迁移创建）不可删、不设防重命名（改名不改语义）；
 *  - 删除保护三条，全部如实报错（不静默吞、不级联删笔记）：
 *    内置行拒删、当前默认拒删（需先 setDefault 换默认）、非空（含软删条目引用）拒删；
 *  - 空壳删除只删 notebook 行本身，笔记归属校验发生在删除前（countByNotebook）。
 *
 * 平台纪律同 core 其余文件：零 @kit.*，时钟/随机/日志经 ports 注入，本机 node 全量可测。
 */

import { Notebook } from './model';
import { IClock, ILogger, IRandom, LogLevel } from './ports';
import { uuidv7 } from './id';
import { NoteRepository } from './data/note-repository';
import { IRdbExecutor, SqlRow, reqNumber, reqString, transact } from './data/rdb';

export interface NotebookServiceDeps {
  readonly db: IRdbExecutor;
  readonly notes: NoteRepository;
  readonly clock: IClock;
  readonly random: IRandom;
  readonly logger: ILogger;
}

/** 列表项：笔记本 + 归属笔记数（含软删；删除保护提示与列表展示共用同一计数口径） */
export interface NotebookView {
  readonly notebook: Notebook;
  readonly noteCount: number;
}

export class NotebookService {
  constructor(private readonly deps: NotebookServiceDeps) {}

  /** 全部笔记本（创建时间升序，内置默认排最前），附条目数 */
  async list(): Promise<NotebookView[]> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT id, name, built_in, is_default, created_at FROM notebook ORDER BY built_in DESC, created_at ASC`,
    );
    const out: NotebookView[] = [];
    for (let i: number = 0; i < rows.length; i++) {
      const notebook: Notebook = rowToNotebook(rows[i]);
      out.push({ notebook, noteCount: await this.deps.notes.countByNotebook(notebook.id) });
    }
    return out;
  }

  /** 当前默认笔记本（V5 迁移保证恰一行） */
  async getDefault(): Promise<Notebook> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT id, name, built_in, is_default, created_at FROM notebook WHERE is_default = 1 LIMIT 1`,
    );
    if (rows.length === 0) {
      throw new Error('NotebookService.getDefault: no default notebook (V5 migration not applied?)');
    }
    return rowToNotebook(rows[0]);
  }

  /** 新建：trim 后为空或重名（UNIQUE 口径）如实拒绝 */
  async create(name: string): Promise<Notebook> {
    const trimmed: string = name.trim();
    if (trimmed.length === 0) {
      throw new Error('NotebookService.create: empty notebook name');
    }
    if (await this.findByName(trimmed) !== undefined) {
      throw new Error(`NotebookService.create: notebook "${trimmed}" already exists`);
    }
    const now: number = this.deps.clock.nowMs();
    const notebook: Notebook = {
      id: uuidv7(this.deps.clock, this.deps.random),
      name: trimmed,
      builtIn: false,
      isDefault: false,
      createdAtMs: now,
    };
    await this.deps.db.execute(
      `INSERT INTO notebook (id, name, built_in, is_default, created_at) VALUES (?, ?, 0, 0, ?)`,
      [notebook.id, notebook.name, now],
    );
    this.deps.logger.log(LogLevel.INFO, 'notebook_created', { id: notebook.id, name: trimmed });
    return notebook;
  }

  /** 重命名：空名/重名如实拒绝；内置默认笔记本允许改名（id 与保护语义不变） */
  async rename(id: string, name: string): Promise<Notebook> {
    const trimmed: string = name.trim();
    if (trimmed.length === 0) {
      throw new Error('NotebookService.rename: empty notebook name');
    }
    const existing: Notebook = await this.require(id);
    const dup: Notebook | undefined = await this.findByName(trimmed);
    if (dup !== undefined && dup.id !== id) {
      throw new Error(`NotebookService.rename: notebook "${trimmed}" already exists`);
    }
    await this.deps.db.execute(`UPDATE notebook SET name = ? WHERE id = ?`, [trimmed, id]);
    this.deps.logger.log(LogLevel.INFO, 'notebook_renamed', { id, name: trimmed });
    return {
      id: existing.id,
      name: trimmed,
      builtIn: existing.builtIn,
      isDefault: existing.isDefault,
      createdAtMs: existing.createdAtMs,
    };
  }

  /** 换默认：同一事务内清旧置新（恰一行 is_default=1 的不变量） */
  async setDefault(id: string): Promise<void> {
    await this.require(id);
    await transact(this.deps.db, async () => {
      await this.deps.db.execute(`UPDATE notebook SET is_default = 0 WHERE is_default = 1`, []);
      await this.deps.db.execute(`UPDATE notebook SET is_default = 1 WHERE id = ?`, [id]);
    });
    this.deps.logger.log(LogLevel.INFO, 'notebook_default_changed', { id });
  }

  /** 删除：内置拒删、当前默认拒删、非空（含软删条目）拒删；空壳物理删除 */
  async delete(id: string): Promise<void> {
    const existing: Notebook = await this.require(id);
    if (existing.builtIn) {
      throw new Error(`NotebookService.delete: built-in notebook "${existing.name}" cannot be deleted`);
    }
    if (existing.isDefault) {
      throw new Error(`NotebookService.delete: default notebook "${existing.name}" cannot be deleted; set another default first`);
    }
    const count: number = await this.deps.notes.countByNotebook(id);
    if (count > 0) {
      throw new Error(`NotebookService.delete: notebook "${existing.name}" is not empty (${count} notes incl. trash); move or purge notes first`);
    }
    await this.deps.db.execute(`DELETE FROM notebook WHERE id = ?`, [id]);
    this.deps.logger.log(LogLevel.INFO, 'notebook_deleted', { id, name: existing.name });
  }

  private async require(id: string): Promise<Notebook> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT id, name, built_in, is_default, created_at FROM notebook WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) {
      throw new Error(`NotebookService: notebook ${id} not found`);
    }
    return rowToNotebook(rows[0]);
  }

  private async findByName(name: string): Promise<Notebook | undefined> {
    const rows: SqlRow[] = await this.deps.db.query(
      `SELECT id, name, built_in, is_default, created_at FROM notebook WHERE name = ?`,
      [name],
    );
    if (rows.length === 0) {
      return undefined;
    }
    return rowToNotebook(rows[0]);
  }
}

function rowToNotebook(row: SqlRow): Notebook {
  return {
    id: reqString(row, 'id'),
    name: reqString(row, 'name'),
    builtIn: reqNumber(row, 'built_in') === 1,
    isDefault: reqNumber(row, 'is_default') === 1,
    createdAtMs: reqNumber(row, 'created_at'),
  };
}
