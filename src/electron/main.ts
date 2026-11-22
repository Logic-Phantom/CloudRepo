import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeContext } from '../core/context.js';
import { runBackupAgent } from '../core/agent/backup-runner.js';
import { getDriveInfo, getStatus, initializeDrive } from '../core/service.js';
import { restoreSnapshot, loadSnapshotManifest } from '../core/git/restore-engine.js';
import { installSchedule, uninstallSchedule } from '../core/scheduler/index.js';
import { CredentialKeys } from '../core/security/credential-store.js';
import { createManualRemote } from '../core/providers/generic-git.js';
import { discoverTargets } from '../core/discovery.js';
import { TempWorkspace } from '../core/git/temp-workspace.js';
import { sanitizeError } from '../core/utils/sanitize.js';
import type { AppConfig } from '../core/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, '..', 'cli', 'main.js');

// ---- 독립 백그라운드 에이전트 모드: RepoVault --run-backup-agent ----
if (process.argv.includes('--run-backup-agent')) {
  app.dock?.hide();
  const i = process.argv.indexOf('--trigger');
  const trigger = (i > 0 ? process.argv[i + 1] : 'schedule') as 'schedule';
  const ctx = new RuntimeContext();
  runBackupAgent(ctx, { trigger: trigger === 'schedule' ? 'catch-up' : trigger })
    .then((s) => app.exit(s.status === 'failed' ? 1 : 0))
    .catch(() => app.exit(1));
} else {
  startGui();
}

function startGui() {
  let ctx: RuntimeContext;
  const fresh = () => {
    ctx?.close();
    ctx = new RuntimeContext();
    return ctx;
  };
  fresh();

  const handle = (channel: string, fn: (...args: any[]) => Promise<unknown> | unknown) => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (e) {
        return { ok: false, error: sanitizeError(e) };
      }
    });
  };

  handle('status', () => getStatus(ctx, { checkSchedule: true }));
  handle('repositories', () => {
    const cached = ctx.cache.listRepositories();
    const targets = JSON.parse(ctx.cache.getKv('targets') ?? '[]');
    return { cached, targets, excluded: ctx.cfg.excluded_repository_ids };
  });
  handle('discover', async () => {
    const d = await discoverTargets(ctx);
    return { targets: d.targets.map(({ cloneUrl: _c, ...t }) => t), missing: d.missing.map((m) => m.id), errors: d.errors, github: d.github };
  });
  handle('snapshots', (repoId?: string) => ctx.cache.listSnapshots(repoId).map((r) => ({ ...r, data: JSON.parse(String(r.data_json)) })));
  handle('jobs', () => ctx.cache.listJobs(50).map((j) => ({ ...j, results: JSON.parse(String(j.results_json ?? '[]')) })));
  handle('pending', () => TempWorkspace.scan(ctx.workDir).map((x) => x.job));
  handle('driveInfo', () => getDriveInfo(ctx));
  handle('config', () => ctx.cfg);
  handle('saveConfig', (patch: Partial<AppConfig>) => {
    ctx.configStore.update((c) => Object.assign(c, patch));
    fresh();
    return ctx.cfg;
  });
  handle('setupClientJson', async () => {
    const r = await dialog.showOpenDialog({ title: 'Google OAuth client_secret JSON 선택', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const j = JSON.parse(readFileSync(r.filePaths[0], 'utf8'));
    const c = j.installed ?? j.web;
    if (!c?.client_id) throw new Error('Desktop App 유형 OAuth Client JSON이 아닙니다.');
    ctx.configStore.update((cfg) => {
      cfg.google.client_id = c.client_id;
    });
    if (c.client_secret) await ctx.creds.set(CredentialKeys.googleClientSecret, c.client_secret);
    fresh();
    return { clientId: `…${String(c.client_id).slice(-24)}` };
  });
  handle('authLogin', async () => {
    if (!ctx.oauth) throw new Error('먼저 OAuth Client(JSON)를 설정하세요.');
    await ctx.oauth.authorizeInteractive({ opener: (url) => shell.openExternal(url) });
    return initializeDrive(ctx);
  });
  handle('authLogout', async (revoke: boolean) => {
    await ctx.oauth?.disconnect(!!revoke);
    return true;
  });
  handle('resync', async () => {
    await ctx.folders.ensureStructure();
    return ctx.index.syncToCache();
  });
  handle('rebuild', async () => {
    await ctx.folders.ensureStructure();
    return ctx.index.rebuildFromManifests();
  });
  handle('runBackup', (repoId?: string) => {
    // GUI와 독립된 에이전트 프로세스로 실행 → 창을 닫아도 백업은 계속된다
    const args = [cliEntry, repoId ? 'backup' : '--run-backup-agent', ...(repoId ? ['--repo', repoId] : ['--trigger', 'manual'])];
    const child = spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore' });
    child.unref();
    return { pid: child.pid };
  });
  handle('runBackupInProcess', () => runBackupAgent(ctx, { trigger: 'manual' }));
  handle('snapshotManifest', async (repoId: string, snapshotId: string) => (await loadSnapshotManifest(ctx, repoId, snapshotId)).manifest);
  handle('chooseDirectory', async () => {
    const r = await dialog.showOpenDialog({ title: '복원할 위치 선택 (빈 폴더)', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('restore', (opts: { repositoryId: string; snapshotId?: string; destination: string; refs?: string[]; setRemoteUrl?: string }) => restoreSnapshot(ctx, opts));
  handle('scheduleInstall', async (hour: number, minute: number) => {
    ctx.configStore.update((c) => {
      c.schedule = { ...c.schedule, enabled: true, hour, minute };
    });
    fresh();
    return installSchedule({ hour, minute, logDir: ctx.paths.logsDir });
  });
  handle('scheduleUninstall', async () => {
    await uninstallSchedule();
    ctx.configStore.update((c) => {
      c.schedule.enabled = false;
    });
    fresh();
    return true;
  });
  handle('setExcluded', (repoId: string, excluded: boolean) => {
    ctx.configStore.update((c) => {
      c.excluded_repository_ids = c.excluded_repository_ids.filter((x) => x !== repoId);
      if (excluded) c.excluded_repository_ids.push(repoId);
    });
    fresh();
    return ctx.cfg.excluded_repository_ids;
  });
  handle('addRemote', (url: string, name?: string, owner?: string) => {
    const m = createManualRemote({ url, name, owner });
    ctx.configStore.update((c) => c.manual_remotes.push(m));
    fresh();
    return m;
  });
  handle('openExternal', (url: string) => {
    if (!/^https:\/\/(drive\.google\.com|console\.cloud\.google\.com|github\.com)\//.test(url)) throw new Error('허용되지 않은 URL');
    return shell.openExternal(url);
  });

  const createWindow = () => {
    const win = new BrowserWindow({
      width: 1240,
      height: 820,
      minWidth: 960,
      minHeight: 640,
      backgroundColor: '#0b0d12',
      title: 'RepoVault',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: join(here, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const devUrl = process.env.REPOVAULT_DEV_URL;
    if (devUrl) win.loadURL(devUrl);
    else win.loadFile(join(here, '..', 'frontend', 'index.html'));
  };

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    ctx.close();
    if (process.platform !== 'darwin') app.quit();
  });
}
