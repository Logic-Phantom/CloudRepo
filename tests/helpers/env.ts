import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RuntimeContext } from '../../src/core/context.js';
import { MemoryCredentialStore } from '../../src/core/security/credential-store.js';
import { StaticTokenProvider } from '../../src/core/cloud/oauth.js';
import { resolveAppPaths } from '../../src/core/utils/paths.js';
import { Logger } from '../../src/core/utils/logger.js';
import type { RepositoryTarget } from '../../src/core/types.js';
import { MockDriveServer } from './mock-drive.js';

export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function tmp(prefix = 'rv-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 원격 역할 bare 저장소 + 작업용 clone (한글/공백 경로 포함) */
export class FakeRemote {
  readonly root = tmp('rv-remote-');
  readonly bare = join(this.root, '원격 저장소.git');
  readonly work = join(this.root, '작업 사본');
  constructor() {
    mkdirSync(this.bare, { recursive: true });
    git(this.bare, 'init', '--bare', '--quiet', '-b', 'main');
    git(this.root, 'clone', '--quiet', this.bare, this.work);
    git(this.work, 'checkout', '-q', '-b', 'main');
  }
  commit(file: string, content: string, msg = `update ${file}`): string {
    writeFileSync(join(this.work, file), content);
    git(this.work, 'add', '-A');
    git(this.work, 'commit', '-q', '-m', msg);
    return git(this.work, 'rev-parse', 'HEAD');
  }
  push(...refs: string[]) {
    git(this.work, 'push', '-q', 'origin', ...(refs.length ? refs : ['main']));
  }
  target(id = 'custom-test-repo'): RepositoryTarget {
    return {
      id,
      provider: 'custom',
      owner: 'test',
      name: 'repo',
      remoteUrl: this.bare,
      cloneUrl: this.bare,
      private: true,
      archived: false,
      enabled: true,
      source: 'manual',
    };
  }
  destroy() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export function makeContext(drive: MockDriveServer, home = tmp('rv-home-'), creds = new MemoryCredentialStore()) {
  const paths = resolveAppPaths({ REPOVAULT_HOME: home });
  const ctx = new RuntimeContext({
    paths,
    creds,
    tokens: new StaticTokenProvider(drive.token),
    driveEndpoints: drive.endpoints,
    logger: new Logger(undefined, false),
    retryBaseMs: 2,
  });
  ctx.configStore.update((c) => {
    c.github.enabled = false;
    c.upload.chunk_size_mb = 0.25;
  });
  ctx.reloadConfig();
  ctx.cfg.upload.chunk_size_mb = 0.25;
  return { ctx, home, creds };
}

export async function startDrive() {
  return new MockDriveServer().start();
}
