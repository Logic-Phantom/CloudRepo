import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitEngine } from './git-engine.js';
import type { SubmoduleInfo } from '../types.js';
import { sanitizeUrl } from '../utils/sanitize.js';

/**
 * .gitmodules 와 gitlink 엔트리를 분석해 Submodule 메타데이터를 기록한다.
 * Submodule은 별도 저장소이므로 상위 Bundle에 포함된 것으로 간주하지 않는다.
 */
export async function analyzeSubmodules(
  git: GitEngine,
  repoDir: string,
  headRef: string | null,
  knownRemoteUrls: string[],
): Promise<SubmoduleInfo[]> {
  if (!headRef) return [];
  const content = await git.catFile(repoDir, `${headRef}:.gitmodules`);
  if (!content) return [];
  const tmp = mkdtempSync(join(tmpdir(), 'rv-gm-'));
  try {
    const file = join(tmp, 'gitmodules');
    writeFileSync(file, content);
    const r = await git.exec(['config', '--file', file, '--list'], { allowFailure: true });
    const entries = new Map<string, { path?: string; url?: string }>();
    for (const line of r.stdout.split('\n')) {
      const m = /^submodule\.(.+)\.(path|url)=(.*)$/.exec(line);
      if (!m) continue;
      const e = entries.get(m[1]!) ?? {};
      e[m[2] as 'path' | 'url'] = m[3]!;
      entries.set(m[1]!, e);
    }
    const links = await git.lsTreeGitlinks(repoDir, headRef);
    const normalize = (u: string) => sanitizeUrl(u).replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
    const known = new Set(knownRemoteUrls.map(normalize));
    return [...entries.values()]
      .filter((e) => e.path)
      .map((e) => {
        const url = sanitizeUrl(e.url ?? '');
        const tracked = url ? known.has(normalize(url)) : false;
        return {
          path: e.path!,
          url,
          commit: links.find((l) => l.path === e.path)?.commit ?? null,
          included_in_backup: false,
          accessible: 'unknown' as const,
          restorable: tracked,
        };
      });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
