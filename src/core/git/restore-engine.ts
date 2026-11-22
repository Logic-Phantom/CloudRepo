import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RuntimeContext } from '../context.js';
import { GitEngine } from './git-engine.js';
import { TempWorkspace } from './temp-workspace.js';
import { extractLfsArchive } from './lfs-engine.js';
import { downloadVerified } from '../cloud/download-manager.js';
import { isRestorable } from '../cloud/manifest.js';
import { newId, stableStringify } from '../utils/misc.js';
import { sanitizeError, sanitizeUrl } from '../utils/sanitize.js';
import type { RefMap, RefsDocument, SnapshotManifest } from '../types.js';

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

export interface RestoreOptions {
  repositoryId: string;
  snapshotId?: string;
  destination: string;
  /** 특정 ref만 복원 (예: refs/heads/main, refs/tags/v1). 비우면 전체 */
  refs?: string[];
  /** 복원 후 origin 으로 설정할 원격 URL */
  setRemoteUrl?: string;
  /** 보호된 과거 ref(refs/repovault/*)도 복원 */
  includePreserved?: boolean;
}

export interface RestoreResult {
  repository_id: string;
  snapshot_id: string;
  destination: string;
  restored_refs: RefMap;
  verified: boolean;
  lfs: 'not_used' | 'restored' | 'archive_extracted_lfs_missing' | 'missing';
  warnings: string[];
}

export async function loadSnapshotManifest(ctx: RuntimeContext, repoId: string, snapshotId?: string): Promise<{ manifest: SnapshotManifest; manifestFileId: string }> {
  const idx = await ctx.index.readRepositoryIndex(repoId);
  if (!idx) throw new RestoreError(`Drive에서 저장소 인덱스를 찾을 수 없습니다: ${repoId}`);
  const candidates = idx.data.snapshots.filter((s) => s.manifest_file_id).sort((a, b) => b.created_at_utc.localeCompare(a.created_at_utc));
  const entry = snapshotId ? candidates.find((s) => s.snapshot_id === snapshotId || s.snapshot_id.startsWith(snapshotId)) : candidates.find((s) => s.restorable);
  if (!entry) throw new RestoreError(snapshotId ? `스냅샷을 찾을 수 없습니다: ${snapshotId}` : '복원 가능한 스냅샷이 없습니다.');
  const manifest = JSON.parse((await ctx.drive.downloadBuffer(entry.manifest_file_id!)).toString('utf8')) as SnapshotManifest;
  if (!isRestorable(manifest)) throw new RestoreError(`이 스냅샷은 업로드/검증이 완료되지 않아 복원할 수 없습니다 (${manifest.upload_status}/${manifest.verification_status}).`);
  return { manifest, manifestFileId: entry.manifest_file_id! };
}

function assertSafeDestination(dest: string) {
  if (existsSync(dest)) {
    const entries = readdirSync(dest);
    if (entries.length) throw new RestoreError(`복원 대상 폴더가 비어 있지 않습니다. 기존 파일을 덮어쓰지 않습니다: ${dest}`);
  }
}

/**
 * Google Drive만으로 복원:
 * 매니페스트 → 파일 다운로드 → SHA-256/크기 검증 → checksums 교차 검증 → bundle verify → 임시 bare import
 * → ref 검증 → 사용자가 지정한 (빈) 경로에 일반 Git 저장소 생성 → 검증 → 임시 파일 정리
 */
export async function restoreSnapshot(ctx: RuntimeContext, opts: RestoreOptions): Promise<RestoreResult> {
  const dest = resolve(opts.destination);
  assertSafeDestination(dest);
  const git = new GitEngine();
  const { manifest } = await loadSnapshotManifest(ctx, opts.repositoryId, opts.snapshotId);
  const ws = new TempWorkspace(join(ctx.workDir, 'restore'), newId());
  ws.create();
  const warnings: string[] = [];
  const log = ctx.log;
  try {
    const file = (name: string) => manifest.files.find((f) => f.name === name);
    const fetchFile = async (name: string) => {
      const f = file(name);
      if (!f?.file_id) return null;
      const p = join(ws.stagingDir, name);
      await downloadVerified(ctx.drive, f.file_id, p, { size: f.size, sha256: f.sha256, name });
      return p;
    };

    const refsPath = await fetchFile('refs.json');
    if (!refsPath) throw new RestoreError('refs.json 이 없습니다.');
    const refsDoc = JSON.parse(readFileSync(refsPath, 'utf8')) as RefsDocument;
    const sumsPath = await fetchFile('checksums.sha256');
    if (sumsPath) {
      const sums = new Map(
        readFileSync(sumsPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => [l.slice(66), l.slice(0, 64)] as const),
      );
      for (const f of manifest.files) {
        if (sums.has(f.name) && sums.get(f.name) !== f.sha256) throw new RestoreError(`checksums.sha256 과 manifest 해시가 다릅니다: ${f.name}`);
      }
    }

    mkdirSync(dest, { recursive: true });
    await git.exec(['init', '--quiet', dest]);

    let restored: RefMap = {};
    if (manifest.is_empty_repository) {
      log.info('빈 저장소 스냅샷입니다 — 빈 Git 저장소를 생성했습니다.');
    } else {
      log.info('Bundle 다운로드 및 검증 중...');
      const bundle = await fetchFile('repository.bundle');
      if (!bundle) throw new RestoreError('repository.bundle 이 없습니다.');
      await git.initBare(ws.gitDir);
      if (!(await git.bundleVerify(ws.gitDir, bundle))) throw new RestoreError('Bundle 검증 실패 — 손상된 스냅샷입니다.');
      await git.fetchBundle(ws.gitDir, bundle, ['+refs/*:refs/*']);
      const imported = await git.forEachRef(ws.gitDir);
      for (const [ref, sha] of Object.entries(refsDoc.all_refs)) {
        if (imported[ref] !== sha) throw new RestoreError(`임시 import 검증 실패: ${ref}`);
      }

      // 복원할 ref 선택
      let wanted = Object.keys(refsDoc.all_refs).filter((r) => r.startsWith('refs/heads/') || r.startsWith('refs/tags/') || (opts.includePreserved !== false && r.startsWith('refs/repovault/')));
      if (opts.refs?.length) {
        const req = opts.refs.map((r) => (r.startsWith('refs/') ? r : `refs/heads/${r}`));
        const missing = req.filter((r) => !(r in refsDoc.all_refs));
        if (missing.length) throw new RestoreError(`스냅샷에 없는 ref: ${missing.join(', ')}`);
        wanted = req;
      }
      const refspecs = wanted.map((r) => `+${r}:${r}`);
      await git.fetchBundle(dest, bundle, refspecs, true);

      const head = refsDoc.head_symref && wanted.includes(refsDoc.head_symref) ? refsDoc.head_symref : wanted.find((r) => r.startsWith('refs/heads/'));
      if (head) {
        await git.setHeadSymref(dest, head);
        await git.exec(['-C', dest, 'reset', '--hard', '--quiet', 'HEAD']);
      } else if (wanted.length) {
        await git.exec(['-C', dest, 'checkout', '--quiet', '--detach', refsDoc.all_refs[wanted[0]!]!]);
      }

      restored = await git.forEachRef(dest);
      for (const r of wanted) {
        if (restored[r] !== refsDoc.all_refs[r]) throw new RestoreError(`복원 검증 실패: ${r}`);
      }
      const fsck = await git.fsck(dest);
      if (!fsck.ok) throw new RestoreError(`복원 저장소 fsck 실패: ${fsck.output.slice(0, 300)}`);
    }

    // LFS
    let lfs: RestoreResult['lfs'] = 'not_used';
    if (manifest.lfs_status === 'complete') {
      const arc = await fetchFile('lfs-objects.tar.zst');
      if (arc) {
        await extractLfsArchive(arc, join(dest, '.git', 'lfs'));
        if (await git.lfsVersion()) {
          await git.exec(['-C', dest, 'lfs', 'checkout'], { allowFailure: true });
          lfs = 'restored';
        } else {
          lfs = 'archive_extracted_lfs_missing';
          warnings.push('LFS 객체는 .git/lfs 에 복원되었지만 git-lfs가 없어 작업 트리에 반영하지 않았습니다. git-lfs 설치 후 `git lfs checkout` 을 실행하세요.');
        }
      } else lfs = 'missing';
    } else if (manifest.lfs_status === 'tool_missing' || manifest.lfs_status === 'failed') {
      lfs = 'missing';
      warnings.push('이 스냅샷은 LFS 객체가 백업되지 않았습니다. Git 커밋은 복원되었지만 LFS 파일 내용은 포인터 상태입니다.');
    }

    if (opts.setRemoteUrl) {
      await git.exec(['-C', dest, 'remote', 'add', 'origin', sanitizeUrl(opts.setRemoteUrl)]);
    }

    // 복원 로그를 Drive에 보관
    try {
      const folder = await ctx.folders.ensureFolder(['logs', 'cloud-restore', new Date().toISOString().slice(0, 7)]);
      await ctx.drive.createSmallFile(
        `${new Date().toISOString().replace(/[:.]/g, '-')}_${manifest.snapshot_id}.json`,
        folder,
        stableStringify({ repository_id: manifest.repository_id, snapshot_id: manifest.snapshot_id, restored_ref_count: Object.keys(restored).length, warnings, device_id: ctx.cfg.device_id }),
        'application/json',
        { repovault_role: 'restore-log' },
      );
    } catch (e) {
      warnings.push(`복원 로그 업로드 실패: ${sanitizeError(e)}`);
    }

    return { repository_id: manifest.repository_id, snapshot_id: manifest.snapshot_id, destination: dest, restored_refs: restored, verified: true, lfs, warnings };
  } finally {
    const w = ws.cleanup();
    if (w) log.warn(w);
  }
}

/**
 * 원격 저장소로 복원(push). --mirror / --force 를 사용하지 않는다. 기본은 dry-run 미리보기.
 */
export async function pushRestoredRepository(repoPath: string, remoteUrl: string, opts: { refs?: string[]; execute: boolean }): Promise<string> {
  const git = new GitEngine();
  const refs = opts.refs?.length ? opts.refs : ['refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*'];
  const args = ['-C', repoPath, 'push', '--porcelain', ...(opts.execute ? [] : ['--dry-run']), remoteUrl, ...refs];
  const r = await git.exec(args, { allowFailure: true });
  if (r.code !== 0) throw new RestoreError(`push ${opts.execute ? '' : '미리보기 '}실패 (기존 ref 덮어쓰기는 수행하지 않습니다): ${sanitizeError(r.stderr)}`);
  return r.stdout;
}
