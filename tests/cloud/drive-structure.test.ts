import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeContext, startDrive } from '../helpers/env.js';
import type { MockDriveServer } from '../helpers/mock-drive.js';
import { MultipleRootFoldersError } from '../../src/core/cloud/folder-manager.js';
import { mergeRepositoryIndex, emptyRepositoryIndex } from '../../src/core/cloud/manifest.js';
import type { SnapshotIndexEntry } from '../../src/core/types.js';
import { initializeDrive } from '../../src/core/service.js';

let drive: MockDriveServer;
beforeEach(async () => {
  drive = await startDrive();
});
afterEach(async () => drive.stop());

const snap = (id: string, at: string): SnapshotIndexEntry => ({
  snapshot_id: id,
  created_at_utc: at,
  folder_id: null,
  manifest_file_id: `m-${id}`,
  upload_status: 'completed',
  verification_status: 'verified',
  restore_test_status: 'passed',
  restorable: true,
  archive_size: 10,
  branch_count: 1,
  tag_count: 0,
  preserved_ref_count: 0,
  lfs_status: 'not_used',
  device_id: 'd',
  changes: { added: [], updated: [], deleted: [], forced: [] },
});

describe('Drive 폴더 구조 / Manifest', () => {
  it('최초 연결 시 My Drive/Git 구조 생성, 새 PC(빈 캐시)에서 같은 폴더를 찾는다', async () => {
    const a = makeContext(drive);
    const r = await initializeDrive(a.ctx);
    expect(r.email).toBe('tester@example.com');
    const root = drive.files.get(r.rootId)!;
    expect(root.name).toBe('Git');
    expect(root.parents).toEqual(['root']);
    for (const n of ['manifest', 'devices', 'repository-index', 'repositories', 'logs', 'cloud-backup', 'cloud-restore', 'system', 'integrity-reports']) {
      expect(drive.byName(n)).toHaveLength(1);
    }
    expect(drive.byName('schema-version.json')).toHaveLength(1);
    a.ctx.close();

    const b = makeContext(drive); // 다른 PC: 로컬 데이터 없음
    const r2 = await initializeDrive(b.ctx);
    expect(r2.rootId).toBe(r.rootId);
    expect(drive.byName('Git')).toHaveLength(1);
    expect(drive.byName('manifest')).toHaveLength(1);
    b.ctx.close();
  });

  it('루트 폴더가 여러 개면 자동 병합/삭제하지 않고 사용자 선택을 요구', async () => {
    const a = makeContext(drive);
    await a.ctx.drive.createFolder('Git', null, { repovault_role: 'root' });
    await a.ctx.drive.createFolder('Git', null, { repovault_role: 'root' });
    await expect(a.ctx.folders.resolveRoot()).rejects.toBeInstanceOf(MultipleRootFoldersError);
    expect(drive.byName('Git')).toHaveLength(2);
    a.ctx.close();
  });

  it('캐시된 폴더 ID가 무효(사용자가 삭제)하면 재검색 후 재생성', async () => {
    const a = makeContext(drive);
    const root = await a.ctx.folders.ensureStructure();
    drive.files.get(root)!.trashed = true;
    a.ctx.cache.setKv('drive_root_id', root);
    const fresh = makeContext(drive, a.home); // 같은 로컬 캐시
    const newRoot = await fresh.ctx.folders.ensureStructure();
    expect(newRoot).not.toBe(root);
    a.ctx.close();
    fresh.ctx.close();
  });

  it('두 기기가 동시에 인덱스를 갱신해도 스냅샷이 유실되지 않는다', async () => {
    const a = makeContext(drive);
    const b = makeContext(drive);
    await a.ctx.folders.ensureStructure();
    await b.ctx.folders.ensureStructure();
    const target = { id: 'custom-x-y', provider: 'custom' as const, owner: 'x', name: 'y', remoteUrl: 'u', private: true, archived: false };
    await Promise.all([
      a.ctx.index.updateRepositoryIndex(target, { snapshot: snap('s-a', '2026-01-01T00:00:00Z') }),
      b.ctx.index.updateRepositoryIndex(target, { snapshot: snap('s-b', '2026-01-01T00:00:01Z') }),
    ]);
    await a.ctx.index.updateRepositoryIndex(target, { checkedAt: new Date().toISOString() });
    const idx = await a.ctx.index.readRepositoryIndex('custom-x-y');
    expect(idx!.data.snapshots.map((s) => s.snapshot_id).sort()).toEqual(['s-a', 's-b']);
    a.ctx.close();
    b.ctx.close();
  });

  it('mergeRepositoryIndex: 합집합 + 완료 상태 우선', () => {
    const base = emptyRepositoryIndex({ id: 'r', provider: 'custom', owner: 'o', name: 'n', remoteUrl: '', private: true, archived: false });
    const pending = { ...snap('s1', '2026-01-01T00:00:00Z'), upload_status: 'pending' as const, restorable: false };
    const merged = mergeRepositoryIndex({ ...base, snapshots: [pending] }, { ...base, snapshots: [snap('s1', '2026-01-01T00:00:00Z'), snap('s2', '2026-01-02T00:00:00Z')] })!;
    expect(merged.snapshots).toHaveLength(2);
    expect(merged.snapshots[0]!.upload_status).toBe('completed');
    expect(merged.latest_snapshot_id).toBe('s2');
  });
});
