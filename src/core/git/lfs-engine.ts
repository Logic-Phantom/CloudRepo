import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import { createReadStream } from 'node:fs';
import * as tar from 'tar';
import type { GitEngine } from './git-engine.js';
import type { LfsInfo, RefMap } from '../types.js';

/** 브랜치 tip들의 .gitattributes를 검사해 LFS 사용 여부를 판단한다 */
export async function detectLfs(git: GitEngine, repoDir: string, refs: RefMap): Promise<boolean> {
  const heads = Object.keys(refs).filter((r) => r.startsWith('refs/heads/')).slice(0, 50);
  for (const ref of heads) {
    const content = await git.catFile(repoDir, `${ref}:.gitattributes`);
    if (content && /filter=lfs/.test(content)) return true;
  }
  return false;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * LFS 객체를 fetch 후 tar.zst 아카이브로 만든다.
 * Git Bundle에는 LFS 실제 객체가 포함되지 않으므로 별도로 보관한다.
 */
export async function backupLfs(
  git: GitEngine,
  repoDir: string,
  url: string,
  refs: RefMap,
  archivePath: string,
): Promise<LfsInfo> {
  const used = await detectLfs(git, repoDir, refs);
  if (!used) return { status: 'not_used', object_count: 0, total_size: 0 };
  const lfsVer = await git.lfsVersion();
  if (!lfsVer) {
    return {
      status: 'tool_missing',
      object_count: 0,
      total_size: 0,
      message: 'git-lfs가 설치되어 있지 않아 LFS 객체를 백업하지 못했습니다. (Git 커밋은 백업됨)',
    };
  }
  const r = await git.exec(['-C', repoDir, 'lfs', 'fetch', '--all', url], { allowFailure: true });
  if (r.code !== 0) {
    return { status: 'failed', object_count: 0, total_size: 0, message: `git lfs fetch 실패: ${r.stderr.trim().slice(0, 500)}` };
  }
  const objectsDir = join(repoDir, 'lfs', 'objects');
  const files = walk(objectsDir);
  const objects = files.map((f) => ({ oid: f.split(/[\\/]/).pop()!, size: statSync(f).size }));
  if (!files.length) return { status: 'complete', object_count: 0, total_size: 0, objects: [] };
  const rel = files.map((f) => relative(join(repoDir, 'lfs'), f));
  await pipeline(tar.c({ cwd: join(repoDir, 'lfs'), portable: true }, rel), createZstdCompress(), createWriteStream(archivePath));
  return {
    status: 'complete',
    object_count: objects.length,
    total_size: objects.reduce((n, o) => n + o.size, 0),
    objects,
  };
}

/** 복원 시 LFS 아카이브를 .git/lfs 로 풀어준다 */
export async function extractLfsArchive(archivePath: string, lfsDir: string) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(lfsDir, { recursive: true });
  await pipeline(createReadStream(archivePath), createZstdDecompress(), tar.x({ cwd: lfsDir }));
}
