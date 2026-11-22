#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { RuntimeContext } from '../core/context.js';
import { runBackupAgent, type AgentRunOptions } from '../core/agent/backup-runner.js';
import { restoreSnapshot, pushRestoredRepository, loadSnapshotManifest } from '../core/git/restore-engine.js';
import { migrateLegacy, findLegacyRepositories } from '../core/agent/legacy-migration.js';
import { getDriveInfo, getStatus, initializeDrive } from '../core/service.js';
import { installSchedule, uninstallSchedule, scheduleStatus } from '../core/scheduler/index.js';
import { CredentialKeys } from '../core/security/credential-store.js';
import { discoverTargets } from '../core/discovery.js';
import { resolveGitHubToken, GitHubAdapter } from '../core/providers/github.js';
import { createManualRemote } from '../core/providers/generic-git.js';
import { MultipleRootFoldersError } from '../core/cloud/folder-manager.js';
import { TempWorkspace } from '../core/git/temp-workspace.js';
import { formatBytes } from '../core/utils/misc.js';
import { sanitizeError } from '../core/utils/sanitize.js';
import { APP_VERSION } from '../core/types.js';
import { loadHqSettings, sendHeartbeat } from '../core/agent/hq-reporter.js';

type Flags = Record<string, string | boolean | string[]>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
      const next = argv[i + 1];
      const val = inline ?? (next && !next.startsWith('--') ? (i++, next) : true);
      if (k === 'ref') flags.ref = [...((flags.ref as string[]) ?? []), String(val)];
      else flags[k] = val;
    } else positional.push(a);
  }
  return { positional, flags };
}

const str = (f: Flags, k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const HELP = `RepoVault ${APP_VERSION} — Git 저장소를 Google Drive에 백업/복원

설정
  setup google --client-json <다운로드한 client_secret_*.json>
  setup google --client-id <ID> [--client-secret-stdin]
  setup root-folder <이름>            Drive 루트 폴더 이름 (기본: Git)
  auth login | status | logout [--revoke]
  github status | set-token (stdin)

저장소
  repos list [--refresh]
  repos add <url> [--name n] [--owner o] [--provider custom|gitlab|...] [--public]
  repos exclude <id> | include <id>

백업
  backup [--repo <id>] [--force]       지금 백업
  --run-backup-agent [--trigger schedule|login]   백그라운드 에이전트 진입점
  pending list                          업로드 대기 목록
  history [--repo <id>]

복원
  restore <repoId> --dest <빈 폴더> [--snapshot <id>] [--ref refs/heads/main ...] [--set-remote <url>]
  push-restored <path> <remoteUrl> [--execute]   (--mirror/--force 미사용, 기본 dry-run)
  verify <repoId> [--snapshot <id>]     Drive에서 내려받아 실제 복원 테스트

Drive / 스케줄 / 기타
  drive status | resync | rebuild | select-root <folderId>
  schedule install [--time 03:00] | uninstall | status
  hq set --url <https://HQ 주소> [--project-key cloudrepo]   (Heartbeat 키는 stdin)
  hq status | test | clear             AutoMateHQ 백업 결과 보고
  migrate-legacy <path> [--dry-run]
  status [--json]
`;

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  if (flags['run-backup-agent']) {
    const ctx = new RuntimeContext();
    const trigger = (str(flags, 'trigger') ?? 'schedule') as AgentRunOptions['trigger'];
    const effective = trigger === 'schedule' ? 'catch-up' : trigger;
    // 예약 실행은 '오늘 이미 완료됐는지' 판정을 공유한다 (launchd RunAtLoad / 로그온 트리거 대응)
    const summary = await runBackupAgent(ctx, { trigger: effective === 'catch-up' && isNearScheduled(ctx) ? 'schedule' : effective });
    printSummary(summary);
    ctx.close();
    process.exitCode = summary.status === 'failed' ? 1 : 0;
    return;
  }
  const [cmd, sub, ...rest] = positional;
  if (!cmd || flags.help || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (flags.version || cmd === 'version') {
    console.log(APP_VERSION);
    return;
  }
  const ctx = new RuntimeContext();
  try {
    switch (cmd) {
      case 'setup':
        await cmdSetup(ctx, sub, rest, flags);
        break;
      case 'auth':
        await cmdAuth(ctx, sub, flags);
        break;
      case 'github':
        await cmdGithub(ctx, sub);
        break;
      case 'repos':
        await cmdRepos(ctx, sub, rest, flags);
        break;
      case 'backup': {
        const summary = await runBackupAgent(ctx, { trigger: 'cli', repoIds: str(flags, 'repo') ? [str(flags, 'repo')!] : undefined, force: !!flags.force });
        printSummary(summary);
        if (summary.status === 'failed') process.exitCode = 1;
        break;
      }
      case 'pending': {
        for (const { ws, job } of TempWorkspace.scan(ctx.workDir)) {
          console.log(`${job?.state ?? 'unknown'}\t${job?.repository_id ?? '-'}\t${job?.snapshot_id ?? ws.jobId}\t재시도 ${job?.retry_count ?? 0}\t${job?.last_error ?? ''}`);
        }
        break;
      }
      case 'history': {
        const rows = ctx.cache.listSnapshots(str(flags, 'repo'));
        for (const r of rows) {
          const d = JSON.parse(String(r.data_json));
          console.log(`${r.created_at_utc}\t${r.repository_id}\t${String(r.snapshot_id).slice(0, 8)}\t${d.restorable ? '복원가능' : '미완료'}\t${formatBytes(Number(r.archive_size))}\t브랜치 ${d.branch_count} 태그 ${d.tag_count} 보호 ${d.preserved_ref_count}`);
        }
        if (!rows.length) console.log('캐시된 백업 기록이 없습니다. `repovault drive resync`로 Drive에서 가져올 수 있습니다.');
        break;
      }
      case 'restore': {
        const repoId = sub;
        const dest = str(flags, 'dest');
        if (!repoId || !dest) throw new Error('사용법: restore <repoId> --dest <빈 폴더>');
        const r = await restoreSnapshot(ctx, {
          repositoryId: repoId,
          snapshotId: str(flags, 'snapshot'),
          destination: dest,
          refs: flags.ref as string[] | undefined,
          setRemoteUrl: str(flags, 'set-remote'),
          includePreserved: !flags['no-preserved'],
        });
        console.log(`✅ 복원 완료: ${r.destination}\n  스냅샷 ${r.snapshot_id}\n  ref ${Object.keys(r.restored_refs).length}개 검증됨, LFS: ${r.lfs}`);
        for (const w of r.warnings) console.log(`  ⚠ ${w}`);
        break;
      }
      case 'push-restored': {
        const [path, url] = [sub, rest[0]];
        if (!path || !url) throw new Error('사용법: push-restored <path> <remoteUrl> [--execute]');
        console.log(await pushRestoredRepository(path, url, { execute: !!flags.execute }));
        if (!flags.execute) console.log('↑ 미리보기(dry-run)입니다. 실제로 push 하려면 --execute 를 붙이세요.');
        break;
      }
      case 'verify': {
        if (!sub) throw new Error('사용법: verify <repoId> [--snapshot id]');
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const dir = mkdtempSync(join(tmpdir(), 'rv-verify-'));
        try {
          const r = await restoreSnapshot(ctx, { repositoryId: sub, snapshotId: str(flags, 'snapshot'), destination: join(dir, 'repo') });
          const { manifest } = await loadSnapshotManifest(ctx, sub, r.snapshot_id);
          const folder = await ctx.folders.ensureFolder(['system', 'integrity-reports']);
          await ctx.drive.createSmallFile(
            `${new Date().toISOString().replace(/[:.]/g, '-')}_${sub}.json`,
            folder,
            JSON.stringify({ repository_id: sub, snapshot_id: r.snapshot_id, verified: r.verified, refs: Object.keys(r.restored_refs).length, lfs: r.lfs, manifest_files: manifest.files.length, checked_at: new Date().toISOString() }, null, 2),
            'application/json',
            { repovault_role: 'integrity-report' },
          );
          console.log(`✅ 무결성/복원 검증 통과: ${sub} ${r.snapshot_id} (ref ${Object.keys(r.restored_refs).length}개)`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        break;
      }
      case 'drive':
        await cmdDrive(ctx, sub, rest);
        break;
      case 'schedule':
        await cmdSchedule(ctx, sub, flags);
        break;
      case 'hq':
        await cmdHq(ctx, sub, flags);
        break;
      case 'migrate-legacy': {
        if (!sub) throw new Error('사용법: migrate-legacy <path>');
        if (flags['dry-run']) {
          for (const p of findLegacyRepositories(sub)) console.log(p);
          break;
        }
        for (const r of await migrateLegacy(ctx, sub)) console.log(`${r.outcome}\t${r.path}\t${r.message ?? ''}`);
        console.log('기존 로컬 백업은 삭제하지 않았습니다. 모든 대상의 업로드·복원 검증 확인 후 직접 정리하세요.');
        break;
      }
      case 'status': {
        const s = await getStatus(ctx, { checkSchedule: true });
        if (flags.json) console.log(JSON.stringify(s, null, 2));
        else {
          console.log(`Google Drive: ${s.google.connected ? `연결됨 (${s.google.email ?? '계정 확인 필요'})` : '연결 안 됨'}  /  루트 폴더: My Drive/${s.google.rootFolderName}`);
          if (s.google.rootFolderLink) console.log(`  폴더: ${s.google.rootFolderLink}`);
          console.log(`자동 백업: ${s.schedule.enabled ? `매일 ${s.schedule.time}` : 'OFF'} (스케줄러 ${s.schedule.installed ? '등록됨' : '미등록'})  다음: ${s.schedule.nextRun ? new Date(s.schedule.nextRun).toLocaleString('ko-KR') : '-'}`);
          console.log(`저장소 ${s.repositories}개, 업로드 대기 ${s.pendingUploads}건, 자격증명 저장소: ${s.credentialBackend}`);
          if (s.lastJob) console.log(`마지막 작업: ${s.lastJob.status} @ ${new Date(s.lastJob.started_at).toLocaleString('ko-KR')} (성공 ${s.lastJob.success_count}, 변경없음 ${s.lastJob.unchanged_count}, 실패 ${s.lastJob.failed_count}, 대기 ${s.lastJob.pending_count})`);
        }
        break;
      }
      default:
        process.stdout.write(HELP);
        process.exitCode = 2;
    }
  } finally {
    ctx.close();
  }
}

function isNearScheduled(ctx: RuntimeContext): boolean {
  const now = new Date();
  const s = new Date(now);
  s.setHours(ctx.cfg.schedule.hour, ctx.cfg.schedule.minute, 0, 0);
  return Math.abs(now.getTime() - s.getTime()) < 15 * 60 * 1000;
}

function printSummary(s: Awaited<ReturnType<typeof runBackupAgent>>) {
  console.log(`\n작업 ${s.job_id.slice(0, 8)}: ${s.status}${s.message ? ` — ${s.message}` : ''}`);
  console.log(`  대상 ${s.repository_count} / 새 스냅샷 ${s.success_count} / 변경 없음 ${s.unchanged_count} / 실패 ${s.failed_count} / 업로드 대기 ${s.pending_count}`);
  for (const r of s.results) {
    if (r.outcome !== 'unchanged') console.log(`  - ${r.repository_id}: ${r.outcome}${r.message ? ` (${r.message.slice(0, 200)})` : ''}`);
  }
}

async function cmdSetup(ctx: RuntimeContext, sub: string | undefined, rest: string[], flags: Flags) {
  if (sub === 'google') {
    let clientId = str(flags, 'client-id');
    let secret: string | undefined;
    const jsonPath = str(flags, 'client-json');
    if (jsonPath) {
      const j = JSON.parse(readFileSync(jsonPath, 'utf8'));
      const c = j.installed ?? j.web;
      if (!c?.client_id) throw new Error('client_secret JSON 형식이 올바르지 않습니다 (installed.client_id 없음). Desktop App 유형인지 확인하세요.');
      if (!j.installed) console.log('⚠ Desktop App 유형이 아닌 OAuth Client입니다. Desktop App 유형을 권장합니다.');
      clientId = c.client_id;
      secret = c.client_secret;
    }
    if (flags['client-secret-stdin']) secret = await readStdin();
    if (!clientId) throw new Error('--client-json 또는 --client-id 가 필요합니다.');
    ctx.configStore.update((c) => {
      c.google.client_id = clientId!;
    });
    // Desktop Client Secret은 공개 클라이언트 값이므로 보안 요소로 취급하지 않지만, 평문 설정 파일 대신 OS 자격증명 저장소에 둔다
    if (secret) await ctx.creds.set(CredentialKeys.googleClientSecret, secret);
    console.log(`✅ Google OAuth Client 설정 완료 (client_id …${clientId.slice(-24)}). 이제 \`repovault auth login\` 을 실행하세요.`);
    return;
  }
  if (sub === 'root-folder') {
    const name = rest[0];
    if (!name) throw new Error('사용법: setup root-folder <이름>');
    ctx.configStore.update((c) => {
      c.google.root_folder_name = name;
      c.google.root_folder_id = null;
    });
    ctx.cache.setKv('drive_root_id', null);
    ctx.cache.clearFolderCache();
    console.log(`루트 폴더 이름: My Drive/${name}`);
    return;
  }
  throw new Error('사용법: setup google ... | setup root-folder <이름>');
}

async function cmdAuth(ctx: RuntimeContext, sub: string | undefined, flags: Flags) {
  if (sub === 'login') {
    if (!ctx.oauth) throw new Error('먼저 `repovault setup google --client-json <파일>` 로 OAuth Client를 설정하세요.');
    console.log('브라우저에서 Google 계정 인증을 진행해 주세요 (요청 권한: drive.file — RepoVault가 만든 파일만 접근)...');
    await ctx.oauth.authorizeInteractive({
      opener: async (url) => {
        console.log(`브라우저가 열리지 않으면 이 주소를 여세요:\n${url}\n`);
        const { openInBrowser } = await import('../core/cloud/oauth.js');
        await openInBrowser(url).catch(() => undefined);
      },
    });
    try {
      const r = await initializeDrive(ctx);
      console.log(`✅ Google Drive 연결 완료: ${r.email ?? '(이메일 확인 불가)'}\n  백업 폴더: https://drive.google.com/drive/folders/${r.rootId}\n  Drive에서 인식한 기존 저장소: ${r.repositories}개`);
    } catch (e) {
      if (e instanceof MultipleRootFoldersError) {
        console.log(e.message);
        for (const c of e.candidates) console.log(`  ${c.id}  생성 ${c.createdTime}`);
        return;
      }
      throw e;
    }
    return;
  }
  if (sub === 'status') {
    const s = await getStatus(ctx);
    console.log(JSON.stringify(s.google, null, 2));
    if (s.google.connected) {
      const about = await ctx.drive.about('user(emailAddress)');
      console.log(`토큰 갱신 및 Drive 접근 정상: ${about.user?.emailAddress}`);
    }
    return;
  }
  if (sub === 'logout') {
    if (ctx.oauth) await ctx.oauth.disconnect(!!flags.revoke);
    ctx.cache.setCloudAccount(ctx.cfg.google.account_email, 'disconnected');
    console.log('로컬 Google 연결을 해제했습니다. Google Drive의 백업 파일은 삭제되지 않았습니다.');
    return;
  }
  throw new Error('사용법: auth login | status | logout [--revoke]');
}

async function cmdHq(ctx: RuntimeContext, sub: string | undefined, flags: Flags) {
  if (sub === 'set') {
    const url = str(flags, 'url') ?? ctx.cfg.hq.url;
    if (!url || !/^https:\/\//.test(url)) throw new Error('사용법: echo <Heartbeat 키> | repovault hq set --url https://<HQ 주소> [--project-key cloudrepo]');
    const projectKey = str(flags, 'project-key') ?? ctx.cfg.hq.project_key;
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(projectKey)) throw new Error('project-key 형식이 아닙니다(영문 소문자·숫자·하이픈).');
    const secret = process.stdin.isTTY ? '' : await readStdin();
    if (secret) await ctx.creds.set(CredentialKeys.hqHeartbeatSecret, secret);
    else if (!(await ctx.creds.get(CredentialKeys.hqHeartbeatSecret))) throw new Error('Heartbeat 키를 stdin으로 전달하세요. (HQ 프로젝트 상세 → Heartbeat 키 발급)');
    ctx.configStore.update((c) => {
      c.hq = { url: url.replace(/\/+$/, ''), project_key: projectKey };
    });
    console.log(`HQ 보고 설정 완료: ${url} (${projectKey})${secret ? ' — 키는 OS 자격증명 저장소에 저장' : ''}. \`repovault hq test\`로 확인하세요.`);
    return;
  }
  if (sub === 'clear') {
    await ctx.creds.delete(CredentialKeys.hqHeartbeatSecret);
    ctx.configStore.update((c) => {
      c.hq = { url: null, project_key: c.hq.project_key };
    });
    console.log('HQ 보고를 껐습니다(키 삭제).');
    return;
  }
  const settings = await loadHqSettings(ctx);
  if (sub === 'test') {
    if (!settings) throw new Error('HQ 보고가 설정되지 않았습니다. `repovault hq set` 먼저 실행하세요.');
    const runId = `rv-test-${Date.now()}`;
    const now = new Date().toISOString();
    const r = await sendHeartbeat(settings, {
      kind: 'complete',
      payload: { runId, source: 'repovault', status: 'skipped', stage: 'test', startedAt: now, completedAt: now, message: '연결 테스트 (repovault hq test) — 백업 아님' },
    });
    console.log(r.ok ? `✅ HQ 수신 확인 (${r.status}) — 대시보드에 '건너뜀' 실행 1건(연결 테스트)이 보입니다.` : `❌ 전송 실패 ${r.status ?? ''} ${r.error ?? ''}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  console.log(settings ? `HQ 보고: 켜짐 — ${settings.url} (${settings.projectKey})` : `HQ 보고: 꺼짐${ctx.cfg.hq.url ? ' (키 없음)' : ''}`);
}

async function cmdGithub(ctx: RuntimeContext, sub: string | undefined) {
  if (sub === 'set-token') {
    const t = await readStdin();
    if (!t) throw new Error('stdin으로 토큰을 전달하세요.');
    await ctx.creds.set(CredentialKeys.githubToken, t);
    console.log('GitHub 토큰을 OS 자격증명 저장소에 저장했습니다.');
    return;
  }
  const tok = await resolveGitHubToken(ctx.creds);
  if (!tok) {
    console.log('GitHub 토큰을 찾지 못했습니다. `gh auth login` 하거나 `repovault github set-token` 을 사용하세요.');
    return;
  }
  const me = await new GitHubAdapter(tok.token).currentUser();
  console.log(`GitHub: ${me.login} (토큰 출처: ${tok.source}, scopes: ${me.scopes.join(', ') || '확인 불가(fine-grained)'})`);
}

async function cmdRepos(ctx: RuntimeContext, sub: string | undefined, rest: string[], flags: Flags) {
  if (!sub || sub === 'list') {
    const d = await discoverTargets(ctx);
    for (const e of d.errors) console.log(`⚠ ${e}`);
    const cached = new Map(ctx.cache.listRepositories().map((r) => [String(r.id), r]));
    for (const t of d.targets) {
      const c = cached.get(t.id);
      console.log(`${t.enabled ? '●' : '○'} ${t.id}\t${t.private ? 'private' : 'public'}${t.archived ? ' archived' : ''}\t마지막 백업: ${c?.latest_backup_at ?? '-'}\t스냅샷 ${c?.snapshot_count ?? 0}`);
    }
    for (const m of d.missing) console.log(`△ ${m.id}\t원격에서 사라짐 — Drive 백업 유지`);
    console.log(`\n총 ${d.targets.length}개 (활성 ${d.targets.filter((t) => t.enabled).length})`);
    return;
  }
  if (sub === 'add') {
    const url = rest[0];
    if (!url) throw new Error('사용법: repos add <url>');
    const m = createManualRemote({ url, name: str(flags, 'name'), owner: str(flags, 'owner'), provider: str(flags, 'provider') as never, private: !flags.public });
    ctx.configStore.update((c) => c.manual_remotes.push(m));
    console.log(`등록: ${m.owner}/${m.name} (${m.url})`);
    return;
  }
  if (sub === 'exclude' || sub === 'include') {
    const id = rest[0];
    if (!id) throw new Error(`사용법: repos ${sub} <id>`);
    ctx.configStore.update((c) => {
      c.excluded_repository_ids = c.excluded_repository_ids.filter((x) => x !== id);
      if (sub === 'exclude') c.excluded_repository_ids.push(id);
    });
    console.log(`${id}: ${sub === 'exclude' ? '백업 제외 (기존 Drive 백업은 유지)' : '백업 포함'}`);
    return;
  }
  throw new Error('사용법: repos list | add | exclude | include');
}

async function cmdDrive(ctx: RuntimeContext, sub: string | undefined, rest: string[]) {
  if (sub === 'select-root') {
    const id = rest[0];
    if (!id) throw new Error('사용법: drive select-root <folderId>');
    ctx.configStore.update((c) => {
      c.google.root_folder_id = id;
    });
    ctx.cache.setKv('drive_root_id', id);
    ctx.cache.clearFolderCache();
    console.log(`루트 폴더를 ${id} 로 고정했습니다.`);
    return;
  }
  if (sub === 'resync') {
    await ctx.folders.ensureStructure();
    console.log(`Drive 인덱스에서 저장소 ${await ctx.index.syncToCache()}개를 동기화했습니다.`);
    return;
  }
  if (sub === 'rebuild') {
    await ctx.folders.ensureStructure();
    const r = await ctx.index.rebuildFromManifests();
    console.log(`스냅샷 manifest ${r.snapshots}개로 저장소 ${r.repositories}개 인덱스를 재구축했습니다.`);
    return;
  }
  const info = await getDriveInfo(ctx);
  if (info.error) console.log(`⚠ ${info.error}`);
  const q = info.quota;
  console.log(`계정: ${q?.email ?? '확인 불가'}`);
  console.log(`전체: ${formatBytes(q?.limit)} / 사용: ${formatBytes(q?.usage)} / 남음: ${formatBytes(q?.free)}`);
  console.log(`RepoVault 백업 용량(캐시 기준): ${formatBytes(info.repoVaultBytes)}`);
}

async function cmdSchedule(ctx: RuntimeContext, sub: string | undefined, flags: Flags) {
  if (sub === 'install') {
    const time = str(flags, 'time');
    if (time) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(time);
      if (!m) throw new Error('--time HH:MM');
      ctx.configStore.update((c) => {
        c.schedule.hour = Number(m[1]);
        c.schedule.minute = Number(m[2]);
        c.schedule.enabled = true;
      });
      ctx.reloadConfig();
    }
    const where = await installSchedule({ hour: ctx.cfg.schedule.hour, minute: ctx.cfg.schedule.minute, logDir: ctx.paths.logsDir });
    ctx.configStore.update((c) => {
      c.schedule.enabled = true;
    });
    console.log(`✅ 자동 백업 등록: 매일 ${String(ctx.cfg.schedule.hour).padStart(2, '0')}:${String(ctx.cfg.schedule.minute).padStart(2, '0')} (${where})`);
    return;
  }
  if (sub === 'uninstall') {
    await uninstallSchedule();
    ctx.configStore.update((c) => {
      c.schedule.enabled = false;
    });
    console.log('자동 백업 스케줄을 해제했습니다. (Drive 백업은 그대로 유지)');
    return;
  }
  console.log(JSON.stringify(await scheduleStatus(), null, 2));
}

main().catch((e) => {
  console.error(`✖ ${sanitizeError(e)}`);
  process.exitCode = 1;
});
