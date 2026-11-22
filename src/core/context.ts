import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ConfigStore, type AppConfig } from './config.js';
import { CacheDb } from './database/cache.js';
import { createCredentialStore, type CredentialStore } from './security/credential-store.js';
import { GoogleOAuthManager, ReauthRequiredError, type OAuthEndpoints } from './cloud/oauth.js';
import { GoogleDriveClient, type DriveEndpoints, type TokenProvider } from './cloud/drive-client.js';
import { DriveFolderManager } from './cloud/folder-manager.js';
import { CloudIndexManager } from './cloud/manifest.js';
import { ResumableUploadManager } from './cloud/upload-manager.js';
import { Logger } from './utils/logger.js';
import { resolveAppPaths, type AppPaths } from './utils/paths.js';

export interface ContextOptions {
  paths?: AppPaths;
  creds?: CredentialStore;
  tokens?: TokenProvider;
  driveEndpoints?: DriveEndpoints;
  oauthEndpoints?: OAuthEndpoints;
  logger?: Logger;
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
}

class MissingClientTokenProvider implements TokenProvider {
  async getAccessToken(): Promise<string> {
    throw new ReauthRequiredError('Google OAuth Client ID가 설정되지 않았습니다. `repovault setup google --client-id <ID>`를 먼저 실행해 주세요.');
  }
}

/** CLI·GUI·백그라운드 에이전트가 공유하는 런타임 컨텍스트 */
export class RuntimeContext {
  readonly paths: AppPaths;
  readonly configStore: ConfigStore;
  cfg: AppConfig;
  readonly cache: CacheDb;
  readonly creds: CredentialStore;
  readonly oauth: GoogleOAuthManager | null;
  readonly tokens: TokenProvider;
  readonly drive: GoogleDriveClient;
  readonly folders: DriveFolderManager;
  readonly index: CloudIndexManager;
  readonly uploader: ResumableUploadManager;
  log: Logger;
  readonly retryBaseMs: number;

  constructor(opts: ContextOptions = {}) {
    this.paths = opts.paths ?? resolveAppPaths();
    mkdirSync(this.paths.dataDir, { recursive: true });
    mkdirSync(this.paths.workDir, { recursive: true });
    this.configStore = new ConfigStore(this.paths.configFile);
    this.cfg = this.configStore.load();
    // 클라우드 러너(PC가 꺼져 있어도 동작하는 GitHub Actions 등)용 환경 변수 설정
    const env = process.env;
    if (env.REPOVAULT_GOOGLE_CLIENT_ID || env.REPOVAULT_DEVICE_ID || env.REPOVAULT_ROOT_FOLDER_NAME) {
      this.cfg = this.configStore.update((c) => {
        if (env.REPOVAULT_GOOGLE_CLIENT_ID) c.google.client_id = env.REPOVAULT_GOOGLE_CLIENT_ID.trim();
        if (env.REPOVAULT_DEVICE_ID) c.device_id = env.REPOVAULT_DEVICE_ID.trim();
        if (env.REPOVAULT_ROOT_FOLDER_NAME) c.google.root_folder_name = env.REPOVAULT_ROOT_FOLDER_NAME.trim();
      });
    }
    this.cache = new CacheDb(this.paths.cacheDb);
    this.creds = opts.creds ?? createCredentialStore(join(this.paths.dataDir, 'credentials.json'));
    this.retryBaseMs = opts.retryBaseMs ?? 1000;
    if (opts.tokens) {
      this.oauth = null;
      this.tokens = opts.tokens;
    } else if (this.cfg.google.client_id) {
      this.oauth = new GoogleOAuthManager(this.creds, this.cfg.google.client_id, opts.oauthEndpoints, opts.fetchImpl);
      this.tokens = this.oauth;
    } else {
      this.oauth = null;
      this.tokens = new MissingClientTokenProvider();
    }
    this.drive = new GoogleDriveClient(this.tokens, { endpoints: opts.driveEndpoints, retryBaseMs: this.retryBaseMs, fetchImpl: opts.fetchImpl });
    this.folders = new DriveFolderManager(this.drive, this.cache, this.cfg.google.root_folder_name, this.cfg.google.root_folder_id);
    this.index = new CloudIndexManager(this.drive, this.folders, this.cache);
    this.uploader = new ResumableUploadManager(this.drive, this.creds);
    this.log = opts.logger ?? new Logger(undefined, true);
  }

  get workDir(): string {
    return this.cfg.temp_dir_override ? join(this.cfg.temp_dir_override, 'repovault-work') : this.paths.workDir;
  }

  reloadConfig() {
    this.cfg = this.configStore.load();
  }

  close() {
    try {
      this.cache.close();
    } catch {
      /* ignore */
    }
  }
}
