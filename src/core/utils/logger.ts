import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sanitizeText } from './sanitize.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  repo?: string;
  data?: Record<string, unknown>;
}

/**
 * 작업 단위 로거. 모든 메시지는 기록 전에 민감정보를 제거한다.
 * 로그 파일은 작업 종료 후 Google Drive logs/ 폴더로 업로드된다.
 */
export class Logger {
  readonly entries: LogEntry[] = [];
  constructor(
    private readonly filePath?: string,
    private readonly echo: boolean = !process.env.REPOVAULT_QUIET,
    private readonly minLevel: LogLevel = 'info',
  ) {
    if (filePath) mkdirSync(dirname(filePath), { recursive: true });
  }

  private static order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

  log(level: LogLevel, msg: string, extra?: { repo?: string; data?: Record<string, unknown> }) {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg: sanitizeText(msg),
      ...(extra?.repo ? { repo: extra.repo } : {}),
      ...(extra?.data ? { data: JSON.parse(sanitizeText(JSON.stringify(extra.data))) } : {}),
    };
    this.entries.push(entry);
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
      } catch {
        /* 로그 기록 실패가 백업을 중단시키지 않는다 */
      }
    }
    if (this.echo && Logger.order[level] >= Logger.order[this.minLevel]) {
      const prefix = { debug: '·', info: '•', warn: '⚠', error: '✖' }[level];
      const line = `${prefix} ${extra?.repo ? `[${extra.repo}] ` : ''}${entry.msg}`;
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    }
  }
  debug(m: string, e?: { repo?: string; data?: Record<string, unknown> }) { this.log('debug', m, e); }
  info(m: string, e?: { repo?: string; data?: Record<string, unknown> }) { this.log('info', m, e); }
  warn(m: string, e?: { repo?: string; data?: Record<string, unknown> }) { this.log('warn', m, e); }
  error(m: string, e?: { repo?: string; data?: Record<string, unknown> }) { this.log('error', m, e); }

  toJsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }
}

export const silentLogger = () => new Logger(undefined, false);
