import { spawn } from 'node:child_process';
import { sanitizeText, sanitizeUrl } from './sanitize.js';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  timeoutMs?: number;
  /** true면 종료 코드가 0이 아니어도 예외를 던지지 않는다 */
  allowFailure?: boolean;
  maxBuffer?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly args: string[],
    public readonly result: ExecResult,
  ) {
    const shown = [command, ...args.map((a) => sanitizeUrl(a))].join(' ');
    super(sanitizeText(`명령 실패 (code ${result.code}): ${shown}\n${result.stderr.trim()}`));
    this.name = 'CommandError';
  }
}

/**
 * 외부 명령을 인자 배열로 실행한다. Shell 문자열 조합을 절대 사용하지 않는다.
 */
export function run(command: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const maxBuffer = opts.maxBuffer ?? 256 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let timer: NodeJS.Timeout | undefined;
    let killedByTimeout = false;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        killedByTimeout = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
    }
    child.stdout.on('data', (d: Buffer) => {
      outLen += d.length;
      if (outLen <= maxBuffer) out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.reduce((n, b) => n + b.length, 0) < 4 * 1024 * 1024) err.push(d);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const result: ExecResult = {
        code: killedByTimeout ? 124 : (code ?? -1),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + (killedByTimeout ? '\n[timeout]' : ''),
      };
      if (result.code !== 0 && !opts.allowFailure) reject(new CommandError(command, args, result));
      else resolve(result);
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** 명령 존재 여부 확인 */
export async function commandExists(command: string, versionArgs: string[] = ['--version']): Promise<string | null> {
  try {
    const r = await run(command, versionArgs, { allowFailure: true, timeoutMs: 15000 });
    if (r.code !== 0) return null;
    return (r.stdout || r.stderr).trim().split('\n')[0] ?? '';
  } catch {
    return null;
  }
}
