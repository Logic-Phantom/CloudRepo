import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitEngine } from './git-engine.js';
import { diffRefs, emptyChanges, refsEqual } from './change-detector.js';
import { backupLfs } from './lfs-engine.js';
import { analyzeSubmodules } from './submodules.js';
import { TempWorkspace, type JobManifest, type StagedFile } from './temp-workspace.js';
import { sha256File, stableStringify, utcStamp } from '../utils/misc.js';
import {
  APP_VERSION,
  SCHEMA_VERSION,
  type LfsInfo,
  type RefChanges,
  type RefMap,
  type RefsDocument,
  type RepositoryTarget,
  type SnapshotManifest,
  type SubmoduleInfo,
} from '../types.js';

export const PRESERVED_PREFIX = 'refs/repovault/preserved/';
const IMPORT_PREFIX = 'refs/rv-import/';

export interface PreviousSnapshot {
  snapshot_id: string;
  refs: RefsDocument;
}

export interface ChangeCheck {
  changed: boolean;
  remoteRefs: RefMap;
  headSymref: string | null;
}

/** fetch 없이 ls-remote 결과와 이전 스냅샷의 remote_refs를 비교한다 */
export async function checkForChanges(git: GitEngine, target: RepositoryTarget, prev: PreviousSnapshot | null): Promise<ChangeCheck> {
  const { refs, headSymref } = await git.lsRemote(target.cloneUrl);
  const changed = !prev || !refsEqual(refs, prev.refs.remote_refs) || (prev.refs.head_symref ?? null) !== (headSymref ?? null);
  return { changed, remoteRefs: refs, headSymref };
}

export interface BuildDeps {
  /** 이전 스냅샷 Bundle을 Drive에서 내려받아 검증 후 로컬 경로 반환 */
  downloadPreviousBundle: (prev: PreviousSnapshot) => Promise<string | null>;
  deviceId: string;
  knownRemoteUrls: string[];
  log: (msg: string) => void;
}

export interface BuildResult {
  job: JobManifest;
  refsDoc: RefsDocument;
  lfs: LfsInfo;
  submodules: SubmoduleInfo[];
}

export class SnapshotBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotBuildError';
  }
}

async function stage(path: string, name: string, role: string, mimeType: string): Promise<StagedFile> {
  return {
    name,
    path,
    size: statSync(path).size,
    sha256: await sha256File(path),
    mimeType,
    role,
    file_id: null,
    verified: false,
  };
}

/**
 * Full Snapshot 생성:
 * 1) 임시 Bare 저장소 생성 → 2) fetch → 3) 이전 Ref와 비교해 삭제/강제 변경 Ref 보호
 * 4) Bundle 생성/검증 + fsck → 5) 로컬 복원 테스트 → 6) LFS/Submodule/refs/checksums 스테이징
 */
export async function buildSnapshot(
  git: GitEngine,
  target: RepositoryTarget,
  prev: PreviousSnapshot | null,
  check: ChangeCheck,
  ws: TempWorkspace,
  deps: BuildDeps,
): Promise<BuildResult> {
  const now = new Date();
  const createdAt = now.toISOString();
  const snapshotId = ws.jobId;
  const stamp = utcStamp(now);
  const folderName = `${stamp}_${snapshotId}`;
  const preserveTag = `${stamp}-${snapshotId.slice(0, 8)}`;
  ws.create();

  const job: JobManifest = {
    job_id: ws.jobId,
    repository_id: target.id,
    target,
    snapshot_id: snapshotId,
    snapshot_folder: folderName,
    state: 'building',
    files: [],
    manifest_draft: null,
    manifest_file: null,
    retry_count: 0,
    next_retry_at: null,
    last_error: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
  ws.saveJob(job);

  const repo = ws.gitDir;
  await git.initBare(repo);
  await git.fetchAll(repo, target.cloneUrl);
  const fetched = await git.forEachRef(repo);

  // --- 이전 Ref 보호 -----------------------------------------------------
  const changes: RefChanges = emptyChanges();
  const preserved: RefMap = {};
  const prevRemote = prev?.refs.remote_refs ?? {};
  const prevPreserved = prev?.refs.preserved_refs ?? {};
  const d = diffRefs(prevRemote, fetched);
  changes.added = d.added;
  changes.deleted = d.deleted;

  const toPreserve: Array<{ from: string; sha: string }> = [];
  for (const name of d.deleted) toPreserve.push({ from: name, sha: prevRemote[name]! });
  for (const name of d.updated) {
    const oldSha = prevRemote[name]!;
    const newSha = fetched[name]!;
    let forced = true;
    if (name.startsWith('refs/heads/') && (await git.objectExists(repo, oldSha))) {
      forced = !(await git.isAncestor(repo, oldSha, newSha));
    }
    if (forced) {
      changes.forced.push(name);
      toPreserve.push({ from: name, sha: oldSha });
    } else {
      changes.updated.push(name);
    }
  }

  // 필요한 과거 객체가 없으면 이전 스냅샷 Bundle을 Drive에서 가져와 객체를 복구한다
  const needed = [...toPreserve.map((p) => p.sha), ...Object.values(prevPreserved)];
  let missing = false;
  for (const sha of needed) {
    if (!(await git.objectExists(repo, sha))) {
      missing = true;
      break;
    }
  }
  if (missing && prev) {
    deps.log('삭제/강제 변경된 Ref의 과거 객체를 이전 Drive 스냅샷에서 가져옵니다.');
    const bundle = await deps.downloadPreviousBundle(prev);
    if (!bundle) throw new SnapshotBuildError('이전 스냅샷 Bundle을 가져오지 못해 과거 Ref를 보존할 수 없습니다. 백업을 중단합니다.');
    await git.fetchBundle(repo, bundle, [`+refs/*:${IMPORT_PREFIX}*`]);
  }

  const ops: Array<{ op: 'update' | 'delete'; ref: string; sha?: string }> = [];
  for (const [ref, sha] of Object.entries(prevPreserved)) {
    if (await git.objectExists(repo, sha)) {
      preserved[ref] = sha;
      ops.push({ op: 'update', ref, sha });
    } else {
      throw new SnapshotBuildError(`보호된 과거 Ref 객체를 찾을 수 없습니다: ${ref}`);
    }
  }
  for (const p of toPreserve) {
    const ref = `${PRESERVED_PREFIX}${preserveTag}/${p.from.replace(/^refs\//, '')}`;
    if (!(await git.checkRefFormat(ref))) throw new SnapshotBuildError(`잘못된 보호 Ref 이름: ${ref}`);
    if (!(await git.objectExists(repo, p.sha))) {
      throw new SnapshotBuildError(`보존해야 할 과거 커밋 객체가 없습니다: ${p.from} ${p.sha}`);
    }
    preserved[ref] = p.sha;
    ops.push({ op: 'update', ref, sha: p.sha });
  }
  await git.updateRefs(repo, ops);
  // 임시 import ref 정리 (객체는 보호 ref로 계속 도달 가능)
  const imported = await git.forEachRef(repo, IMPORT_PREFIX);
  await git.updateRefs(repo, Object.keys(imported).map((ref) => ({ op: 'delete' as const, ref })));

  const headSymref = check.headSymref && fetched[check.headSymref] ? check.headSymref : (Object.keys(fetched).find((r) => r.startsWith('refs/heads/')) ?? null);
  if (headSymref) await git.setHeadSymref(repo, headSymref);

  const allRefs = await git.forEachRef(repo);
  const isEmpty = Object.keys(allRefs).length === 0;

  // --- 무결성 검사 + Bundle ------------------------------------------------
  const staged: StagedFile[] = [];
  if (!isEmpty) {
    const fsck = await git.fsck(repo);
    if (!fsck.ok) throw new SnapshotBuildError(`git fsck 실패: ${fsck.output.slice(0, 800)}`);
    const bundlePath = join(ws.stagingDir, 'repository.bundle');
    await git.bundleCreate(repo, bundlePath);
    if (!(await git.bundleVerify(repo, bundlePath))) throw new SnapshotBuildError('git bundle verify 실패');

    // 로컬 복원 테스트: 새 Bare 저장소로 import 후 ref 일치 확인
    await git.initBare(ws.verifyDir);
    await git.fetchBundle(ws.verifyDir, bundlePath, ['+refs/*:refs/*']);
    const restored = await git.forEachRef(ws.verifyDir);
    for (const [ref, sha] of Object.entries(allRefs)) {
      if (restored[ref] !== sha) throw new SnapshotBuildError(`복원 테스트 실패: ${ref} 불일치`);
    }
    const vfsck = await git.fsck(ws.verifyDir);
    if (!vfsck.ok) throw new SnapshotBuildError(`복원 테스트 fsck 실패: ${vfsck.output.slice(0, 500)}`);
    staged.push(await stage(bundlePath, 'repository.bundle', 'git-bundle', 'application/octet-stream'));
  }

  // --- LFS -----------------------------------------------------------------
  let lfs: LfsInfo = { status: 'not_used', object_count: 0, total_size: 0 };
  if (!isEmpty) {
    const lfsArchive = join(ws.stagingDir, 'lfs-objects.tar.zst');
    lfs = await backupLfs(git, repo, target.cloneUrl, fetched, lfsArchive);
    if (lfs.status === 'complete' && existsSync(lfsArchive)) {
      staged.push(await stage(lfsArchive, 'lfs-objects.tar.zst', 'lfs-archive', 'application/zstd'));
    }
    if (lfs.message) deps.log(lfs.message);
  }

  // --- Submodule ------------------------------------------------------------
  const submodules = isEmpty ? [] : await analyzeSubmodules(git, repo, headSymref, deps.knownRemoteUrls);
  const subPath = join(ws.stagingDir, 'submodules.json');
  writeFileSync(subPath, stableStringify({ schema_version: SCHEMA_VERSION, snapshot_id: snapshotId, submodules }));

  // --- refs.json -------------------------------------------------------------
  const newCommitCount = isEmpty
    ? 0
    : await git.revListCount(
        repo,
        Object.values(fetched),
        Object.values(prevRemote).length ? await filterExisting(git, repo, Object.values(prevRemote)) : [],
      );
  const refsDoc: RefsDocument = {
    schema_version: SCHEMA_VERSION,
    snapshot_id: snapshotId,
    created_at_utc: createdAt,
    head_symref: headSymref,
    remote_refs: fetched,
    preserved_refs: preserved,
    all_refs: allRefs,
    changes,
    new_commit_count: newCommitCount,
  };
  const refsPath = join(ws.stagingDir, 'refs.json');
  writeFileSync(refsPath, stableStringify(refsDoc));
  staged.push(await stage(refsPath, 'refs.json', 'refs', 'application/json'));
  staged.push(await stage(subPath, 'submodules.json', 'submodules', 'application/json'));

  // --- checksums.sha256 -------------------------------------------------------
  const sumPath = join(ws.stagingDir, 'checksums.sha256');
  writeFileSync(sumPath, staged.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n');
  staged.push(await stage(sumPath, 'checksums.sha256', 'checksums', 'text/plain'));

  const bundle = staged.find((f) => f.name === 'repository.bundle');
  const archiveSize = staged.reduce((n, f) => n + f.size, 0);
  const branchCount = Object.keys(fetched).filter((r) => r.startsWith('refs/heads/')).length;
  const tagCount = Object.keys(fetched).filter((r) => r.startsWith('refs/tags/')).length;

  const manifest: SnapshotManifest = {
    schema_version: SCHEMA_VERSION,
    snapshot_id: snapshotId,
    snapshot_folder: folderName,
    repository_id: target.id,
    provider: target.provider,
    owner: target.owner,
    repository_name: target.name,
    remote_url: target.remoteUrl,
    private: target.private,
    created_at_utc: createdAt,
    backup_mode: 'full',
    parent_snapshot_id: prev?.snapshot_id ?? null,
    is_empty_repository: isEmpty,
    git_bundle_file_id: null,
    lfs_archive_file_id: null,
    refs_file_id: null,
    submodules_file_id: null,
    checksums_file_id: null,
    archive_size: archiveSize,
    archive_sha256: bundle?.sha256 ?? null,
    files: [],
    git_version: await git.version(),
    branch_count: branchCount,
    tag_count: tagCount,
    ref_count: Object.keys(allRefs).length,
    preserved_ref_count: Object.keys(preserved).length,
    head_symref: headSymref,
    refs_summary: fetched,
    changes,
    lfs_status: lfs.status,
    submodule_status: submodules.length ? 'metadata_only' : 'none',
    upload_status: 'pending',
    verification_status: 'pending',
    restore_test_status: isEmpty ? 'skipped' : 'passed',
    device_id: deps.deviceId,
    app_version: APP_VERSION,
  };

  job.files = staged;
  job.manifest_draft = manifest;
  job.state = 'pending_upload';
  ws.saveJob(job);
  // 업로드에는 스테이징 파일만 필요하므로 Git 작업 디렉터리는 즉시 정리해 디스크를 아낀다
  ws.removeGitWorkDirs();
  return { job, refsDoc, lfs, submodules };
}

async function filterExisting(git: GitEngine, repo: string, shas: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of shas) if (await git.objectExists(repo, s)) out.push(s);
  return out;
}
