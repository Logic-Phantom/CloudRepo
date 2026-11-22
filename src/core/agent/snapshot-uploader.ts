import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeContext } from '../context.js';
import { TempWorkspace, type JobManifest, type StagedFile } from '../git/temp-workspace.js';
import { assertQuota } from '../cloud/quota.js';
import { snapshotEntryFromManifest } from '../cloud/manifest.js';
import { sha256File, stableStringify } from '../utils/misc.js';
import { safeSegment, sanitizeError } from '../utils/sanitize.js';
import type { RepositoryTarget, SnapshotManifest } from '../types.js';

export function repositoryFolderSegments(t: Pick<RepositoryTarget, 'provider' | 'owner' | 'name'>): string[] {
  const provider = t.provider === 'github' || t.provider === 'gitlab' ? t.provider : 'custom';
  return ['repositories', provider, safeSegment(t.owner), safeSegment(t.name)];
}

/** 스냅샷 업로드 순서 (manifest.json은 모든 필수 파일 검증 후 마지막) */
const UPLOAD_ORDER = ['repository.bundle', 'lfs-objects.tar.zst', 'refs.json', 'submodules.json', 'checksums.sha256'];

function targetFromJob(job: JobManifest): RepositoryTarget {
  if (job.target) return job.target;
  const m = job.manifest_draft!;
  return {
    id: m.repository_id,
    provider: m.provider,
    owner: m.owner,
    name: m.repository_name,
    remoteUrl: m.remote_url,
    cloneUrl: m.remote_url,
    private: m.private,
    archived: false,
    enabled: true,
    source: 'discovered',
  };
}

/**
 * 스테이징된 스냅샷을 Drive에 업로드하고 검증한 뒤 Manifest/Index를 게시한다.
 * 실패 시 job.json 상태가 pending_upload로 남아 다음 실행에서 이어서 재시도된다.
 */
export async function uploadStagedJob(ctx: RuntimeContext, ws: TempWorkspace, job: JobManifest): Promise<SnapshotManifest> {
  if (!job.manifest_draft) throw new Error('스테이징 정보가 손상되었습니다(manifest 없음).');
  const target = targetFromJob(job);
  const draft = job.manifest_draft;
  job.state = 'uploading';
  ws.saveJob(job);

  try {
    // 1) 용량 사전 검사
    const remaining = job.files.filter((f) => !f.verified).reduce((n, f) => n + f.size, 0);
    if (remaining > 0) await assertQuota(ctx.drive, remaining);

    // 2) 폴더 확보 (ID 기반)
    const repoSegs = repositoryFolderSegments(target);
    const repoFolderId = await ctx.folders.ensureFolder(repoSegs, { repovault_role: 'repository', repo_id: target.id });
    const snapFolderId = await ctx.folders.ensureFolder([...repoSegs, 'snapshots', job.snapshot_folder], {
      repovault_role: 'snapshot',
      repo_id: target.id,
      snapshot_id: job.snapshot_id,
    });

    // 3) 파일 업로드 + 검증 (이미 검증된 파일은 건너뜀)
    const ordered = [...job.files].sort((a, b) => UPLOAD_ORDER.indexOf(a.name) - UPLOAD_ORDER.indexOf(b.name));
    for (const f of ordered) {
      if (f.verified && f.file_id) continue;
      await uploadOne(ctx, job, f, snapFolderId, target.id);
      ws.saveJob(job);
    }

    // 4) 최종 Manifest (completed) 게시
    const fid = (name: string) => job.files.find((f) => f.name === name)?.file_id ?? null;
    const final: SnapshotManifest = {
      ...draft,
      git_bundle_file_id: fid('repository.bundle'),
      lfs_archive_file_id: fid('lfs-objects.tar.zst'),
      refs_file_id: fid('refs.json'),
      submodules_file_id: fid('submodules.json'),
      checksums_file_id: fid('checksums.sha256'),
      files: job.files.map((f) => ({ name: f.name, file_id: f.file_id, size: f.size, sha256: f.sha256, verified_by: f.verified_by })),
      upload_status: 'completed',
      verification_status: 'verified',
    };
    const requiredOk = job.files.every((f) => f.verified && f.file_id) && (draft.is_empty_repository || !!final.git_bundle_file_id);
    if (!requiredOk) throw new Error('필수 파일 검증이 끝나지 않아 Manifest를 게시하지 않습니다.');

    const manifestPath = join(ws.stagingDir, 'manifest.json');
    writeFileSync(manifestPath, stableStringify(final));
    const mf: StagedFile = job.manifest_file ?? {
      name: 'manifest.json',
      path: manifestPath,
      size: statSync(manifestPath).size,
      sha256: await sha256File(manifestPath),
      mimeType: 'application/json',
      role: 'snapshot-manifest',
      file_id: null,
      verified: false,
    };
    if (!mf.verified) {
      mf.size = statSync(manifestPath).size;
      mf.sha256 = await sha256File(manifestPath);
      job.manifest_file = mf;
      await uploadOne(ctx, job, mf, snapFolderId, target.id);
      ws.saveJob(job);
    }

    // 5) 저장소 인덱스 + 백업 인덱스 갱신 (충돌 시 재조회·병합·재시도)
    await ctx.index.updateRepositoryIndex(target, {
      snapshot: snapshotEntryFromManifest(final, mf.file_id, snapFolderId),
      checkedAt: new Date().toISOString(),
      remoteStatus: 'ok',
      remoteMessage: null,
      folderId: repoFolderId,
    });
    ctx.cache.setKv(`refs:${final.snapshot_id}`, null);

    job.state = 'completed';
    job.last_error = null;
    ws.saveJob(job);
    ctx.cache.deletePendingForJob(job.job_id);
    return final;
  } catch (e) {
    job.state = 'pending_upload';
    job.retry_count += 1;
    job.last_error = sanitizeError(e);
    const delayMin = Math.min(24 * 60, 5 * 2 ** Math.min(job.retry_count, 8));
    job.next_retry_at = new Date(Date.now() + delayMin * 60_000).toISOString();
    ws.saveJob(job);
    for (const f of job.files) {
      ctx.cache.upsertPending({
        id: `${job.job_id}:${f.name}`,
        job_id: job.job_id,
        snapshot_id: job.snapshot_id,
        repository_id: job.repository_id,
        file_name: f.name,
        local_staging_path: f.path,
        source_sha256: f.sha256,
        file_size: f.size,
        drive_file_id: f.file_id,
        resumable_session_reference: `os-credential-store:upload-session:${job.job_id}:${f.name}`,
        status: f.verified ? 'verified' : 'pending',
        last_error: job.last_error,
        retry_count: job.retry_count,
        next_retry_at: job.next_retry_at,
      });
    }
    throw e;
  }
}

async function uploadOne(ctx: RuntimeContext, job: JobManifest, f: StagedFile, folderId: string, repoId: string) {
  ctx.cache.upsertPending({
    id: `${job.job_id}:${f.name}`,
    job_id: job.job_id,
    snapshot_id: job.snapshot_id,
    repository_id: job.repository_id,
    file_name: f.name,
    local_staging_path: f.path,
    source_sha256: f.sha256,
    file_size: f.size,
    drive_folder_id: folderId,
    status: 'uploading',
    retry_count: job.retry_count,
  });
  const r = await ctx.uploader.upload(
    {
      localPath: f.path,
      name: f.name,
      parentId: folderId,
      mimeType: f.mimeType,
      sha256: f.sha256,
      sessionKey: `${job.job_id}:${f.name}`,
      appProperties: { repovault_role: f.role, repo_id: repoId, snapshot_id: job.snapshot_id },
    },
    { chunkSize: ctx.cfg.upload.chunk_size_mb * 1024 * 1024, retryBaseMs: ctx.retryBaseMs },
  );
  f.file_id = r.fileId;
  f.verified = true;
  f.verified_by = r.verifiedBy;
  ctx.cache.upsertPending({
    id: `${job.job_id}:${f.name}`,
    job_id: job.job_id,
    snapshot_id: job.snapshot_id,
    repository_id: job.repository_id,
    file_name: f.name,
    local_staging_path: f.path,
    source_sha256: f.sha256,
    file_size: f.size,
    drive_folder_id: folderId,
    drive_file_id: r.fileId,
    status: 'verified',
    retry_count: job.retry_count,
  });
  ctx.log.info(`업로드·검증 완료: ${f.name} (${r.verifiedBy}${r.reused ? ', 기존 파일 재사용' : ''})`, { repo: repoId });
}
