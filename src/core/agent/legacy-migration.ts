import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { RuntimeContext } from '../context.js';
import { GitEngine } from '../git/git-engine.js';
import { backupRepository } from './backup-runner.js';
import { repoId } from '../providers/github.js';
import type { RepoBackupResult, RepositoryTarget } from '../types.js';

function isBareRepo(dir: string): boolean {
  return existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'objects')) && existsSync(join(dir, 'refs'));
}

/** 기존 로컬 Bare Repository 백업 검색 (최대 깊이 4) */
export function findLegacyRepositories(root: string, depth = 4): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    if (d < 0) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (isBareRepo(dir)) {
      out.push(dir);
      return;
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) walk(join(dir, e.name), d - 1);
  };
  walk(resolve(root), depth);
  return out;
}

/**
 * Legacy Migration: 기존 로컬 백업을 Drive로 이전한다.
 * 저장소별 Bundle 생성 → 업로드 → 검증 → Manifest 등록. 기존 로컬 데이터는 절대 삭제하지 않는다.
 */
export async function migrateLegacy(ctx: RuntimeContext, root: string): Promise<Array<RepoBackupResult & { path: string }>> {
  const repos = findLegacyRepositories(root);
  const git = new GitEngine();
  await ctx.folders.ensureStructure();
  const results: Array<RepoBackupResult & { path: string }> = [];
  for (const path of repos) {
    if (!statSync(path).isDirectory()) continue;
    const name = basename(path).replace(/\.git$/, '');
    const target: RepositoryTarget = {
      id: repoId('legacy', 'local', name),
      provider: 'legacy',
      owner: 'local',
      name,
      remoteUrl: path,
      cloneUrl: path,
      private: true,
      archived: false,
      enabled: true,
      source: 'legacy',
    };
    const r = await backupRepository(ctx, git, target, [], { force: false });
    results.push({ ...r, path });
  }
  return results;
}
