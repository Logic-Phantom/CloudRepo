import type { RuntimeContext } from './context.js';
import { GitHubAdapter, githubGitAuth, resolveGitHubToken, type GitHubToken } from './providers/github.js';
import { GitLabAdapter, gitlabGitAuth } from './providers/gitlab.js';
import { manualRemoteToTarget } from './providers/generic-git.js';
import { CredentialKeys } from './security/credential-store.js';
import type { GitAuth } from './git/git-engine.js';
import type { RepositoryTarget } from './types.js';
import { sanitizeError } from './utils/sanitize.js';

export interface DiscoveryResult {
  targets: RepositoryTarget[];
  /** 원격 목록에서 사라졌지만 Drive에 백업이 있는 저장소 (백업은 유지) */
  missing: RepositoryTarget[];
  auth: GitAuth[];
  errors: string[];
  github: { login: string | null; tokenSource: GitHubToken['source'] | null; ok: boolean };
}

/**
 * 백업 대상 목록 갱신.
 * - 인증/API/Rate Limit 오류는 "저장소 삭제"로 판단하지 않는다 (해당 provider 목록 조회 실패로 처리).
 * - 목록에서 사라진 저장소는 remote_missing 으로 표시하고 Drive 백업은 그대로 둔다.
 * - 이미 Drive에 백업 이력이 있는 저장소는 목록 조회가 실패해도 캐시된 정보로 계속 시도한다.
 */
export async function discoverTargets(ctx: RuntimeContext): Promise<DiscoveryResult> {
  const cfg = ctx.cfg;
  const errors: string[] = [];
  const auth: GitAuth[] = [];
  const byId = new Map<string, RepositoryTarget>();
  const okProviders = new Set<string>();
  const github: DiscoveryResult['github'] = { login: null, tokenSource: null, ok: false };

  if (cfg.github.enabled) {
    const tok = await resolveGitHubToken(ctx.creds);
    if (!tok) {
      errors.push('GitHub 토큰을 찾을 수 없습니다. `repovault github login` 또는 `gh auth login`으로 인증해 주세요.');
    } else {
      github.tokenSource = tok.source;
      const gitAuth = githubGitAuth(tok.token);
      auth.push(gitAuth);
      try {
        const gh = new GitHubAdapter(tok.token);
        github.login = (await gh.currentUser()).login;
        // fine-grained 토큰 호환: Basic 인증 사용자명으로 실제 GitHub 로그인 사용
        gitAuth.username = github.login;
        const list = await gh.listRepositories({
          includeOrgs: cfg.github.include_orgs,
          includeCollaborator: cfg.github.include_collaborator_repos,
          includeArchived: cfg.github.include_archived,
          includeForks: cfg.github.include_forks,
        });
        for (const t of list) byId.set(t.id, t);
        // 목록 조회(Metadata 권한)는 되지만 코드 읽기(Contents 권한)가 없으면 git fetch가 전부 실패하므로 미리 진단
        const probe = list.find((t) => t.private) ?? list[0];
        if (probe) {
          const access = await gh.checkContentsAccess(probe.owner, probe.name);
          if (!access) {
            errors.push(
              'GitHub 토큰에 저장소 코드 읽기 권한이 없습니다. fine-grained 토큰이면 Repository permissions → Contents: Read-only 를 추가하세요 (Metadata만으로는 목록 조회만 가능).',
            );
          }
        }
        okProviders.add('github');
        github.ok = true;
      } catch (e) {
        errors.push(`GitHub 저장소 목록 조회 실패: ${sanitizeError(e)}`);
      }
    }
  }

  if (cfg.gitlab.enabled) {
    const tok = await ctx.creds.get(CredentialKeys.gitlabToken);
    if (tok) {
      auth.push(gitlabGitAuth(cfg.gitlab.base_url, tok));
      try {
        for (const t of await new GitLabAdapter(cfg.gitlab.base_url, tok).listRepositories()) byId.set(t.id, t);
        okProviders.add('gitlab');
      } catch (e) {
        errors.push(`GitLab 목록 조회 실패: ${sanitizeError(e)}`);
      }
    } else errors.push('GitLab이 활성화되어 있지만 토큰이 없습니다.');
  }

  for (const m of cfg.manual_remotes) {
    const t = manualRemoteToTarget(m);
    byId.set(t.id, t);
  }

  // Drive 백업 이력이 있는 저장소 병합
  const missing: RepositoryTarget[] = [];
  const previouslyKnown = new Set<string>(JSON.parse(ctx.cache.getKv('known_target_ids') ?? '[]') as string[]);
  for (const row of ctx.cache.listRepositories()) {
    const id = String(row.id);
    previouslyKnown.add(id);
    if (byId.has(id)) continue;
    const t: RepositoryTarget = {
      id,
      provider: row.provider as RepositoryTarget['provider'],
      owner: String(row.owner),
      name: String(row.name),
      remoteUrl: String(row.remote_url_sanitized ?? ''),
      cloneUrl: String(row.remote_url_sanitized ?? ''),
      private: !!row.private,
      archived: !!row.archived,
      enabled: true,
      source: 'discovered',
    };
    if (okProviders.has(t.provider)) missing.push(t);
    else if (t.cloneUrl) byId.set(id, t); // 목록 조회 실패 → 캐시 정보로 계속 백업 시도
  }

  const excluded = new Set(cfg.excluded_repository_ids);
  const targets = [...byId.values()].map((t) => ({ ...t, enabled: t.enabled && !excluded.has(t.id) }));
  // 신규 저장소 자동 등록 OFF면 이전에 알려진 저장소만 활성화
  if (!cfg.github.auto_add_new && previouslyKnown.size) {
    for (const t of targets) if (t.source === 'discovered' && !previouslyKnown.has(t.id)) t.enabled = false;
  }
  ctx.cache.setKv('known_target_ids', JSON.stringify([...new Set([...previouslyKnown, ...targets.map((t) => t.id)])]));
  ctx.cache.setKv('targets', JSON.stringify(targets.map(({ cloneUrl: _c, ...rest }) => rest)));
  return { targets, missing, auth, errors, github };
}
