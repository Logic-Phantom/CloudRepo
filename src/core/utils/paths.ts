import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 앱 로컬 경로. 여기에는 "재생성 가능한" 런타임 데이터만 둔다.
 * - dataDir: 설정(config.json), SQLite 캐시, 에이전트 상태
 * - cacheDir: 임시 Git 작업 공간과 Pending Upload 스테이징 (영구 백업 아님)
 * REPOVAULT_HOME 환경 변수로 전체 위치를 재정의할 수 있다(테스트/포터블 용도).
 */
export interface AppPaths {
  dataDir: string;
  cacheDir: string;
  workDir: string;
  logsDir: string;
  configFile: string;
  cacheDb: string;
  lockFile: string;
  statusFile: string;
}

export function resolveAppPaths(env: NodeJS.ProcessEnv = process.env, platform = process.platform): AppPaths {
  let dataDir: string;
  let cacheDir: string;
  let logsDir: string;
  if (env.REPOVAULT_HOME) {
    dataDir = join(env.REPOVAULT_HOME, 'data');
    cacheDir = join(env.REPOVAULT_HOME, 'cache');
    logsDir = join(env.REPOVAULT_HOME, 'logs');
  } else if (platform === 'darwin') {
    dataDir = join(homedir(), 'Library', 'Application Support', 'RepoVault');
    cacheDir = join(homedir(), 'Library', 'Caches', 'RepoVault');
    logsDir = join(homedir(), 'Library', 'Logs', 'RepoVault');
  } else if (platform === 'win32') {
    const appData = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    dataDir = join(appData, 'RepoVault');
    cacheDir = join(local, 'RepoVault', 'Cache');
    logsDir = join(local, 'RepoVault', 'Logs');
  } else {
    dataDir = join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'repovault');
    cacheDir = join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'repovault');
    logsDir = join(cacheDir, 'logs');
  }
  if (!cacheDir) cacheDir = join(tmpdir(), 'repovault');
  return {
    dataDir,
    cacheDir,
    workDir: join(cacheDir, 'work'),
    logsDir,
    configFile: join(dataDir, 'config.json'),
    cacheDb: join(dataDir, 'cache.sqlite'),
    lockFile: join(dataDir, 'agent.lock'),
    statusFile: join(dataDir, 'agent-status.json'),
  };
}
