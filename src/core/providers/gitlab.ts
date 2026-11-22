import { sanitizeUrl } from '../utils/sanitize.js';
import type { RepositoryTarget } from '../types.js';
import { ProviderAuthError, repoId } from './github.js';
import type { GitAuth } from '../git/git-engine.js';

interface GlProject {
  path: string;
  path_with_namespace: string;
  namespace: { full_path: string };
  visibility: string;
  archived: boolean;
  http_url_to_repo: string;
  default_branch?: string;
}

/** GitLab: 소유 프로젝트 목록 (Personal Access Token, read_api + read_repository) */
export class GitLabAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listRepositories(): Promise<RepositoryTarget[]> {
    const out: RepositoryTarget[] = [];
    let page = 1;
    for (;;) {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/api/v4/projects?owned=true&per_page=100&page=${page}`, {
        headers: { 'PRIVATE-TOKEN': this.token },
      });
      if (res.status === 401) throw new ProviderAuthError('GitLab 토큰이 유효하지 않습니다.');
      if (!res.ok) throw new Error(`GitLab API 오류 ${res.status}`);
      const list = (await res.json()) as GlProject[];
      for (const p of list) {
        out.push({
          id: repoId('gitlab', p.namespace.full_path, p.path),
          provider: 'gitlab',
          owner: p.namespace.full_path,
          name: p.path,
          remoteUrl: sanitizeUrl(p.http_url_to_repo),
          cloneUrl: sanitizeUrl(p.http_url_to_repo),
          private: p.visibility !== 'public',
          archived: p.archived,
          enabled: true,
          source: 'discovered',
          defaultBranch: p.default_branch,
        });
      }
      const next = res.headers.get('x-next-page');
      if (!next) break;
      page = Number(next);
    }
    return out;
  }
}

export function gitlabGitAuth(baseUrl: string, token: string): GitAuth {
  return { urlPrefix: baseUrl.replace(/\/?$/, '/'), username: 'oauth2', token };
}
