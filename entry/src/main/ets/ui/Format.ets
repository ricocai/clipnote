/**
 * 展示格式化小工具（纯展示语义，无业务规则；收件箱页 / 笔记列表页共用）。
 *
 * 与领域层同纪律：这里只回答"怎么显示"，不回答"存什么"。
 */

/** 摘要折成单行短文本（正文本身不改动） */
export function flatPreview(text: string, maxChars: number): string {
  const flat: string = text.split('\n').join(' ');
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/** 相对时间标签（时间线展示） */
export function relativeTimeLabel(atMs: number): string {
  const diff: number = Date.now() - atMs;
  if (diff < 60 * 1000) {
    return '刚刚';
  }
  if (diff < 60 * 60 * 1000) {
    return `${Math.floor(diff / 60000)} 分钟前`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    return `${Math.floor(diff / 3600000)} 小时前`;
  }
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    return `${Math.floor(diff / 86400000)} 天前`;
  }
  const d: Date = new Date(atMs);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
