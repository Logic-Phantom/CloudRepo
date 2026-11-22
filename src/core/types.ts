export const SCHEMA_VERSION = 1;
export const APP_VERSION = '0.1.0';

export type ProviderKind = 'github' | 'gitlab' | 'bitbucket' | 'gitea' | 'custom' | 'legacy';

/** 백업 대상 저장소 */
export interface RepositoryTarget {
  /** 예: github-logic-phantom-cloudrepo */
  id: string;
  provider: ProviderKind;
  owner: string;
  name: string;
  /** 인증정보가 제거된 Remote URL (기록/표시용) */
  remoteUrl: string;
  /** 실제 fetch에 사용하는 URL (인증정보 포함 금지 — 인증은 헤더/Credential Helper로 전달) */
  cloneUrl: string;
  private: boolean;
  archived: boolean;
  fork?: boolean;
  enabled: boolean;
  source: 'discovered' | 'manual' | 'legacy';
  defaultBranch?: string;
}

export type RemoteStatus =
  | 'ok'
  | 'unchanged'
  | 'changed'
  | 'remote_unavailable'
  | 'remote_missing'
  | 'auth_error'
  | 'network_error';

export type RefMap = Record<string, string>;

export interface RefChanges {
  added: string[];
  updated: string[];
  deleted: string[];
  forced: string[];
}

export interface RefsDocument {
  schema_version: number;
  snapshot_id: string;
  created_at_utc: string;
  head_symref: string | null;
  /** fetch 시점 원격의 refs/heads/*, refs/tags/* */
  remote_refs: RefMap;
  /** 삭제/강제 변경으로 보호된 과거 Ref (refs/repovault/preserved/...) */
  preserved_refs: RefMap;
  /** 번들에 포함된 전체 ref */
  all_refs: RefMap;
  changes: RefChanges;
  new_commit_count: number | null;
}

export type LfsStatus = 'not_used' | 'complete' | 'tool_missing' | 'failed';

export interface LfsInfo {
  status: LfsStatus;
  object_count: number;
  total_size: number;
  objects?: Array<{ oid: string; size: number }>;
  message?: string;
}

export interface SubmoduleInfo {
  path: string;
  url: string;
  commit: string | null;
  included_in_backup: boolean;
  accessible: 'unknown' | 'yes' | 'no';
  restorable: boolean;
}

export type UploadStatus = 'pending' | 'partial' | 'completed';
export type VerificationStatus = 'pending' | 'verified' | 'failed';
export type RestoreTestStatus = 'pending' | 'passed' | 'failed' | 'skipped';

export interface SnapshotFileEntry {
  name: string;
  file_id: string | null;
  size: number;
  sha256: string;
  verified_by?: 'sha256Checksum' | 'download';
}

export interface SnapshotManifest {
  schema_version: number;
  snapshot_id: string;
  snapshot_folder: string;
  repository_id: string;
  provider: ProviderKind;
  owner: string;
  repository_name: string;
  remote_url: string;
  private: boolean;
  created_at_utc: string;
  backup_mode: 'full' | 'incremental';
  parent_snapshot_id: string | null;
  is_empty_repository: boolean;
  git_bundle_file_id: string | null;
  lfs_archive_file_id: string | null;
  refs_file_id: string | null;
  submodules_file_id: string | null;
  checksums_file_id: string | null;
  archive_size: number;
  archive_sha256: string | null;
  files: SnapshotFileEntry[];
  git_version: string;
  branch_count: number;
  tag_count: number;
  ref_count: number;
  preserved_ref_count: number;
  head_symref: string | null;
  refs_summary: RefMap;
  changes: RefChanges;
  lfs_status: LfsStatus;
  submodule_status: 'none' | 'metadata_only' | 'tracked';
  upload_status: UploadStatus;
  verification_status: VerificationStatus;
  restore_test_status: RestoreTestStatus;
  device_id: string;
  app_version: string;
}

export interface SnapshotIndexEntry {
  snapshot_id: string;
  created_at_utc: string;
  folder_id: string | null;
  manifest_file_id: string | null;
  upload_status: UploadStatus;
  verification_status: VerificationStatus;
  restore_test_status: RestoreTestStatus;
  restorable: boolean;
  archive_size: number;
  branch_count: number;
  tag_count: number;
  preserved_ref_count: number;
  lfs_status: LfsStatus;
  device_id: string;
  changes: RefChanges;
}

export interface RepositoryIndex {
  schema_version: number;
  repository_id: string;
  provider: ProviderKind;
  owner: string;
  name: string;
  remote_url: string;
  private: boolean;
  archived: boolean;
  repository_folder_id: string | null;
  last_checked_at: string | null;
  last_remote_status: RemoteStatus | null;
  last_remote_message?: string | null;
  latest_snapshot_id: string | null;
  snapshots: SnapshotIndexEntry[];
  updated_at: string;
}

export interface BackupIndexRepoEntry {
  repository_id: string;
  provider: ProviderKind;
  owner: string;
  name: string;
  private: boolean;
  index_file_id: string | null;
  latest_snapshot_id: string | null;
  latest_backup_at: string | null;
  last_checked_at: string | null;
  last_remote_status: RemoteStatus | null;
  snapshot_count: number;
  total_size: number;
}

export interface BackupIndex {
  schema_version: number;
  updated_at: string;
  repositories: Record<string, BackupIndexRepoEntry>;
}

export interface DeviceInfo {
  schema_version: number;
  device_id: string;
  hostname: string;
  platform: string;
  app_version: string;
  first_seen_at: string;
  last_seen_at: string;
  last_backup_job_id: string | null;
  last_backup_completed_at: string | null;
}

export type RepoBackupOutcome =
  | 'created'
  | 'unchanged'
  | 'pending_upload'
  | 'failed'
  | 'remote_unavailable'
  | 'skipped';

export interface RepoBackupResult {
  repository_id: string;
  outcome: RepoBackupOutcome;
  snapshot_id?: string;
  message?: string;
  bytes_uploaded?: number;
}

export interface BackupJobSummary {
  job_id: string;
  trigger: string;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'skipped';
  repository_count: number;
  success_count: number;
  unchanged_count: number;
  failed_count: number;
  pending_count: number;
  results: RepoBackupResult[];
  message?: string;
}
