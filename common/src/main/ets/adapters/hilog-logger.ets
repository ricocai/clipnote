import { hilog } from '@kit.PerformanceAnalysisKit';
import { ILogger, LogLevel } from '../core/ports';

const DOMAIN: number = 0xF1C0;
const TAG: string = 'ClipNote';

/**
 * 系统日志实现。
 *
 * 审计口径（设计 §4.5.5）：只记事件名与结构化字段，**永不记完整正文**；
 * 调用方在构造 fields 时就必须遵守，本类不做兜底截断（截断会掩盖调用方的违规）。
 */
export class HilogLogger implements ILogger {
  log(level: LogLevel, event: string, fields: Record<string, string | number | boolean>): void {
    const detail: string = JSON.stringify(fields);
    if (level === LogLevel.ERROR) {
      hilog.error(DOMAIN, TAG, '%{public}s %{public}s', event, detail);
    } else if (level === LogLevel.WARN) {
      hilog.warn(DOMAIN, TAG, '%{public}s %{public}s', event, detail);
    } else if (level === LogLevel.INFO) {
      hilog.info(DOMAIN, TAG, '%{public}s %{public}s', event, detail);
    } else {
      hilog.debug(DOMAIN, TAG, '%{public}s %{public}s', event, detail);
    }
  }
}
