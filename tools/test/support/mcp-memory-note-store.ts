/**
 * 本机测试/台架用 NoteStoreLike 内存假实现。
 *
 * 不是交付物：真实接线由 entry 装配层用 common 的 NoteService 适配
 * （mcp core 不 import common）。搜索为子串匹配 + 片段截取，
 * 足够验证协议适配层的范围过滤/限量收敛语义。
 */

import {
  NoteAppendResult,
  NoteCreateResult,
  NoteDetail,
  NoteSearchRow,
  NoteStoreLike,
  NoteTagRow,
} from '../../../mcp/src/main/ets/core/dispatcher';

interface StoredNote {
  id: string;
  title: string;
  content: string;
  revision: number;
  deletedAtMs?: number;
  tagIds: string[];
}

export interface SeedNoteInput {
  readonly title: string;
  readonly content: string;
  readonly tagIds?: string[];
  readonly deleted?: boolean;
}

export class MemoryNoteStore implements NoteStoreLike {
  private readonly notes: Map<string, StoredNote> = new Map();
  private readonly tags: Map<string, string> = new Map();
  private seq: number = 0;

  constructor(private readonly clock?: { nowMs(): number }) {}

  seed(input: SeedNoteInput): string {
    this.seq++;
    const id: string = `note-${this.seq}`;
    this.notes.set(id, {
      id,
      title: input.title,
      content: input.content,
      revision: 1,
      deletedAtMs: input.deleted === true ? this.nowMs() : undefined,
      tagIds: input.tagIds === undefined ? [] : [...input.tagIds],
    });
    return id;
  }

  seedTag(id: string, name: string): void {
    this.tags.set(id, name);
  }

  /** 断言辅助：原始正文（含已软删笔记）。 */
  contentOf(id: string): string {
    const note: StoredNote | undefined = this.notes.get(id);
    if (note === undefined) {
      throw new Error(`no such note: ${id}`);
    }
    return note.content;
  }

  revisionOf(id: string): number {
    const note: StoredNote | undefined = this.notes.get(id);
    if (note === undefined) {
      throw new Error(`no such note: ${id}`);
    }
    return note.revision;
  }

  isDeleted(id: string): boolean {
    const note: StoredNote | undefined = this.notes.get(id);
    if (note === undefined) {
      throw new Error(`no such note: ${id}`);
    }
    return note.deletedAtMs !== undefined;
  }

  async search(query: string, limit: number): Promise<NoteSearchRow[]> {
    const out: NoteSearchRow[] = [];
    for (const note of this.notes.values()) {
      if (out.length >= limit) {
        break;
      }
      const haystack: string = `${note.title}\n${note.content}`;
      const idx: number = haystack.indexOf(query);
      if (idx < 0) {
        continue;
      }
      out.push({ id: note.id, title: note.title, snippetText: makeSnippet(haystack, idx) });
    }
    return out;
  }

  async getById(id: string): Promise<NoteDetail | undefined> {
    const note: StoredNote | undefined = this.notes.get(id);
    if (note === undefined) {
      return undefined;
    }
    return {
      id: note.id,
      title: note.title,
      content: note.content,
      revision: note.revision,
      deletedAtMs: note.deletedAtMs,
      tagIds: [...note.tagIds],
    };
  }

  async create(input: { title: string; content: string }): Promise<NoteCreateResult> {
    this.seq++;
    const id: string = `note-${this.seq}`;
    this.notes.set(id, {
      id,
      title: input.title,
      content: input.content,
      revision: 1,
      deletedAtMs: undefined,
      tagIds: [],
    });
    return { id, title: input.title, revision: 1 };
  }

  async append(id: string, content: string): Promise<NoteAppendResult> {
    const note: StoredNote | undefined = this.notes.get(id);
    if (note === undefined) {
      throw new Error(`no such note: ${id}`);
    }
    note.content = content;
    note.revision += 1;
    return { id: note.id, revision: note.revision };
  }

  async remove(id: string): Promise<void> {
    const note: StoredNote | undefined = this.notes.get(id);
    if (note === undefined) {
      throw new Error(`no such note: ${id}`);
    }
    note.deletedAtMs = this.nowMs();
  }

  async listTags(): Promise<NoteTagRow[]> {
    const out: NoteTagRow[] = [];
    for (const entry of this.tags.entries()) {
      out.push({ id: entry[0], name: entry[1] });
    }
    return out;
  }

  private nowMs(): number {
    return this.clock === undefined ? 0 : this.clock.nowMs();
  }
}

/** 以命中点为中心截取片段（最多 240 字符），供 clampSnippet 收敛断言。 */
function makeSnippet(haystack: string, idx: number): string {
  const start: number = Math.max(0, idx - 20);
  return haystack.slice(start, start + 240);
}
