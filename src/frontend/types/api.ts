export interface RefChanges {
  added: string[];
  updated: string[];
  deleted: string[];
  forced: string[];
}

export interface AppStatus {
  google: { clientConfigured: boolean; connected: boolean; email: string | null; rootFolderName: string; rootFolderId: string | null; rootFolderLink: string | null };
  schedule: { enabled: boolean; time: string; nextRun: string | null; installed: boolean; detail: string };
  lastJob: JobSummary | null;
  agent: { state: string; current?: string | null; progress?: { done: number; total: number } } | null;
  repositories: number;
  pendingUploads: number;
  tempUsageBytes: number;
  credentialBackend: string;
}

export interface RepoResult {
  repository_id: string;
  outcome: 'created' | 'unchanged' | 'pending_upload' | 'failed' | 'remote_unavailable' | 'skipped';
  snapshot_id?: string;
  message?: string;
}

export interface JobSummary {
  job_id?: string;
  id?: string;
  trigger?: string;
  job_type?: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  repository_count: number;
  success_count: number;
  unchanged_count: number;
  failed_count: number;
  pending_count: number;
  results: RepoResult[];
  message?: string;
}

export interface CachedRepo {
  id: string;
  provider: string;
  owner: string;
  name: string;
  remote_url_sanitized: string;
  private: number;
  archived: number;
  latest_snapshot_id: string | null;
  latest_backup_at: string | null;
  last_checked_at: string | null;
  remote_status: string | null;
  remote_message: string | null;
  snapshot_count: number;
  total_size: number;
  cloud_folder_id: string | null;
}

export interface TargetRepo {
  id: string;
  provider: string;
  owner: string;
  name: string;
  remoteUrl: string;
  private: boolean;
  archived: boolean;
  enabled: boolean;
  source: string;
}

export interface SnapshotRow {
  snapshot_id: string;
  repository_id: string;
  created_at_utc: string;
  archive_size: number;
  restorable: number;
  folder_id: string | null;
  data: {
    branch_count: number;
    tag_count: number;
    preserved_ref_count: number;
    lfs_status: string;
    upload_status: string;
    verification_status: string;
    restore_test_status: string;
    changes: RefChanges;
  };
}

export interface QuotaInfo {
  limit: number | null;
  usage: number | null;
  free: number | null;
  checkedAt: string;
  email: string | null;
}

export interface Api {
  status(): Promise<AppStatus>;
  repositories(): Promise<{ cached: CachedRepo[]; targets: TargetRepo[]; excluded: string[] }>;
  discover(): Promise<{ targets: TargetRepo[]; missing: string[]; errors: string[]; github: { login: string | null; tokenSource: string | null; ok: boolean } }>;
  snapshots(repoId?: string): Promise<SnapshotRow[]>;
  jobs(): Promise<JobSummary[]>;
  pending(): Promise<Array<{ repository_id: string; snapshot_id: string; state: string; retry_count: number; next_retry_at: string | null; last_error: string | null; files: Array<{ name: string; size: number; verified: boolean }> } | null>>;
  driveInfo(): Promise<{ quota: QuotaInfo | null; repoVaultBytes: number; error?: string }>;
  config(): Promise<any>;
  saveConfig(patch: any): Promise<any>;
  setupClientJson(): Promise<{ clientId: string } | null>;
  authLogin(): Promise<{ email: string | null; rootId: string; repositories: number }>;
  authLogout(revoke: boolean): Promise<boolean>;
  resync(): Promise<number>;
  rebuild(): Promise<{ repositories: number; snapshots: number }>;
  runBackup(repoId?: string): Promise<{ pid: number }>;
  snapshotManifest(repoId: string, snapshotId: string): Promise<any>;
  chooseDirectory(): Promise<string | null>;
  restore(opts: { repositoryId: string; snapshotId?: string; destination: string; refs?: string[]; setRemoteUrl?: string }): Promise<{ destination: string; snapshot_id: string; restored_refs: Record<string, string>; lfs: string; warnings: string[] }>;
  scheduleInstall(hour: number, minute: number): Promise<string>;
  scheduleUninstall(): Promise<boolean>;
  setExcluded(repoId: string, excluded: boolean): Promise<string[]>;
  addRemote(url: string, name?: string, owner?: string): Promise<unknown>;
  openExternal(url: string): Promise<void>;
}
