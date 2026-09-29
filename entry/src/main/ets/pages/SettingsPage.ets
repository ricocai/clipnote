import { router } from '@kit.ArkUI';
import {
  AppDataRuntime,
  McpAuditEntry,
  McpAuditQuery,
  McpAuditResult,
} from 'common';

/**
 * 设置页（首期只承载 MCP 审计查询，S6-1；设计 §4.5.5）。
 *
 * 审计展示纪律与落库一致：只展示元数据（客户端、工具、对象 ID、结果、时间、
 * 载荷字节数），不存在正文入口 —— 审计页本身不得成为数据泄露面。
 * 本页只读：不提供清空/删除入口（审计只增不改，见 McpAuditRepository 头注释）。
 */

/** 结果过滤选项（UI 态，全部 = 不按结果过滤） */
type ResultFilter = 'all' | McpAuditResult;

interface AuditRow {
  readonly id: number;
  readonly clientId: string;
  readonly tool: string;
  readonly result: McpAuditResult;
  readonly resultLabel: string;
  readonly objectIdsLabel: string;
  readonly payloadLabel: string;
  readonly timeLabel: string;
}

function resultLabel(r: McpAuditResult): string {
  if (r === 'ok') {
    return '放行';
  }
  if (r === 'denied') {
    return '拒绝';
  }
  return '错误';
}

function resultColor(r: McpAuditResult): string {
  if (r === 'ok') {
    return '#237804';
  }
  if (r === 'denied') {
    return '#D4380D';
  }
  return '#FA8C16';
}

function timeLabel(atMs: number): string {
  const d: Date = new Date(atMs);
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toRow(e: McpAuditEntry): AuditRow {
  return {
    id: e.id,
    clientId: e.clientId,
    tool: e.tool,
    result: e.result,
    resultLabel: resultLabel(e.result),
    objectIdsLabel: e.objectIds.length === 0 ? '无触及对象' : `对象 ${e.objectIds.length} 个：${e.objectIds.join(', ')}`,
    payloadLabel: `载荷 ${e.payloadBytes} B`,
    timeLabel: timeLabel(e.atMs),
  };
}

@Entry
@Component
struct SettingsPage {
  @State rows: AuditRow[] = [];
  @State total: number = 0;
  @State filter: ResultFilter = 'all';
  @State notice: string = '';
  @State ready: boolean = false;

  aboutToAppear(): void {
    this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const rt: AppDataRuntime = await AppDataRuntime.whenReady();
      let query: McpAuditQuery = {};
      if (this.filter === 'ok' || this.filter === 'denied' || this.filter === 'error') {
        query = { result: this.filter };
      }
      const entries: McpAuditEntry[] = await rt.mcpAudit.query(query);
      const rows: AuditRow[] = [];
      for (let i: number = 0; i < entries.length; i++) {
        rows.push(toRow(entries[i]));
      }
      this.rows = rows;
      this.total = await rt.mcpAudit.count(query);
      this.ready = true;
      this.notice = '';
    } catch (err) {
      this.notice = `审计读取失败：${String(err)}`;
    }
  }

  private setFilter(f: ResultFilter): void {
    this.filter = f;
    this.refresh();
  }

  build() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Button('返回')
          .onClick(() => {
            router.back();
          })
        Text('设置 · MCP 访问审计')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
      }
      .width('100%')

      Text('审计只记录客户端、工具、对象 ID、结果与时间，不记录笔记正文与访问令牌。')
        .fontSize(12)
        .fontColor('#8C8C8C')
        .width('100%')

      Row({ space: 8 }) {
        Button('全部')
          .fontSize(12)
          .height(30)
          .backgroundColor(this.filter === 'all' ? '#1F6FEB' : '#F5F5F5')
          .fontColor(this.filter === 'all' ? '#FFFFFF' : '#333333')
          .onClick(() => {
            this.setFilter('all');
          })
        Button('放行')
          .fontSize(12)
          .height(30)
          .backgroundColor(this.filter === 'ok' ? '#1F6FEB' : '#F5F5F5')
          .fontColor(this.filter === 'ok' ? '#FFFFFF' : '#333333')
          .onClick(() => {
            this.setFilter('ok');
          })
        Button('拒绝')
          .fontSize(12)
          .height(30)
          .backgroundColor(this.filter === 'denied' ? '#1F6FEB' : '#F5F5F5')
          .fontColor(this.filter === 'denied' ? '#FFFFFF' : '#333333')
          .onClick(() => {
            this.setFilter('denied');
          })
        Button('错误')
          .fontSize(12)
          .height(30)
          .backgroundColor(this.filter === 'error' ? '#1F6FEB' : '#F5F5F5')
          .fontColor(this.filter === 'error' ? '#FFFFFF' : '#333333')
          .onClick(() => {
            this.setFilter('error');
          })
        Button('刷新')
          .fontSize(12)
          .height(30)
          .backgroundColor('#F5F5F5')
          .fontColor('#333333')
          .onClick(() => {
            this.refresh();
          })
      }
      .width('100%')

      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(13)
          .fontColor('#D4380D')
          .width('100%')
      }

      if (!this.ready) {
        Text('读取中…')
          .fontSize(13)
          .fontColor('#8C8C8C')
          .width('100%')
      } else if (this.rows.length === 0) {
        Text(`暂无审计记录（共 ${this.total} 条）。MCP 服务开启并有调用后，这里会逐条列出。`)
          .fontSize(13)
          .fontColor('#8C8C8C')
          .width('100%')
      } else {
        Text(`共 ${this.total} 条，展示最近 ${this.rows.length} 条`)
          .fontSize(12)
          .fontColor('#8C8C8C')
          .width('100%')
        List({ space: 8 }) {
          ForEach(this.rows, (row: AuditRow) => {
            ListItem() {
              Column({ space: 4 }) {
                Row({ space: 8 }) {
                  Text(row.tool)
                    .fontSize(14)
                    .fontWeight(FontWeight.Medium)
                    .layoutWeight(1)
                  Text(row.resultLabel)
                    .fontSize(12)
                    .fontColor(resultColor(row.result))
                }
                .width('100%')
                Text(`客户端 ${row.clientId} · ${row.payloadLabel}`)
                  .fontSize(12)
                  .fontColor('#595959')
                  .width('100%')
                Text(row.objectIdsLabel)
                  .fontSize(11)
                  .fontColor('#8C8C8C')
                  .width('100%')
                  .maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                Text(row.timeLabel)
                  .fontSize(11)
                  .fontColor('#8C8C8C')
                  .width('100%')
              }
              .alignItems(HorizontalAlign.Start)
              .width('100%')
              .padding(10)
              .backgroundColor('#F5F5F5')
              .borderRadius(8)
            }
          }, (row: AuditRow) => `${row.id}`)
        }
        .layoutWeight(1)
        .width('100%')
      }
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }
}
