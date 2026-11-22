import { basename } from 'node:path';
import { sanitizeUrl } from '../utils/sanitize.js';
import { newId } from '../utils/misc.js';
import type { ManualRemote } from '../config.js';
import type { ProviderKind, RepositoryTarget } from '../types.js';
import { repoId } from './github.js';

/** URL에서 owner/name 추정 (https, ssh, scp, 로컬 경로 지원) */
export function parseRemote(url: string): { host: string; owner: string; name: string } {
  const clean = sanitizeUrl(url);
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(clean);
  let host = 'local';
  let path: string;
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const u = new URL(clean);
      host = u.hostname || 'local';
      path = decodeURIComponent(u.pathname);
    } catch {
      path = clean;
    }
  }
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  const name = parts.pop() ?? basename(clean);
  const owner = parts.pop() ?? host;
  return { host, owner, name };
}

export function manualRemoteToTarget(m: ManualRemote): RepositoryTarget {
  return {
    id: repoId(m.provider, m.owner, m.name),
    provider: m.provider,
    owner: m.owner,
    name: m.name,
    remoteUrl: sanitizeUrl(m.url),
    cloneUrl: sanitizeUrl(m.url),
    private: m.private,
    archived: false,
    enabled: m.enabled,
    source: 'manual',
  };
}

export function createManualRemote(input: { url: string; name?: string; owner?: string; provider?: ProviderKind; private?: boolean }): ManualRemote {
  // 토큰/비밀번호가 포함된 URL은 저장 전에 sanitizeUrl로 제거된다 (인증은 Credential Helper 사용)
  const parsed = parseRemote(input.url);
  return {
    id: newId(),
    name: input.name ?? parsed.name,
    owner: input.owner ?? parsed.owner,
    provider: input.provider ?? 'custom',
    url: sanitizeUrl(input.url),
    private: input.private ?? true,
    enabled: true,
  };
}
