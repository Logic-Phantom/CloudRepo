// 렌더러에는 최소한의 IPC 함수만 노출한다 (Node API 직접 노출 금지)
const { contextBridge, ipcRenderer } = require('electron');

const channels = [
  'status',
  'repositories',
  'discover',
  'snapshots',
  'jobs',
  'pending',
  'driveInfo',
  'config',
  'saveConfig',
  'setupClientJson',
  'authLogin',
  'authLogout',
  'resync',
  'rebuild',
  'runBackup',
  'runBackupInProcess',
  'snapshotManifest',
  'chooseDirectory',
  'restore',
  'scheduleInstall',
  'scheduleUninstall',
  'setExcluded',
  'addRemote',
  'openExternal',
] as const;

const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
for (const c of channels) api[c] = (...args: unknown[]) => ipcRenderer.invoke(c, ...args);

contextBridge.exposeInMainWorld('repovault', api);
