import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

export class AlreadyRunningError extends Error {
  constructor(readonly holder: { pid: number; started_at: string }) {
    super(`다른 RepoVault 백업 작업이 이미 실행 중입니다 (pid ${holder.pid}, 시작 ${holder.started_at}).`);
    this.name = 'AlreadyRunningError';
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 동일 PC에서 중복 실행을 막는 배타적 락 파일 (O_EXCL). 죽은 프로세스의 락은 자동 회수 */
export class AgentLock {
  private held = false;
  constructor(
    private readonly path: string,
    private readonly staleMs = 12 * 60 * 60 * 1000,
  ) {}

  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    for (let i = 0; i < 2; i++) {
      try {
        const fd = openSync(this.path, 'wx', 0o600);
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), started_at: new Date().toISOString() }));
        closeSync(fd);
        this.held = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        let holder = { pid: -1, started_at: '' };
        try {
          holder = JSON.parse(readFileSync(this.path, 'utf8'));
        } catch {
          /* 손상된 락 */
        }
        const stale = holder.pid <= 0 || !alive(holder.pid) || Date.now() - Date.parse(holder.started_at || '0') > this.staleMs;
        if (!stale) throw new AlreadyRunningError(holder);
        rmSync(this.path, { force: true });
      }
    }
    throw new Error('락 파일을 획득하지 못했습니다.');
  }

  release(): void {
    if (this.held && existsSync(this.path)) rmSync(this.path, { force: true });
    this.held = false;
  }
}
