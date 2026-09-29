/**
 * NoteStoreLike 适配器（S6-7；设计 §4.5.5 工具语义落地）：
 * mcp core 的笔记结构端口（dispatcher.ts NoteStoreLike）→ common 的 NoteService/NoteRepository。
 *
 * 契约参照 tools/test/support/mcp-memory-note-store.ts（同一 NoteStoreLike 的内存实现），
 * 两处行为必须一致：
 *  - append：dispatcher 已把追加内容按 `${detail.content}\n\n${content}` 拼成整体
 *    （dispatcher.ts appendToNote），适配层**原样整存**（revision + 1），不再二次拼接；
 *  - remove：软删除（进回收站，不物理删除）；
 *  - getById：includeDeleted —— 回收站笔记对 dispatcher 可见，是否可触达由授权
 *    scope（includeTrash / 集合成员）把守，不在数据层提前隐藏。
 *
 * 本文件刻意用 .ts 而非 .ets：与 common/speech core 同一手法 —— 平台无关纯逻辑，
 * 需同时被 hvigor（entry 模块编译）与本机 tsc 基线（tools/）编译引用，.ets 进不了
 * 本机基线（同一源码两边编译的最低公共分母）。
 */

import { NoteRepository, NoteService, NoteSource } from 'common';
import {
  NoteAppendResult,
  NoteCreateResult,
  NoteDetail,
  NoteSearchRow,
  NoteStoreLike,
  NoteTagRow,
} from 'mcp';

export interface McpNoteStoreAdapterDeps {
  readonly service: NoteService;
  readonly notes: NoteRepository;
}

export class McpNoteStoreAdapter implements NoteStoreLike {
  constructor(private readonly deps: McpNoteStoreAdapterDeps) {}

  async search(query: string, limit: number): Promise<NoteSearchRow[]> {
    const hits = await this.deps.service.searchNotes(query, { limit: limit });
    const out: NoteSearchRow[] = [];
    for (let i: number = 0; i < hits.length; i++) {
      out.push({
        id: hits[i].id,
        title: hits[i].title,
        snippetText: hits[i].snippet.text,
      });
    }
    return out;
  }

  async getById(id: string): Promise<NoteDetail | undefined> {
    const note = await this.deps.notes.getById(id, true);
    if (note === undefined) {
      return undefined;
    }
    const tags = await this.deps.notes.listTagsOfNote(id);
    const tagIds: string[] = [];
    for (let i: number = 0; i < tags.length; i++) {
      tagIds.push(tags[i].id);
    }
    return {
      id: note.id,
      title: note.title,
      content: note.contentMd,
      revision: note.revision,
      deletedAtMs: note.deletedAtMs,
      tagIds: tagIds,
    };
  }

  async create(input: { title: string; content: string }): Promise<NoteCreateResult> {
    // source 标记 MCP：NoteService.save 的新建路径写死 MANUAL（UI 编辑口径），
    // 故此处直接走仓储 create，source = NoteSource.MCP（设计 §4.5.5 来源标记）。
    const note = await this.deps.notes.create({
      title: input.title,
      contentMd: input.content,
      source: NoteSource.MCP,
    });
    return { id: note.id, title: note.title, revision: note.revision };
  }

  async append(id: string, content: string): Promise<NoteAppendResult> {
    const existing = await this.deps.notes.getById(id, true);
    if (existing === undefined) {
      throw new Error(`McpNoteStoreAdapter.append: note ${id} not found`);
    }
    // 标题保持原值；正文为 dispatcher 拼好的整体，一次保存 = revision + 1（设计 §4.8）
    const saved = await this.deps.service.save({
      id: id,
      title: existing.title,
      contentMd: content,
    });
    return { id: saved.id, revision: saved.revision };
  }

  async remove(id: string): Promise<void> {
    await this.deps.service.moveToTrash(id);
  }

  async listTags(): Promise<NoteTagRow[]> {
    const tags = await this.deps.service.listAllTags();
    const out: NoteTagRow[] = [];
    for (let i: number = 0; i < tags.length; i++) {
      out.push({ id: tags[i].id, name: tags[i].name });
    }
    return out;
  }
}
