import { existsSync, readFileSync } from 'node:fs';
import type { RuntimeContext } from './context.js';
import { hasPendingStaging, nextRunTime } from './agent/backup-runner.js';
import { getQuota, type QuotaInfo } from './cloud/quota.js';
import { CredentialKeys } from './security/credential-store.js';
import { scheduleStatus } from './scheduler/index.js';
import { TempWorkspace } from './git/temp-workspace.js';
import { sanitizeError } from './utils/sanitize.js';
import type { BackupJobSummary } from './types.js';

export interface AppStatus {
  google: { clientConfigured: boolean; connected: boolean; email: string | null; rootFolderName: string; rootFolderId: string | null; rootFolderLink: string | null };
  schedule: { enabled: boolean; time: string; nextRun: string | null; installed: boolean; detail: string };
  lastJob: BackupJobSummary | null;
  agent: { state: string; current?: string | null; progress?: { done: number; total: number } } | null;
  repositories: number;
  pendingUploads: number;
  tempUsageBytes: number;
  credentialBackend: string;
}

export async function getStatus(ctx: RuntimeContext, opts: { checkSchedule?: boolean } = {}): Promise<AppStatus> {
  const connected = !!(await ctx.creds.get(CredentialKeys.googleRefreshToken).catch(() => null));
  const jobs = ctx.cache.listJobs(1);
  const lastJob = jobs[0]
    ? ({
        job_id: jobs[0].id,
        trigger: jobs[0].job_type,
        status: jobs[0].status,
        started_at: jobs[0].started_at,
        completed_at: jobs[0].completed_at,
        repository_count: jobs[0].repository_count,
        success_count: jobs[0].success_count,
        failed_count: jobs[0].failed_count,
        unchanged_count: jobs[0].unchanged_count,
        pending_count: jobs[0].pending_count,
        message: jobs[0].error_message_sanitized ?? undefined,
        results: JSON.parse(String(jobs[0].results_json ?? '[]')),
      } as BackupJobSummary)
    : null;
  let agent: AppStatus['agent'] = null;
  if (existsSync(ctx.paths.statusFile)) {
    try {
      agent = JSON.parse(readFileSync(ctx.paths.statusFile, 'utf8'));
    } catch {
      agent = null;
    }
  }
  const sched = opts.checkSchedule ? await scheduleStatus().catch((e) => ({ installed: false, detail: sanitizeError(e) })) : { installed: false, detail: '' };
  const rootId = ctx.cache.getKv('drive_root_id');
  const tempUsage = TempWorkspace.scan(ctx.workDir).reduce((n, x) => n + (x.job?.files.reduce((m, f) => m + f.size, 0) ?? 0), 0);
  return {
    google: {
      clientConfigured: !!ctx.cfg.google.client_id,
      connected,
      email: ctx.cfg.google.account_email,
      rootFolderName: ctx.cfg.google.root_folder_name,
      rootFolderId: rootId,
      rootFolderLink: rootId ? `https://drive.google.com/drive/folders/${rootId}` : null,
    },
    schedule: {
      enabled: ctx.cfg.schedule.enabled,
      time: `${String(ctx.cfg.schedule.hour).padStart(2, '0')}:${String(ctx.cfg.schedule.minute).padStart(2, '0')}`,
      nextRun: ctx.cfg.schedule.enabled ? nextRunTime(ctx.cfg.schedule.hour, ctx.cfg.schedule.minute).toISOString() : null,
      installed: sched.installed,
      detail: sched.detail,
    },
    lastJob,
    agent,
    repositories: ctx.cache.listRepositories().length,
    pendingUploads: hasPendingStaging(ctx),
    tempUsageBytes: tempUsage,
    credentialBackend: ctx.creds.kind,
  };
}

export async function getDriveInfo(ctx: RuntimeContext): Promise<{ quota: QuotaInfo | null; repoVaultBytes: number; error?: string }> {
  const repoVaultBytes = ctx.cache.listRepositories().reduce((n, r) => n + Number(r.total_size ?? 0), 0);
  try {
    return { quota: await getQuota(ctx.drive), repoVaultBytes };
  } catch (e) {
    return { quota: null, repoVaultBytes, error: sanitizeError(e) };
  }
}

/** Google 연결 직후: 계정 이메일 확인 + 루트 폴더 구조 생성/탐색 + 클라우드 인덱스 → 로컬 캐시 */
export async function initializeDrive(ctx: RuntimeContext): Promise<{ email: string | null; rootId: string; repositories: number }> {
  const about = await ctx.drive.about('user(emailAddress,displayName)');
  const email = about.user?.emailAddress ?? null;
  const prevEmail = ctx.cfg.google.account_email;
  if (prevEmail && email && prevEmail !== email) {
    // 계정이 바뀌면 이전 계정 캐시를 새 계정에 섞지 않는다
    ctx.cache.clearRepositoryCache();
    ctx.cache.clearFolderCache();
    ctx.cache.setKv('drive_root_id', null);
  }
  ctx.configStore.update((c) => {
    c.google.account_email = email;
  });
  ctx.reloadConfig();
  const rootId = await ctx.folders.ensureStructure();
  ctx.cache.setCloudAccount(email, 'connected');
  const repositories = await ctx.index.syncToCache();
  return { email, rootId, repositories };
}
