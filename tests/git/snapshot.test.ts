import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRemote, git, makeContext, startDrive, tmp } from '../helpers/env.js';
import type { MockDriveServer } from '../helpers/mock-drive.js';
import { backupRepository, getPreviousSnapshot } from '../../src/core/agent/backup-runner.js';
import { GitEngine } from '../../src/core/git/git-engine.js';
import { restoreSnapshot } from '../../src/core/git/restore-engine.js';
import type { RuntimeContext } from '../../src/core/context.js';

let drive: MockDriveServer;
let remote: FakeRemote;
let ctx: RuntimeContext;
const engine = new GitEngine();

beforeEach(async () => {
  drive = await startDrive();
  remote = new FakeRemote();
  ({ ctx } = makeContext(drive));
  await ctx.folders.ensureStructure();
});
afterEach(async () => {
  ctx.close();
  remote.destroy();
  await drive.stop();
});

const backup = (force = false) => backupRepository(ctx, engine, remote.target(), [], { force });

describe('Git 백업 (Cloud-Only)', () => {
  it('최초 백업 → 변경 없음 생략 → 새 커밋 감지', async () => {
    remote.commit('a.txt', 'hello');
    remote.push();
    const r1 = await backup();
    expect(r1.outcome).toBe('created');
    expect(drive.byName('repository.bundle')).toHaveLength(1);
    expect(drive.byName('manifest.json')).toHaveLength(1);

    const r2 = await backup();
    expect(r2.outcome).toBe('unchanged');
    expect(drive.byName('repository.bundle')).toHaveLength(1);

    remote.commit('b.txt', 'world');
    remote.push();
    const r3 = await backup();
    expect(r3.outcome).toBe('created');
    expect(drive.byName('repository.bundle')).toHaveLength(2);

    const { prev } = await getPreviousSnapshot(ctx, remote.target().id);
    expect(prev?.refs.changes.updated).toEqual(['refs/heads/main']);
    expect(prev?.refs.new_commit_count).toBe(1);
  });

  it('신규 브랜치 감지, 브랜치 삭제 후 과거 커밋 보존', async () => {
    remote.commit('a.txt', '1');
    remote.push();
    git(remote.work, 'checkout', '-q', '-b', 'feature/로그인');
    const featureSha = remote.commit('f.txt', 'feature');
    remote.push('feature/로그인');
    expect((await backup()).outcome).toBe('created');

    git(remote.work, 'push', '-q', 'origin', '--delete', 'feature/로그인');
    expect((await backup()).outcome).toBe('created');
    const { prev } = await getPreviousSnapshot(ctx, remote.target().id);
    expect(prev!.refs.changes.deleted).toEqual(['refs/heads/feature/로그인']);
    const preserved = Object.entries(prev!.refs.preserved_refs);
    expect(preserved).toHaveLength(1);
    expect(preserved[0]![0]).toMatch(/^refs\/repovault\/preserved\/\d{8}T\d{6}Z-[0-9a-f]{8}\/heads\/feature\/로그인$/);
    expect(preserved[0]![1]).toBe(featureSha);

    // 다음 스냅샷에도 보호 ref가 이어진다 (각 Full Snapshot 독립 복원 가능)
    git(remote.work, 'checkout', '-q', 'main');
    remote.commit('c.txt', '3');
    remote.push();
    expect((await backup()).outcome).toBe('created');
    const { prev: p3 } = await getPreviousSnapshot(ctx, remote.target().id);
    expect(Object.values(p3!.refs.preserved_refs)).toContain(featureSha);

    // 최신 스냅샷 하나만으로 삭제된 브랜치 커밋 복원 가능
    const dest = join(tmp(), 'restore');
    const res = await restoreSnapshot(ctx, { repositoryId: remote.target().id, destination: dest });
    expect(Object.values(res.restored_refs)).toContain(featureSha);
    expect(git(dest, 'cat-file', '-t', featureSha)).toBe('commit');
  });

  it('강제 푸시 이전 커밋과 태그 추가/삭제/이동을 보존', async () => {
    const c1 = remote.commit('a.txt', '1');
    git(remote.work, 'tag', '-a', 'v2.0', '-m', 'annotated');
    const old = remote.commit('a.txt', '2');
    git(remote.work, 'tag', 'v1.0');
    remote.push('main', '--tags');
    await backup();

    // 히스토리 재작성 후 강제 푸시 + 태그 삭제
    git(remote.work, 'reset', '-q', '--hard', 'HEAD~1');
    const rewritten = remote.commit('a.txt', 'rewritten');
    git(remote.work, 'push', '-q', '-f', 'origin', 'main');
    git(remote.work, 'push', '-q', 'origin', '--delete', 'v1.0');
    // 오래된 객체가 원격에서 사라진 상황을 재현 (gc)
    git(remote.bare, 'reflog', 'expire', '--expire=now', '--all');
    git(remote.bare, 'gc', '-q', '--prune=now');
    expect(() => git(remote.bare, 'cat-file', '-e', old)).toThrow();

    const r = await backup();
    expect(r.outcome).toBe('created');
    const { prev } = await getPreviousSnapshot(ctx, remote.target().id);
    expect(prev!.refs.changes.forced).toEqual(['refs/heads/main']);
    expect(prev!.refs.changes.deleted).toEqual(['refs/tags/v1.0']);
    expect(Object.values(prev!.refs.preserved_refs)).toEqual(expect.arrayContaining([old]));
    expect(prev!.refs.remote_refs['refs/heads/main']).toBe(rewritten);
    expect(Object.keys(prev!.refs.preserved_refs).some((k) => k.endsWith('/tags/v1.0'))).toBe(true);

    const dest = join(tmp(), 'restore');
    await restoreSnapshot(ctx, { repositoryId: remote.target().id, destination: dest });
    expect(git(dest, 'cat-file', '-t', old)).toBe('commit');
    expect(git(dest, 'rev-parse', 'refs/tags/v2.0^{commit}')).toBe(c1);
    expect(git(dest, 'rev-parse', 'refs/heads/main')).toBe(rewritten);
  });

  it('원격 삭제/접근 불가 시 remote_unavailable 처리, 기존 Drive 백업 유지', async () => {
    remote.commit('a.txt', '1');
    remote.push();
    await backup();
    const before = drive.byName('repository.bundle').length;
    rmSync(remote.bare, { recursive: true, force: true });
    const r = await backup();
    expect(r.outcome).toBe('remote_unavailable');
    expect(drive.byName('repository.bundle')).toHaveLength(before);
    const idx = await ctx.index.readRepositoryIndex(remote.target().id);
    expect(idx!.data.last_remote_status).toBe('remote_unavailable');
    expect(idx!.data.snapshots.filter((s) => s.restorable)).toHaveLength(1);
  });

  it('빈 저장소도 스냅샷으로 기록', async () => {
    const r = await backup();
    expect(r.outcome).toBe('created');
    const { manifest } = await getPreviousSnapshot(ctx, remote.target().id);
    expect(manifest!.is_empty_repository).toBe(true);
    expect(drive.byName('repository.bundle')).toHaveLength(0);
  });

  it('백업 후 로컬 임시 작업 공간이 남지 않는다', async () => {
    remote.commit('a.txt', '1');
    remote.push();
    await backup();
    expect(readdirSync(ctx.workDir)).toEqual([]);
  });

  it('Submodule 메타데이터를 기록', async () => {
    const sub = new FakeRemote();
    sub.commit('lib.txt', 'lib');
    sub.push();
    git(remote.work, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.bare, 'libs/sub');
    remote.commit('a.txt', '1', 'add submodule');
    remote.push();
    await backup();
    const { manifest } = await getPreviousSnapshot(ctx, remote.target().id);
    expect(manifest!.submodule_status).toBe('metadata_only');
    const subFile = drive.byName('submodules.json')[0]!;
    const doc = JSON.parse(subFile.content!.toString());
    expect(doc.submodules[0].path).toBe('libs/sub');
    expect(doc.submodules[0].commit).toMatch(/^[0-9a-f]{40}$/);
    expect(doc.submodules[0].included_in_backup).toBe(false);
    sub.destroy();
  });
});
