import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BackupJobSummary, RemoteStatus, RepositoryIndex } from '../types.js';

/**
 * 로컬 SQLite 캐시.
 * 이 DB는 클라우드 백업의 원본이 아니다. 삭제되어도 Drive Manifest/Index로 재구성된다.
 * 토큰/비밀번호/Bundle 등은 절대 저장하지 않는다.
 */
export class CacheDb {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repositories_cache (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        remote_url_sanitized TEXT,
        private INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        cloud_folder_id TEXT,
        index_file_id TEXT,
        latest_snapshot_id TEXT,
        latest_backup_at TEXT,
        last_checked_at TEXT,
        cloud_backup_status TEXT,
        remote_status TEXT,
        remote_message TEXT,
        snapshot_count INTEGER DEFAULT 0,
        total_size INTEGER DEFAULT 0,
        cache_updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS snapshots_cache (
        snapshot_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        manifest_file_id TEXT,
        folder_id TEXT,
        restorable INTEGER DEFAULT 0,
        archive_size INTEGER DEFAULT 0,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snap_repo ON snapshots_cache(repository_id, created_at_utc);
      CREATE TABLE IF NOT EXISTS backup_jobs_cache (
        id TEXT PRIMARY KEY,
        job_type TEXT,
        status TEXT,
        started_at TEXT,
        completed_at TEXT,
        repository_count INTEGER,
        success_count INTEGER,
        failed_count INTEGER,
        unchanged_count INTEGER,
        pending_count INTEGER,
        error_message_sanitized TEXT,
        results_json TEXT
      );
      CREATE TABLE IF NOT EXISTS pending_uploads (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        local_staging_path TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        drive_folder_id TEXT,
        drive_file_id TEXT,
        resumable_session_reference TEXT,
        retry_count INTEGER DEFAULT 0,
        next_retry_at TEXT,
        status TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cloud_accounts_cache (
        id TEXT PRIMARY KEY,
        provider TEXT,
        account_email TEXT,
        connection_status TEXT,
        credential_reference TEXT,
        connected_at TEXT,
        last_verified_at TEXT
      );
      CREATE TABLE IF NOT EXISTS folder_cache (
        path TEXT PRIMARY KEY,
        folder_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  close() {
    this.db.close();
  }

  // ---------- kv ----------
  getKv(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setKv(key: string, value: string | null) {
    if (value === null) this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---------- folder cache ----------
  getFolderId(path: string): string | null {
    const row = this.db.prepare('SELECT folder_id FROM folder_cache WHERE path = ?').get(path) as { folder_id: string } | undefined;
    return row?.folder_id ?? null;
  }
  setFolderId(path: string, id: string) {
    this.db
      .prepare('INSERT INTO folder_cache(path, folder_id, updated_at) VALUES(?, ?, ?) ON CONFLICT(path) DO UPDATE SET folder_id = excluded.folder_id, updated_at = excluded.updated_at')
      .run(path, id, new Date().toISOString());
  }
  clearFolderCache() {
    this.db.exec('DELETE FROM folder_cache');
  }

  // ---------- repositories / snapshots ----------
  upsertRepositoryFromIndex(idx: RepositoryIndex, indexFileId: string | null) {
    const completed = idx.snapshots.filter((s) => s.upload_status === 'completed');
    const latest = completed.sort((a, b) => b.created_at_utc.localeCompare(a.created_at_utc))[0];
    const total = completed.reduce((n, s) => n + (s.archive_size || 0), 0);
    this.db
      .prepare(
        `INSERT INTO repositories_cache(id, provider, owner, name, remote_url_sanitized, private, archived, cloud_folder_id, index_file_id,
          latest_snapshot_id, latest_backup_at, last_checked_at, cloud_backup_status, remote_status, remote_message, snapshot_count, total_size, cache_updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, owner=excluded.owner, name=excluded.name,
           remote_url_sanitized=excluded.remote_url_sanitized, private=excluded.private, archived=excluded.archived,
           cloud_folder_id=excluded.cloud_folder_id, index_file_id=excluded.index_file_id, latest_snapshot_id=excluded.latest_snapshot_id,
           latest_backup_at=excluded.latest_backup_at, last_checked_at=excluded.last_checked_at, cloud_backup_status=excluded.cloud_backup_status,
           remote_status=excluded.remote_status, remote_message=excluded.remote_message, snapshot_count=excluded.snapshot_count,
           total_size=excluded.total_size, cache_updated_at=excluded.cache_updated_at`,
      )
      .run(
        idx.repository_id,
        idx.provider,
        idx.owner,
        idx.name,
        idx.remote_url,
        idx.private ? 1 : 0,
        idx.archived ? 1 : 0,
        idx.repository_folder_id,
        indexFileId,
        latest?.snapshot_id ?? null,
        latest?.created_at_utc ?? null,
        idx.last_checked_at,
        latest ? 'backed_up' : 'no_backup',
        idx.last_remote_status,
        idx.last_remote_message ?? null,
        completed.length,
        total,
        new Date().toISOString(),
      );
    const del = this.db.prepare('DELETE FROM snapshots_cache WHERE repository_id = ?');
    del.run(idx.repository_id);
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO snapshots_cache(snapshot_id, repository_id, created_at_utc, manifest_file_id, folder_id, restorable, archive_size, data_json) VALUES(?,?,?,?,?,?,?,?)',
    );
    for (const s of idx.snapshots) {
      ins.run(s.snapshot_id, idx.repository_id, s.created_at_utc, s.manifest_file_id, s.folder_id, s.restorable ? 1 : 0, s.archive_size, JSON.stringify(s));
    }
  }

  setRemoteStatus(repoId: string, status: RemoteStatus, message: string | null, checkedAt: string) {
    this.db.prepare('UPDATE repositories_cache SET remote_status = ?, remote_message = ?, last_checked_at = ? WHERE id = ?').run(status, message, checkedAt, repoId);
  }

  listRepositories(): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM repositories_cache ORDER BY owner, name').all() as Array<Record<string, unknown>>;
  }

  listSnapshots(repoId?: string): Array<Record<string, unknown>> {
    const rows = repoId
      ? this.db.prepare('SELECT * FROM snapshots_cache WHERE repository_id = ? ORDER BY created_at_utc DESC').all(repoId)
      : this.db.prepare('SELECT * FROM snapshots_cache ORDER BY created_at_utc DESC').all();
    return rows as Array<Record<string, unknown>>;
  }

  clearRepositoryCache() {
    this.db.exec('DELETE FROM repositories_cache; DELETE FROM snapshots_cache;');
  }

  // ---------- jobs ----------
  saveJob(job: BackupJobSummary) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO backup_jobs_cache(id, job_type, status, started_at, completed_at, repository_count, success_count, failed_count, unchanged_count, pending_count, error_message_sanitized, results_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        job.job_id,
        job.trigger,
        job.status,
        job.started_at,
        job.completed_at,
        job.repository_count,
        job.success_count,
        job.failed_count,
        job.unchanged_count,
        job.pending_count,
        job.message ?? null,
        JSON.stringify(job.results),
      );
  }

  listJobs(limit = 30): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM backup_jobs_cache ORDER BY started_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
  }

  lastSuccessfulScheduledRun(): string | null {
    const row = this.db
      .prepare("SELECT started_at FROM backup_jobs_cache WHERE status IN ('completed','completed_with_errors') AND job_type IN ('schedule','login','catch-up','manual') ORDER BY started_at DESC LIMIT 1")
      .get() as { started_at: string } | undefined;
    return row?.started_at ?? null;
  }

  // ---------- pending uploads ----------
  upsertPending(p: {
    id: string;
    job_id: string;
    snapshot_id: string;
    repository_id: string;
    file_name: string;
    local_staging_path: string;
    source_sha256: string;
    file_size: number;
    drive_folder_id?: string | null;
    drive_file_id?: string | null;
    resumable_session_reference?: string | null;
    status: string;
    last_error?: string | null;
    retry_count?: number;
    next_retry_at?: string | null;
  }) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pending_uploads(id, job_id, snapshot_id, repository_id, file_name, local_staging_path, source_sha256, file_size, drive_folder_id, drive_file_id, resumable_session_reference, retry_count, next_retry_at, status, last_error, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET drive_folder_id=excluded.drive_folder_id, drive_file_id=excluded.drive_file_id,
           resumable_session_reference=excluded.resumable_session_reference, retry_count=excluded.retry_count, next_retry_at=excluded.next_retry_at,
           status=excluded.status, last_error=excluded.last_error, updated_at=excluded.updated_at`,
      )
      .run(
        p.id,
        p.job_id,
        p.snapshot_id,
        p.repository_id,
        p.file_name,
        p.local_staging_path,
        p.source_sha256,
        p.file_size,
        p.drive_folder_id ?? null,
        p.drive_file_id ?? null,
        p.resumable_session_reference ?? null,
        p.retry_count ?? 0,
        p.next_retry_at ?? null,
        p.status,
        p.last_error ?? null,
        now,
        now,
      );
  }

  listPending(): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM pending_uploads WHERE status != 'verified' ORDER BY created_at").all() as Array<Record<string, unknown>>;
  }

  deletePendingForJob(jobId: string) {
    this.db.prepare('DELETE FROM pending_uploads WHERE job_id = ?').run(jobId);
  }

  // ---------- accounts ----------
  setCloudAccount(email: string | null, status: string) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO cloud_accounts_cache(id, provider, account_email, connection_status, credential_reference, connected_at, last_verified_at)
         VALUES('google', 'google-drive', ?, ?, 'os-credential-store:google-refresh-token', ?, ?)
         ON CONFLICT(id) DO UPDATE SET account_email=excluded.account_email, connection_status=excluded.connection_status, last_verified_at=excluded.last_verified_at`,
      )
      .run(email, status, now, now);
  }

  getCloudAccount(): Record<string, unknown> | null {
    return (this.db.prepare("SELECT * FROM cloud_accounts_cache WHERE id = 'google'").get() as Record<string, unknown>) ?? null;
  }
}
