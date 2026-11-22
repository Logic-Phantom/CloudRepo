import { hostname } from 'node:os';
import type { GoogleDriveClient, DriveFile } from './drive-client.js';
import type { DriveFolderManager } from './folder-manager.js';
import type { CacheDb } from '../database/cache.js';
import { sleep, stableStringify } from '../utils/misc.js';
import {
  APP_VERSION,
  SCHEMA_VERSION,
  type BackupIndex,
  type BackupIndexRepoEntry,
  type DeviceInfo,
  type RemoteStatus,
  type RepositoryIndex,
  type RepositoryTarget,
  type SnapshotIndexEntry,
  type SnapshotManifest,
} from '../types.js';

export const INDEX_DIR = ['manifest', 'repository-index'];
export const DEVICES_DIR = ['manifest', 'devices'];
export const MANIFEST_DIR = ['manifest'];

export function isRestorable(m: Pick<SnapshotManifest, 'upload_status' | 'verification_status' | 'restore_test_status'>): boolean {
  return m.upload_status === 'completed' && m.verification_status === 'verified' && (m.restore_test_status === 'passed' || m.restore_test_status === 'skipped');
}

export function snapshotEntryFromManifest(m: SnapshotManifest, manifestFileId: string | null, folderId: string | null): SnapshotIndexEntry {
  return {
    snapshot_id: m.snapshot_id,
    created_at_utc: m.created_at_utc,
    folder_id: folderId,
    manifest_file_id: manifestFileId,
    upload_status: m.upload_status,
    verification_status: m.verification_status,
    restore_test_status: m.restore_test_status,
    restorable: isRestorable(m),
    archive_size: m.archive_size,
    branch_count: m.branch_count,
    tag_count: m.tag_count,
    preserved_ref_count: m.preserved_ref_count,
    lfs_status: m.lfs_status,
    device_id: m.device_id,
    changes: m.changes,
  };
}

const STATUS_RANK: Record<string, number> = { pending: 0, partial: 1, completed: 2 };

/** 두 저장소 인덱스를 손실 없이 병합 (스냅샷 합집합, 더 진행된 상태 우선, 최신 확인 시각 우선) */
export function mergeRepositoryIndex(a: RepositoryIndex | null, b: RepositoryIndex | null): RepositoryIndex | null {
  if (!a) return b;
  if (!b) return a;
  const snaps = new Map<string, SnapshotIndexEntry>();
  for (const s of [...a.snapshots, ...b.snapshots]) {
    const cur = snaps.get(s.snapshot_id);
    if (!cur || (STATUS_RANK[s.upload_status] ?? 0) > (STATUS_RANK[cur.upload_status] ?? 0) || (s.restorable && !cur.restorable)) snaps.set(s.snapshot_id, s);
  }
  const newer = (a.last_checked_at ?? '') >= (b.last_checked_at ?? '') ? a : b;
  const list = [...snaps.values()].sort((x, y) => x.created_at_utc.localeCompare(y.created_at_utc));
  const latest = [...list].reverse().find((s) => s.upload_status === 'completed');
  return {
    ...newer,
    repository_folder_id: a.repository_folder_id ?? b.repository_folder_id,
    snapshots: list,
    latest_snapshot_id: latest?.snapshot_id ?? null,
    updated_at: new Date().toISOString(),
  };
}

export function mergeBackupIndex(a: BackupIndex | null, b: BackupIndex | null): BackupIndex {
  const out: BackupIndex = { schema_version: SCHEMA_VERSION, updated_at: new Date().toISOString(), repositories: {} };
  for (const idx of [a, b]) {
    if (!idx) continue;
    for (const [id, e] of Object.entries(idx.repositories)) {
      const cur = out.repositories[id];
      if (!cur) {
        out.repositories[id] = { ...e };
        continue;
      }
      const pickLatest = (e.latest_backup_at ?? '') > (cur.latest_backup_at ?? '');
      const pickChecked = (e.last_checked_at ?? '') > (cur.last_checked_at ?? '');
      out.repositories[id] = {
        ...cur,
        ...(pickChecked ? { last_checked_at: e.last_checked_at, last_remote_status: e.last_remote_status } : {}),
        ...(pickLatest ? { latest_backup_at: e.latest_backup_at, latest_snapshot_id: e.latest_snapshot_id } : {}),
        index_file_id: cur.index_file_id ?? e.index_file_id,
        snapshot_count: Math.max(cur.snapshot_count, e.snapshot_count),
        total_size: Math.max(cur.total_size, e.total_size),
      };
    }
  }
  return out;
}

export function emptyRepositoryIndex(t: Pick<RepositoryTarget, 'id' | 'provider' | 'owner' | 'name' | 'remoteUrl' | 'private' | 'archived'>): RepositoryIndex {
  return {
    schema_version: SCHEMA_VERSION,
    repository_id: t.id,
    provider: t.provider,
    owner: t.owner,
    name: t.name,
    remote_url: t.remoteUrl,
    private: t.private,
    archived: t.archived,
    repository_folder_id: null,
    last_checked_at: null,
    last_remote_status: null,
    last_remote_message: null,
    latest_snapshot_id: null,
    snapshots: [],
    updated_at: new Date().toISOString(),
  };
}

export function backupEntryFromRepoIndex(idx: RepositoryIndex, indexFileId: string | null): BackupIndexRepoEntry {
  const completed = idx.snapshots.filter((s) => s.upload_status === 'completed');
  const latest = completed[completed.length - 1];
  return {
    repository_id: idx.repository_id,
    provider: idx.provider,
    owner: idx.owner,
    name: idx.name,
    private: idx.private,
    index_file_id: indexFileId,
    latest_snapshot_id: latest?.snapshot_id ?? null,
    latest_backup_at: latest?.created_at_utc ?? null,
    last_checked_at: idx.last_checked_at,
    last_remote_status: idx.last_remote_status,
    snapshot_count: completed.length,
    total_size: completed.reduce((n, s) => n + s.archive_size, 0),
  };
}

/**
 * Drive Manifest/Index 관리자. Drive가 백업 메타데이터의 유일한 영구 원본이다.
 * Drive v3에는 조건부 쓰기(CAS)가 없으므로: 최신 읽기 → 병합 → 쓰기 → 재조회 검증 → 불일치 시 재시도.
 * 인덱스가 손상/유실되어도 각 스냅샷의 manifest.json(불변)에서 전체를 재구성할 수 있다.
 */
export class CloudIndexManager {
  constructor(
    private readonly drive: GoogleDriveClient,
    private readonly folders: DriveFolderManager,
    private readonly cache: CacheDb,
  ) {}

  private async readFile<T>(f: DriveFile): Promise<T | null> {
    try {
      return JSON.parse((await this.drive.downloadBuffer(f.id)).toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  async readJson<T>(segments: string[], name: string, combine?: (a: T | null, b: T | null) => T | null): Promise<{ fileId: string; data: T } | null> {
    const folder = await this.folders.ensureFolder(segments);
    const files = (await this.folders.findChildren(folder, name)).sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''));
    if (!files.length) return null;
    let data: T | null = await this.readFile<T>(files[0]!);
    if (combine) for (const dup of files.slice(1)) data = combine(data, await this.readFile<T>(dup));
    return data ? { fileId: files[0]!.id, data } : null;
  }

  async writeMerged<T>(
    segments: string[],
    name: string,
    role: string,
    merge: (current: T | null) => T,
    verify: (remote: T) => boolean,
    combine?: (a: T | null, b: T | null) => T | null,
  ): Promise<{ fileId: string; data: T }> {
    const folder = await this.folders.ensureFolder(segments);
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await this.readJson<T>(segments, name, combine);
      const next = merge(current?.data ?? null);
      const body = stableStringify(next);
      let fileId: string;
      if (current) fileId = (await this.drive.updateFileContent(current.fileId, body, 'application/json')).id;
      else fileId = (await this.drive.createSmallFile(name, folder, body, 'application/json', { repovault_role: role })).id;
      const reread = await this.readJson<T>(segments, name, combine);
      if (reread && verify(reread.data)) return { fileId: reread.fileId, data: reread.data };
      lastErr = new Error(`${name} 병합 검증 실패 (동시 갱신 충돌). 재시도합니다.`);
      await sleep(200 + Math.random() * 800 * (attempt + 1));
    }
    throw lastErr ?? new Error(`${name} 갱신 실패`);
  }

  // ---------------- repository index ----------------

  async readRepositoryIndex(repoId: string) {
    return this.readJson<RepositoryIndex>(INDEX_DIR, `${repoId}.json`, mergeRepositoryIndex);
  }

  async updateRepositoryIndex(
    target: Pick<RepositoryTarget, 'id' | 'provider' | 'owner' | 'name' | 'remoteUrl' | 'private' | 'archived'>,
    patch: {
      snapshot?: SnapshotIndexEntry;
      checkedAt?: string;
      remoteStatus?: RemoteStatus;
      remoteMessage?: string | null;
      folderId?: string | null;
    },
  ) {
    const res = await this.writeMerged<RepositoryIndex>(
      INDEX_DIR,
      `${target.id}.json`,
      'repository-index',
      (cur) => {
        const base = cur ?? emptyRepositoryIndex(target);
        const next: RepositoryIndex = {
          ...base,
          remote_url: target.remoteUrl || base.remote_url,
          private: target.private,
          archived: target.archived,
          repository_folder_id: patch.folderId ?? base.repository_folder_id,
          last_checked_at: patch.checkedAt ?? base.last_checked_at,
          last_remote_status: patch.remoteStatus ?? base.last_remote_status,
          last_remote_message: patch.remoteMessage !== undefined ? patch.remoteMessage : (base.last_remote_message ?? null),
          snapshots: patch.snapshot ? [...base.snapshots.filter((s) => s.snapshot_id !== patch.snapshot!.snapshot_id), patch.snapshot] : base.snapshots,
          updated_at: new Date().toISOString(),
        };
        return mergeRepositoryIndex(next, null)!;
      },
      (remote) => !patch.snapshot || remote.snapshots.some((s) => s.snapshot_id === patch.snapshot!.snapshot_id && s.upload_status === patch.snapshot!.upload_status),
      mergeRepositoryIndex,
    );
    await this.updateBackupIndex(backupEntryFromRepoIndex(res.data, res.fileId));
    this.cache.upsertRepositoryFromIndex(res.data, res.fileId);
    return res;
  }

  // ---------------- backup index ----------------

  async readBackupIndex() {
    return this.readJson<BackupIndex>(MANIFEST_DIR, 'backup-index.json', (a, b) => mergeBackupIndex(a, b));
  }

  async updateBackupIndex(entry: BackupIndexRepoEntry) {
    return this.writeMerged<BackupIndex>(
      MANIFEST_DIR,
      'backup-index.json',
      'backup-index',
      (cur) => mergeBackupIndex(cur, { schema_version: SCHEMA_VERSION, updated_at: new Date().toISOString(), repositories: { [entry.repository_id]: entry } }),
      (remote) => {
        const e = remote.repositories[entry.repository_id];
        return !!e && (e.latest_snapshot_id === entry.latest_snapshot_id || (e.latest_backup_at ?? '') >= (entry.latest_backup_at ?? ''));
      },
      (a, b) => mergeBackupIndex(a, b),
    );
  }

  // ---------------- devices ----------------

  async touchDevice(deviceId: string, patch: Partial<DeviceInfo> = {}) {
    const name = `device-${deviceId}.json`;
    return this.writeMerged<DeviceInfo>(
      DEVICES_DIR,
      name,
      'device',
      (cur) => ({
        schema_version: SCHEMA_VERSION,
        device_id: deviceId,
        hostname: hostname(),
        platform: `${process.platform}-${process.arch}`,
        app_version: APP_VERSION,
        first_seen_at: cur?.first_seen_at ?? new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        last_backup_job_id: patch.last_backup_job_id ?? cur?.last_backup_job_id ?? null,
        last_backup_completed_at: patch.last_backup_completed_at ?? cur?.last_backup_completed_at ?? null,
      }),
      (r) => r.device_id === deviceId,
    );
  }

  // ---------------- reconcile ----------------

  /** Drive 전체에서 스냅샷 manifest.json 을 찾는다 (drive.file 범위 = 앱이 만든 파일) */
  async listSnapshotManifests(): Promise<Array<{ file: DriveFile; manifest: SnapshotManifest }>> {
    const files = await this.drive.listFiles(`name = 'manifest.json' and trashed = false and appProperties has { key='repovault_role' and value='snapshot-manifest' }`);
    const out: Array<{ file: DriveFile; manifest: SnapshotManifest }> = [];
    for (const f of files) {
      const m = await this.readFile<SnapshotManifest>(f);
      if (m && m.snapshot_id) out.push({ file: f, manifest: m });
    }
    return out;
  }

  /** 클라우드 인덱스를 로컬 캐시로 동기화 (새 PC / SQLite 삭제 후 복구) */
  async syncToCache(): Promise<number> {
    const bi = await this.readBackupIndex();
    let n = 0;
    for (const e of Object.values(bi?.data.repositories ?? {})) {
      const idx = await this.readRepositoryIndex(e.repository_id);
      if (idx) {
        this.cache.upsertRepositoryFromIndex(idx.data, idx.fileId);
        n++;
      }
    }
    return n;
  }

  /** 인덱스를 불변 스냅샷 manifest.json 들로부터 재구축 (인덱스 손상/유실 복구) */
  async rebuildFromManifests(): Promise<{ repositories: number; snapshots: number }> {
    const all = await this.listSnapshotManifests();
    const byRepo = new Map<string, Array<{ file: DriveFile; manifest: SnapshotManifest }>>();
    for (const x of all) {
      const list = byRepo.get(x.manifest.repository_id) ?? [];
      list.push(x);
      byRepo.set(x.manifest.repository_id, list);
    }
    for (const [repoId, list] of byRepo) {
      const m0 = list[0]!.manifest;
      const target = {
        id: repoId,
        provider: m0.provider,
        owner: m0.owner,
        name: m0.repository_name,
        remoteUrl: m0.remote_url,
        private: m0.private,
        archived: false,
      };
      const existing = await this.readRepositoryIndex(repoId);
      const rebuilt: RepositoryIndex = {
        ...(existing?.data ?? emptyRepositoryIndex(target)),
        snapshots: list.map((x) => snapshotEntryFromManifest(x.manifest, x.file.id, x.file.parents?.[0] ?? null)),
      };
      const merged = mergeRepositoryIndex(existing?.data ?? null, rebuilt)!;
      await this.writeMerged<RepositoryIndex>(
        INDEX_DIR,
        `${repoId}.json`,
        'repository-index',
        (cur) => mergeRepositoryIndex(cur, merged)!,
        (r) => list.every((x) => r.snapshots.some((s) => s.snapshot_id === x.manifest.snapshot_id)),
        mergeRepositoryIndex,
      ).then(async (res) => {
        await this.updateBackupIndex(backupEntryFromRepoIndex(res.data, res.fileId));
        this.cache.upsertRepositoryFromIndex(res.data, res.fileId);
      });
    }
    return { repositories: byRepo.size, snapshots: all.length };
  }
}
