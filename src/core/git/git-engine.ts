import { CommandError, run, type ExecResult } from '../utils/exec.js';
import type { RefMap } from '../types.js';

/** Git 원격 인증 정보. 토큰은 명령 인자 대신 환경 변수(GIT_CONFIG_*)로 전달해 프로세스 목록 노출을 막는다. */
export interface GitAuth {
  /** 예: https://github.com/ */
  urlPrefix: string;
  /** Basic 인증용 사용자명 (GitHub: x-access-token) */
  username: string;
  token: string;
}

export interface GitEngineOptions {
  gitPath?: string;
  auth?: GitAuth[];
  timeoutMs?: number;
}

export type RemoteErrorKind = 'auth_error' | 'remote_unavailable' | 'network_error' | 'unknown';

export class GitRemoteError extends Error {
  constructor(
    public readonly kind: RemoteErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GitRemoteError';
  }
}

export function classifyRemoteError(stderr: string): RemoteErrorKind {
  const s = stderr.toLowerCase();
  if (/could not resolve host|failed to connect|connection timed out|network is unreachable|connection refused|operation timed out|\[timeout\]|ssl_error|unable to access.*(timed out|resolve)/.test(s))
    return 'network_error';
  if (/authentication failed|could not read username|invalid username or password|permission denied \(publickey\)|terminal prompts disabled|returned error: 401|returned error: 403/.test(s))
    return 'auth_error';
  if (/repository not found|not found|does not appear to be a git repository|no such file or directory|does not exist|returned error: 404/.test(s))
    return 'remote_unavailable';
  return 'unknown';
}

export class GitEngine {
  readonly git: string;
  private readonly auth: GitAuth[];
  private readonly timeoutMs: number;
  private versionCache: string | null = null;

  constructor(opts: GitEngineOptions = {}) {
    this.git = opts.gitPath ?? 'git';
    this.auth = opts.auth ?? [];
    this.timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000;
  }

  /** 비대화형 + 인증 헤더 주입 환경 */
  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
      LC_ALL: 'C',
      LANG: 'C',
      ...extra,
    };
    const entries: Array<[string, string]> = [
      ['core.quotepath', 'false'],
      ['protocol.file.allow', 'always'],
      ['advice.detachedHead', 'false'],
      ['init.defaultBranch', 'main'],
    ];
    for (const a of this.auth) {
      const basic = Buffer.from(`${a.username}:${a.token}`).toString('base64');
      entries.push([`http.${a.urlPrefix}.extraHeader`, `Authorization: Basic ${basic}`]);
    }
    env.GIT_CONFIG_COUNT = String(entries.length);
    entries.forEach(([k, v], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = k;
      env[`GIT_CONFIG_VALUE_${i}`] = v;
    });
    return env;
  }

  async exec(args: string[], opts: { cwd?: string; allowFailure?: boolean; input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    return run(this.git, args, {
      cwd: opts.cwd,
      env: this.env(),
      allowFailure: opts.allowFailure,
      input: opts.input,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
    });
  }

  async version(): Promise<string> {
    if (!this.versionCache) {
      const r = await this.exec(['--version']);
      this.versionCache = r.stdout.trim();
    }
    return this.versionCache;
  }

  async lfsVersion(): Promise<string | null> {
    const r = await this.exec(['lfs', 'version'], { allowFailure: true, timeoutMs: 15000 }).catch(() => null);
    return r && r.code === 0 ? r.stdout.trim() : null;
  }

  /** 원격 refs/heads/*, refs/tags/* 와 HEAD symref 조회 (fetch 없이 변경 감지) */
  async lsRemote(url: string): Promise<{ refs: RefMap; headSymref: string | null }> {
    const r = await this.exec(['ls-remote', '--symref', url], { allowFailure: true, timeoutMs: 5 * 60 * 1000 });
    if (r.code !== 0) {
      const kind = classifyRemoteError(r.stderr);
      throw new GitRemoteError(kind, new CommandError(this.git, ['ls-remote', url], r).message);
    }
    const refs: RefMap = {};
    let headSymref: string | null = null;
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      const symMatch = /^ref: (\S+)\tHEAD$/.exec(line);
      if (symMatch) {
        headSymref = symMatch[1]!;
        continue;
      }
      const [sha, name] = line.split('\t');
      if (!sha || !name) continue;
      if (name.endsWith('^{}')) continue;
      if (name.startsWith('refs/heads/') || name.startsWith('refs/tags/')) refs[name] = sha;
    }
    return { refs, headSymref };
  }

  async initBare(dir: string) {
    await this.exec(['init', '--bare', '--quiet', dir]);
  }

  /** 원격의 브랜치/태그를 임시 Bare 저장소로 fetch (PR refs 등은 제외) */
  async fetchAll(repoDir: string, url: string) {
    const r = await this.exec(
      ['-C', repoDir, 'fetch', '--quiet', '--no-write-fetch-head', '--no-auto-gc', url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'],
      { allowFailure: true },
    );
    if (r.code !== 0) {
      throw new GitRemoteError(classifyRemoteError(r.stderr), new CommandError(this.git, ['fetch', url], r).message);
    }
  }

  async forEachRef(repoDir: string, prefix = ''): Promise<RefMap> {
    const args = ['-C', repoDir, 'for-each-ref', '--format=%(objectname) %(refname)'];
    if (prefix) args.push(prefix);
    const r = await this.exec(args);
    const map: RefMap = {};
    for (const line of r.stdout.split('\n')) {
      const i = line.indexOf(' ');
      if (i > 0) map[line.slice(i + 1)] = line.slice(0, i);
    }
    return map;
  }

  async objectExists(repoDir: string, sha: string): Promise<boolean> {
    const r = await this.exec(['-C', repoDir, 'cat-file', '-e', sha], { allowFailure: true });
    return r.code === 0;
  }

  async isAncestor(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
    const r = await this.exec(['-C', repoDir, 'merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true });
    return r.code === 0;
  }

  async checkRefFormat(name: string): Promise<boolean> {
    const r = await this.exec(['check-ref-format', name], { allowFailure: true });
    return r.code === 0;
  }

  /** update-ref --stdin 으로 원자적 일괄 갱신 */
  async updateRefs(repoDir: string, ops: Array<{ op: 'update' | 'delete' | 'create'; ref: string; sha?: string }>) {
    if (!ops.length) return;
    const input =
      ops
        .map((o) => (o.op === 'delete' ? `delete ${o.ref}` : `${o.op === 'create' ? 'create' : 'update'} ${o.ref} ${o.sha}`))
        .join('\n') + '\n';
    await this.exec(['-C', repoDir, 'update-ref', '--stdin'], { input });
  }

  async setHeadSymref(repoDir: string, ref: string) {
    await this.exec(['-C', repoDir, 'symbolic-ref', 'HEAD', ref]);
  }

  async fetchBundle(repoDir: string, bundlePath: string, refspecs: string[], updateHeadOk = false) {
    // --no-tags: 명시한 refspec만 가져온다 (특정 브랜치 복원 시 태그 자동 추종 방지)
    const args = ['-C', repoDir, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-auto-gc'];
    if (updateHeadOk) args.push('--update-head-ok');
    await this.exec([...args, bundlePath, ...refspecs]);
  }

  async bundleCreate(repoDir: string, outPath: string) {
    await this.exec(['-C', repoDir, 'bundle', 'create', outPath, '--all'], { allowFailure: false });
  }

  async bundleVerify(repoDir: string, bundlePath: string): Promise<boolean> {
    const r = await this.exec(['-C', repoDir, 'bundle', 'verify', bundlePath], { allowFailure: true });
    return r.code === 0;
  }

  async bundleListHeads(repoDir: string, bundlePath: string): Promise<RefMap> {
    const r = await this.exec(['-C', repoDir, 'bundle', 'list-heads', bundlePath]);
    const map: RefMap = {};
    for (const line of r.stdout.split('\n')) {
      const i = line.indexOf(' ');
      if (i > 0) map[line.slice(i + 1)] = line.slice(0, i);
    }
    return map;
  }

  async fsck(repoDir: string): Promise<{ ok: boolean; output: string }> {
    const r = await this.exec(['-C', repoDir, 'fsck', '--full', '--no-dangling', '--no-progress'], { allowFailure: true });
    return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
  }

  async catFile(repoDir: string, spec: string): Promise<string | null> {
    const r = await this.exec(['-C', repoDir, 'cat-file', '-p', spec], { allowFailure: true });
    return r.code === 0 ? r.stdout : null;
  }

  async lsTreeGitlinks(repoDir: string, treeish: string): Promise<Array<{ path: string; commit: string }>> {
    const r = await this.exec(['-C', repoDir, 'ls-tree', '-r', '-z', treeish], { allowFailure: true });
    if (r.code !== 0) return [];
    return r.stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const tab = entry.indexOf('\t');
        const [mode, type, sha] = entry.slice(0, tab).split(' ');
        return { mode, type, sha, path: entry.slice(tab + 1) };
      })
      .filter((e) => e.mode === '160000' && e.type === 'commit')
      .map((e) => ({ path: e.path, commit: e.sha! }));
  }

  async revListCount(repoDir: string, include: string[], exclude: string[]): Promise<number | null> {
    if (!include.length) return 0;
    const r = await this.exec(['-C', repoDir, 'rev-list', '--count', '--stdin'], {
      allowFailure: true,
      input: [...include, ...exclude.map((e) => `^${e}`)].join('\n') + '\n',
    });
    if (r.code !== 0) return null;
    return Number.parseInt(r.stdout.trim(), 10);
  }
}
