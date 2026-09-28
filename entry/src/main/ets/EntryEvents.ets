/**
 * 前台事件名（EntryAbility.onForeground 发布 → 页面订阅，S2-4）。
 * 字符串常量集中一处，避免发布/订阅两侧手抖打错。
 */
export const EVENT_FOREGROUND: string = 'clipnote:event:foreground';
