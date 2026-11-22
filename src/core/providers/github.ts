import { run } from '../utils/exec.js';
import { sanitizeUrl } from '../utils/sanitize.js';
import type { RepositoryTarget } from '../types.js';
import { CredentialKeys, type CredentialStore } from '../security/credential-store.js';
import type { GitAuth } from '../git/git-engine.js';

export class ProviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}
export class ProviderRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRateLimitError';
  }
}

export interface GitHubToken {
  token: string;
  source: 'credential-store' | 'env' | 'gh-cli' | 'git-credential';
}

export function repoId(provider: string, owner: string, name: string): string {
  return `${provider}-${owner}-${name}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

/**
 * GitHub 토큰 탐색 순서: RepoVault 자격 증명 → GITHUB_TOKEN/GH_TOKEN → `gh auth token` → git credential helper(OS 키체인)
 * 토큰 값은 절대 로그에 남기지 않는다.
 */
export async function resolveGitHubToken(creds: CredentialStore, host = 'github.com'): Promise<GitHubToken | null> {
  const stored = await creds.get(CredentialKeys.githubToken);
  if (stored) return { token: stored, source: 'credential-store' };
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return { token: env, source: 'env' };
  try {
    const r = await run('gh', ['auth', 'token', '--hostname', host], { allowFailure: true, timeoutMs: 15000 });
    if (r.code === 0 && r.stdout.trim()) return { token: r.stdout.trim(), source: 'gh-cli' };
  } catch {
    /* gh 미설치 */
  }
  try {
    const r = await run('git', ['credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      allowFailure: true,
      timeoutMs: 20000,
    });
    if (r.code === 0) {
      const pw = /^password=(.+)$/m.exec(r.stdout)?.[1];
      if (pw) return { token: pw.trim(), source: 'git-credential' };
    }
  } catch {
    /* ignore */
  }
  return null;
}

interface GhRepo {
  name: string;
  full_name: string;
  owner: { login: string; type: string };
  private: boolean;
  archived: boolean;
  fork: boolean;
  clone_url: string;
  default_branch: string;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export interface GitHubListOptions {
  includeOrgs: string[];
  includeCollaborator: boolean;
  includeArchived: boolean;
  includeForks: boolean;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export class GitHubAdapter {
  readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly token: string,
    opts: { apiBase?: string; fetchImpl?: typeof fetch } = {},
  ) {
    this.apiBase = (opts.apiBase ?? process.env.REPOVAULT_GITHUB_API ?? 'https://api.github.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get(url: string): Promise<Response> {
    const res = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'RepoVault-Desktop',
      },
    });
    if (res.status === 401) throw new ProviderAuthError('GitHub 인증이 만료되었거나 유효하지 않습니다. 토큰을 다시 설정해 주세요.');
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new ProviderRateLimitError('GitHub API 요청 한도를 초과했습니다. 잠시 후 다시 시도합니다.');
    }
    if (!res.ok) throw new Error(`GitHub API 오류 ${res.status}`);
    return res;
  }

  /** 코드 읽기(Contents) 권한 확인. 403/404면 false, 그 외 오류는 판단 보류(true) */
  async checkContentsAccess(owner: string, name: string): Promise<boolean> {
    try {
      await this.get(`${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits?per_page=1`);
      return true;
    } catch (e) {
      if (e instanceof ProviderAuthError) return false;
      return !/오류 (403|404)$/.test((e as Error).message) || /오류 409$/.test((e as Error).message);
    }
  }

  async currentUser(): Promise<{ login: string; scopes: string[] }> {
    const res = await this.get(`${this.apiBase}/user`);
    const body = (await res.json()) as { login: string };
    const scopes = (res.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return { login: body.login, scopes };
  }

  /** 페이지네이션(Link: rel="next")을 따라 100개 이상 저장소도 누락 없이 조회 */
  async listRepositories(opts: GitHubListOptions): Promise<RepositoryTarget[]> {
    const me = await this.currentUser();
    const repos: GhRepo[] = [];
    let url: string | null = `${this.apiBase}/user/repos?per_page=100&visibility=all&affiliation=owner,collaborator,organization_member&sort=full_name`;
    while (url) {
      const res = await this.get(url);
      repos.push(...((await res.json()) as GhRepo[]));
      const link = res.headers.get('link') ?? '';
      url = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
    }
    const orgs = new Set(opts.includeOrgs.map((o) => o.toLowerCase()));
    return repos
      .filter((r) => {
        const owner = r.owner.login.toLowerCase();
        if (owner === me.login.toLowerCase()) return true;
        if (r.owner.type === 'Organization' && orgs.has(owner)) return true;
        return opts.includeCollaborator && r.owner.type === 'User';
      })
      .filter((r) => opts.includeArchived || !r.archived)
      .filter((r) => opts.includeForks || !r.fork)
      .map<RepositoryTarget>((r) => ({
        id: repoId('github', r.owner.login, r.name),
        provider: 'github',
        owner: r.owner.login,
        name: r.name,
        remoteUrl: sanitizeUrl(r.clone_url),
        cloneUrl: sanitizeUrl(r.clone_url),
        private: r.private,
        archived: r.archived,
        fork: r.fork,
        enabled: true,
        source: 'discovered',
        defaultBranch: r.default_branch,
      }));
  }
}

export function githubGitAuth(token: string): GitAuth {
  return { urlPrefix: 'https://github.com/', username: 'x-access-token', token };
}
