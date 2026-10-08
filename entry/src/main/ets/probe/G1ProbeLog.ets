import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

/**
 * G1 探测日志（WHY-90，临时设施，G1 验收后可整体移除）。
 *
 * 每条探测结果同时写 hilog 与沙箱 JSONL 文件（filesDir/g1-probe.jsonl），
 * 真机执行后用 hdc 拉回即可归档到 tools/report/。
 */
const DOMAIN: number = 0xF1C0;
const TAG: string = 'ClipNoteG1Probe';

export interface G1ProbeEntry {
  readonly ts: string;
  readonly scene: string;
  readonly ok: boolean;
  readonly detail: string;
}

export class G1ProbeLog {
  private static buffer: G1ProbeEntry[] = [];
  private static logPath: string = '';

  static init(filesDir: string): void {
    G1ProbeLog.logPath = `${filesDir}/g1-probe.jsonl`;
  }

  static path(): string {
    return G1ProbeLog.logPath;
  }

  static record(scene: string, ok: boolean, detail: string): G1ProbeEntry {
    const entry: G1ProbeEntry = {
      ts: new Date().toISOString(),
      scene: scene,
      ok: ok,
      detail: detail,
    };
    G1ProbeLog.buffer.push(entry);
    hilog.info(DOMAIN, TAG, '[%{public}s] ok=%{public}s %{public}s', scene, String(ok), detail);
    G1ProbeLog.appendToFile(entry);
    return entry;
  }

  static entries(): G1ProbeEntry[] {
    return G1ProbeLog.buffer;
  }

  private static appendToFile(entry: G1ProbeEntry): void {
    if (G1ProbeLog.logPath.length === 0) {
      return;
    }
    try {
      const file = fs.openSync(
        G1ProbeLog.logPath,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.APPEND,
      );
      fs.writeSync(file.fd, `${JSON.stringify(entry)}\n`);
      fs.closeSync(file);
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'probe log write failed: %{public}s', JSON.stringify(err));
    }
  }
}
