import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeContext } from '../context.js';
import { GitEngine, GitRemoteError, type GitAuth } from '../git/git-engine.js';
import { TempWorkspace } from '../git/temp-workspace.js';
import { buildSnapshot, checkForChanges, type PreviousSnapshot } from '../git/snapshot-engine.js';
import { uploadStagedJob } from './snapshot-uploader.js';
import { AgentLock, AlreadyRunningError } from './lock.js';
import { discoverTargets } from '../discovery.js';
import { downloadVerified } from '../cloud/download-manager.js';
import { ReauthRequiredError } from '../cloud/oauth.js';
import { Logger } from '../utils/logger.js';
import { newId, stableStringify } from '../utils/misc.js';
import { sanitizeError } from '../utils/sanitize.js';
import type { BackupJobSummary, RefsDocument, RepoBackupResult, RepositoryTarget, SnapshotManifest } from '../types.js';

const MIN_FREE_BYTES = Number(process.env.REPOVAULT_MIN_FREE_BYTES ?? 512 * 1024 * 1024);

/** 가장 최근 "복원 가능" 스냅샷과 그 refs.json (Drive가 원본, 로컬은 캐시) */
export async function getPreviousSnapshot(ctx: RuntimeContext, repoId: string): Promise<{ prev: PreviousSnapshot | null; manifest: SnapshotManifest | null }> {
  const idx = await ctx.index.readRepositoryIndex(repoId);
  const latest = idx?.data.snapshots.filter((s) => s.restorable && s.manifest_file_id).sort((a, b) => b.created_at_utc.localeCompare(a.created_at_utc))[0];
  if (!latest) return { prev: null, manifest: null };
  const manifest = JSON.parse((await ctx.drive.downloadBuffer(latest.manifest_file_id!)).toString('utf8')) as SnapshotManifest;
  const cacheKey = `refs:${latest.snapshot_id}`;
  let refsDoc: RefsDocument | null = null;
  const cached = ctx.cache.getKv(cacheKey);
  if (cached) refsDoc = JSON.parse(cached) as RefsDocument;
  if (!refsDoc && manifest.refs_file_id) {
    refsDoc = JSON.parse((await ctx.drive.downloadBuffer(manifest.refs_file_id)).toString('utf8')) as RefsDocument;
    ctx.cache.setKv(cacheKey, JSON.stringify(refsDoc));
  }
  if (!refsDoc) return { prev: null, manifest };
  return { prev: { snapshot_id: latest.snapshot_id, refs: refsDoc }, manifest };
}

export interface BackupOptions {
  force?: boolean;
}

export async function backupRepository(ctx: RuntimeContext, git: GitEngine, target: RepositoryTarget, knownUrls: string[], opts: BackupOptions = {}): Promise<RepoBackupResult> {
  const log = ctx.log;
  const checkedAt = new Date().toISOString();
  let prevInfo: Awaited<ReturnType<typeof getPreviousSnapshot>>;
  try {
    prevInfo = await getPreviousSnapshot(ctx, target.id);
  } catch (e) {
    return { repository_id: target.id, outcome: 'failed', message: `Drive 인덱스 조회 실패: ${sanitizeError(e)}` };
  }

  // 1) 변경 감지 (ls-remote)
  let check;
  try {
    check = await checkForChanges(git, target, prevInfo.prev);
  } catch (e) {
    const kind = e instanceof GitRemoteError ? e.kind : 'remote_unavailable';
    const status = kind === 'network_error' ? 'network_error' : kind === 'auth_error' ? 'auth_error' : 'remote_unavailable';
    const msg = `원격 접근 실패(${status}) — 기존 Drive 백업은 그대로 유지됩니다. ${sanitizeError(e).split('\n').slice(-1)[0]}`;
    log.warn(msg, { repo: target.id });
    await ctx.index.updateRepositoryIndex(target, { checkedAt, remoteStatus: status, remoteMessage: msg }).catch(() => undefined);
    return { repository_id: target.id, outcome: 'remote_unavailable', message: msg };
  }

  if (!check.changed && !opts.force) {
    log.info('변경 없음 — 새 스냅샷 생략', { repo: target.id });
    await ctx.index.updateRepositoryIndex(target, { checkedAt, remoteStatus: 'unchanged', remoteMessage: null });
    return { repository_id: target.id, outcome: 'unchanged', snapshot_id: prevInfo.prev?.snapshot_id };
  }

  // 2) 디스크 여유 공간
  const free = TempWorkspace.freeBytes(ctx.workDir);
  if (free !== null && free < MIN_FREE_BYTES) {
    return { repository_id: target.id, outcome: 'failed', message: `로컬 임시 디스크 공간 부족 (${free} bytes). 클라우드 백업 미완료.` };
  }

  // 3) 스냅샷 빌드
  const ws = new TempWorkspace(ctx.workDir, newId());
  let job;
  try {
    log.info(prevInfo.prev ? '변경 감지 — 스냅샷 생성' : '최초 백업 — 전체 스냅샷 생성', { repo: target.id });
    const built = await buildSnapshot(git, target, prevInfo.prev, check, ws, {
      deviceId: ctx.cfg.device_id,
      knownRemoteUrls: knownUrls,
      log: (m) => log.info(m, { repo: target.id }),
      downloadPreviousBundle: async () => {
        const m = prevInfo.manifest;
        if (!m?.git_bundle_file_id) return null;
        const dest = join(ws.root, 'previous.bundle');
        const entry = m.files.find((f) => f.name === 'repository.bundle');
        await downloadVerified(ctx.drive, m.git_bundle_file_id, dest, { size: entry?.size, sha256: m.archive_sha256, name: 'previous repository.bundle' });
        return dest;
      },
    });
    job = built.job;
    const c = built.refsDoc.changes;
    log.info(`ref 변경: 추가 ${c.added.length}, 갱신 ${c.updated.length}, 삭제 ${c.deleted.length}, 강제변경 ${c.forced.length}, 보호 ref ${Object.keys(built.refsDoc.preserved_refs).length}`, {
      repo: target.id,
    });
  } catch (e) {
    const warn = ws.cleanup();
    if (warn) log.warn(warn, { repo: target.id });
    const msg = `스냅샷 생성 실패: ${sanitizeError(e)}`;
    log.error(msg, { repo: target.id });
    if (e instanceof GitRemoteError) {
      await ctx.index.updateRepositoryIndex(target, { checkedAt, remoteStatus: e.kind === 'network_error' ? 'network_error' : 'remote_unavailable', remoteMessage: msg }).catch(() => undefined);
      return { repository_id: target.id, outcome: 'remote_unavailable', message: msg };
    }
    return { repository_id: target.id, outcome: 'failed', message: msg };
  }

  // 4) 업로드 + 검증 + 인덱스 게시
  try {
    const final = await uploadStagedJob(ctx, ws, job);
    const warn = ws.cleanup();
    if (warn) log.warn(`${warn} (클라우드 백업은 정상 완료)`, { repo: target.id });
    log.info(`Drive 백업 완료: ${final.snapshot_folder}`, { repo: target.id });
    return { repository_id: target.id, outcome: 'created', snapshot_id: final.snapshot_id, bytes_uploaded: final.archive_size };
  } catch (e) {
    const msg = `업로드 미완료 — 다음 실행에서 재시도합니다: ${sanitizeError(e)}`;
    log.warn(msg, { repo: target.id });
    if (e instanceof ReauthRequiredError) throw e;
    return { repository_id: target.id, outcome: 'pending_upload', snapshot_id: job.snapshot_id, message: msg };
  }
}

/** 고아 임시 작업 처리: 완료 검증된 작업은 정리, 미완료 업로드는 재시도 */
export async function processPendingJobs(ctx: RuntimeContext, opts: { ignoreBackoff?: boolean } = {}): Promise<RepoBackupResult[]> {
  const results: RepoBackupResult[] = [];
  for (const { ws, job } of TempWorkspace.scan(ctx.workDir)) {
    if (!job || job.state === 'building') {
      // 빌드 중 중단된 작업: 원격에서 다시 수집 가능하므로 정리
      const w = ws.cleanup();
      if (w) ctx.log.warn(w);
      continue;
    }
    if (job.state === 'completed') {
      const w = ws.cleanup();
      if (w) ctx.log.warn(w);
      ctx.cache.deletePendingForJob(job.job_id);
      continue;
    }
    if (!opts.ignoreBackoff && job.next_retry_at && Date.parse(job.next_retry_at) > Date.now()) {
      results.push({ repository_id: job.repository_id, outcome: 'pending_upload', snapshot_id: job.snapshot_id, message: `재시도 예정: ${job.next_retry_at}` });
      continue;
    }
    if (job.retry_count >= ctx.cfg.retry.max_attempts * 4) {
      results.push({ repository_id: job.repository_id, outcome: 'pending_upload', snapshot_id: job.snapshot_id, message: '재시도 한도 초과 — 사용자 확인 필요' });
      continue;
    }
    ctx.log.info(`미전송 스냅샷 업로드 재시도 (${job.retry_count + 1}회차)`, { repo: job.repository_id });
    try {
      const final = await uploadStagedJob(ctx, ws, job);
      const w = ws.cleanup();
      if (w) ctx.log.warn(w);
      results.push({ repository_id: job.repository_id, outcome: 'created', snapshot_id: final.snapshot_id, bytes_uploaded: final.archive_size });
    } catch (e) {
      if (e instanceof ReauthRequiredError) throw e;
      results.push({ repository_id: job.repository_id, outcome: 'pending_upload', snapshot_id: job.snapshot_id, message: sanitizeError(e) });
    }
  }
  return results;
}

/** 가장 최근 예정 시각 이후 성공 실행이 없으면 due */
export function isRunDue(lastRunIso: string | null, hour: number, minute: number, now = new Date()): boolean {
  const scheduled = new Date(now);
  scheduled.setHours(hour, minute, 0, 0);
  if (scheduled > now) scheduled.setDate(scheduled.getDate() - 1);
  if (!lastRunIso) return true;
  return Date.parse(lastRunIso) < scheduled.getTime();
}

export function nextRunTime(hour: number, minute: number, now = new Date()): Date {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

export interface AgentRunOptions {
  trigger: 'schedule' | 'login' | 'catch-up' | 'manual' | 'cli';
  repoIds?: string[];
  force?: boolean;
  gitAuthOverride?: GitAuth[];
}

function writeStatus(ctx: RuntimeContext, status: Record<string, unknown>) {
  try {
    mkdirSync(ctx.paths.dataDir, { recursive: true });
    writeFileSync(ctx.paths.statusFile, JSON.stringify({ ...status, updated_at: new Date().toISOString(), pid: process.pid }, null, 2));
  } catch {
    /* ignore */
  }
}

/**
 * 독립 백그라운드 에이전트 진입점 (GUI 없이 동작).
 * 락 → Drive 인증/구조 → 인덱스 동기화 → 미전송 재시도 → 목록 갱신 → 저장소별 백업 → 로그 업로드
 */
export async function runBackupAgent(ctx: RuntimeContext, opts: AgentRunOptions): Promise<BackupJobSummary> {
  const jobId = newId();
  const started = new Date().toISOString();
  const summary: BackupJobSummary = {
    job_id: jobId,
    trigger: opts.trigger,
    started_at: started,
    completed_at: null,
    status: 'running',
    repository_count: 0,
    success_count: 0,
    unchanged_count: 0,
    failed_count: 0,
    pending_count: 0,
    results: [],
  };
  const logFile = join(ctx.paths.logsDir, 'jobs', `${started.slice(0, 10)}_${jobId}.jsonl`);
  ctx.log = new Logger(logFile, !process.env.REPOVAULT_QUIET);

  // 예약/로그인 트리거: 이미 오늘 예정 시각 이후 성공했다면 건너뜀 (미전송 재시도는 수행)
  if ((opts.trigger === 'login' || opts.trigger === 'catch-up') && !isRunDue(ctx.cache.lastSuccessfulScheduledRun(), ctx.cfg.schedule.hour, ctx.cfg.schedule.minute)) {
    summary.status = 'skipped';
    summary.message = '오늘 예정된 백업이 이미 완료되었습니다.';
  }

  const lock = new AgentLock(ctx.paths.lockFile);
  try {
    lock.acquire();
  } catch (e) {
    if (e instanceof AlreadyRunningError) {
      summary.status = 'skipped';
      summary.message = e.message;
      summary.completed_at = new Date().toISOString();
      return summary;
    }
    throw e;
  }

  writeStatus(ctx, { state: 'running', job_id: jobId, trigger: opts.trigger, started_at: started, current: null });
  try {
    const git = new GitEngine({ auth: opts.gitAuthOverride });
    try {
      await git.version();
    } catch {
      throw new Error('Git이 설치되어 있지 않거나 PATH에서 찾을 수 없습니다.');
    }

    // Drive 연결/구조 확인
    await ctx.folders.ensureStructure();
    if (!ctx.cache.listRepositories().length) {
      const n = await ctx.index.syncToCache();
      if (n) ctx.log.info(`Drive 인덱스에서 저장소 ${n}개 정보를 복구했습니다.`);
    }

    // 미전송 데이터 우선 재시도
    const pendingResults = await processPendingJobs(ctx, { ignoreBackoff: opts.trigger === 'manual' || opts.trigger === 'cli' });
    summary.results.push(...pendingResults);

    if (summary.status !== 'skipped') {
      const disc = await discoverTargets(ctx);
      for (const err of disc.errors) ctx.log.warn(err);
      const gitWithAuth = new GitEngine({ auth: opts.gitAuthOverride ?? disc.auth });
      for (const m of disc.missing) {
        ctx.log.warn('원격 목록에서 저장소가 사라졌습니다 — Drive 백업은 그대로 유지합니다.', { repo: m.id });
        await ctx.index
          .updateRepositoryIndex(m, { checkedAt: new Date().toISOString(), remoteStatus: 'remote_missing', remoteMessage: '원격 목록에서 사라짐 (Drive 백업 유지)' })
          .catch(() => undefined);
        summary.results.push({ repository_id: m.id, outcome: 'remote_unavailable', message: '원격 목록에서 사라짐 — Drive 백업 유지' });
      }
      let targets = disc.targets.filter((t) => t.enabled);
      if (opts.repoIds?.length) targets = disc.targets.filter((t) => opts.repoIds!.includes(t.id));
      const knownUrls = disc.targets.map((t) => t.remoteUrl);
      summary.repository_count = targets.length;
      let i = 0;
      for (const t of targets) {
        i++;
        writeStatus(ctx, { state: 'running', job_id: jobId, trigger: opts.trigger, started_at: started, current: t.id, progress: { done: i - 1, total: targets.length } });
        if (summary.results.some((r) => r.repository_id === t.id && r.outcome === 'pending_upload')) {
          // 같은 저장소의 미전송 스냅샷이 남아 있으면 새 스냅샷보다 업로드 완료를 우선한다
          continue;
        }
        try {
          summary.results.push(await backupRepository(ctx, gitWithAuth, t, knownUrls, { force: opts.force }));
        } catch (e) {
          if (e instanceof ReauthRequiredError) throw e;
          summary.results.push({ repository_id: t.id, outcome: 'failed', message: sanitizeError(e) });
        }
      }
    }

    for (const r of summary.results) {
      if (r.outcome === 'created') summary.success_count++;
      else if (r.outcome === 'unchanged') summary.unchanged_count++;
      else if (r.outcome === 'pending_upload') summary.pending_count++;
      else if (r.outcome === 'failed' || r.outcome === 'remote_unavailable') summary.failed_count++;
    }
    if (summary.status !== 'skipped') summary.status = summary.failed_count || summary.pending_count ? 'completed_with_errors' : 'completed';
  } catch (e) {
    summary.status = 'failed';
    summary.message = sanitizeError(e);
    ctx.log.error(summary.message);
  } finally {
    summary.completed_at = new Date().toISOString();
    ctx.cache.saveJob(summary);
    // 로그와 작업 요약을 Drive에 보관 (실패해도 백업 결과에 영향 없음)
    if (summary.status !== 'failed' || !/재인증|연결되어 있지|Client ID/.test(summary.message ?? '')) {
      try {
        const month = started.slice(0, 7);
        const folder = await ctx.folders.ensureFolder(['logs', 'cloud-backup', month]);
        await ctx.drive.createSmallFile(
          `${started.replace(/[:.]/g, '-')}_${jobId}.json`,
          folder,
          stableStringify({ summary, log: ctx.log.entries }),
          'application/json',
          { repovault_role: 'backup-log', job_id: jobId },
        );
        if (summary.status === 'completed' || summary.status === 'completed_with_errors') {
          await ctx.index.touchDevice(ctx.cfg.device_id, { last_backup_job_id: jobId, last_backup_completed_at: summary.completed_at });
        }
      } catch (e) {
        ctx.log.warn(`작업 로그 Drive 업로드 실패: ${sanitizeError(e)}`);
      }
    }
    writeStatus(ctx, { state: 'idle', last_job: summary });
    lock.release();
  }
  return summary;
}

export function hasPendingStaging(ctx: RuntimeContext): number {
  if (!existsSync(ctx.workDir)) return 0;
  return TempWorkspace.scan(ctx.workDir).filter((x) => x.job && (x.job.state === 'pending_upload' || x.job.state === 'uploading')).length;
}
