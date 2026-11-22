import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRemote, git, makeContext, startDrive, tmp } from '../helpers/env.js';
import type { MockDriveServer } from '../helpers/mock-drive.js';
import { backupRepository } from '../../src/core/agent/backup-runner.js';
import { GitEngine } from '../../src/core/git/git-engine.js';
import { restoreSnapshot, RestoreError } from '../../src/core/git/restore-engine.js';
import { initializeDrive } from '../../src/core/service.js';

let drive: MockDriveServer;
let remote: FakeRemote;

beforeEach(async () => {
  drive = await startDrive();
  remote = new FakeRemote();
});
afterEach(async () => {
  remote.destroy();
  await drive.stop();
});

async function seedBackup() {
  const a = makeContext(drive);
  await a.ctx.folders.ensureStructure();
  remote.commit('README.md', '# 한글 README');
  git(remote.work, 'checkout', '-q', '-b', 'develop');
  remote.commit('dev.txt', 'dev');
  git(remote.work, 'tag', 'v1');
  remote.push('main', 'develop', '--tags');
  const r = await backupRepository(a.ctx, new GitEngine(), remote.target(), []);
  expect(r.outcome).toBe('created');
  a.ctx.close();
  rmSync(a.home, { recursive: true, force: true }); // 기존 PC 로컬 데이터 완전 삭제
  return {
    main: git(remote.bare, 'rev-parse', 'refs/heads/main'),
    develop: git(remote.bare, 'rev-parse', 'refs/heads/develop'),
    tag: git(remote.bare, 'rev-parse', 'refs/tags/v1'),
  };
}

describe('Google Drive 단독 복원 (새 PC)', () => {
  it('로컬 데이터 없이 Drive 인증만으로 저장소 목록을 찾고 복원, 브랜치/태그/커밋 일치', async () => {
    const shas = await seedBackup();
    rmSync(remote.bare, { recursive: true, force: true }); // 원격도 사라진 상황

    const pc2 = makeContext(drive);
    const init = await initializeDrive(pc2.ctx);
    expect(init.repositories).toBe(1);
    expect(pc2.ctx.cache.listRepositories()[0]!.id).toBe('custom-test-repo');
    expect(pc2.ctx.cache.listSnapshots('custom-test-repo')).toHaveLength(1);

    const dest = join(tmp(), '복원 결과');
    const res = await restoreSnapshot(pc2.ctx, { repositoryId: 'custom-test-repo', destination: dest, setRemoteUrl: 'https://github.com/example/new.git' });
    expect(res.verified).toBe(true);
    expect(git(dest, 'rev-parse', 'refs/heads/main')).toBe(shas.main);
    expect(git(dest, 'rev-parse', 'refs/heads/develop')).toBe(shas.develop);
    expect(git(dest, 'rev-parse', 'refs/tags/v1')).toBe(shas.tag);
    expect(git(dest, 'status', '--porcelain')).toBe('');
    expect(git(dest, 'remote', 'get-url', 'origin')).toBe('https://github.com/example/new.git');
    expect(drive.byName('cloud-restore')).toHaveLength(1);
    pc2.ctx.close();
  });

  it('특정 브랜치만 복원', async () => {
    const shas = await seedBackup();
    const pc2 = makeContext(drive);
    await initializeDrive(pc2.ctx);
    const dest = join(tmp(), 'only-develop');
    await restoreSnapshot(pc2.ctx, { repositoryId: 'custom-test-repo', destination: dest, refs: ['develop'] });
    expect(git(dest, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/develop');
    expect(git(dest, 'rev-parse', 'HEAD')).toBe(shas.develop);
    pc2.ctx.close();
  });

  it('기존 폴더를 덮어쓰지 않는다 / 손상된 Bundle 복원 중단', async () => {
    await seedBackup();
    const pc2 = makeContext(drive);
    await initializeDrive(pc2.ctx);
    const dest = tmp();
    writeFileSync(join(dest, 'important.txt'), 'do not touch');
    await expect(restoreSnapshot(pc2.ctx, { repositoryId: 'custom-test-repo', destination: dest })).rejects.toBeInstanceOf(RestoreError);

    const bundle = drive.byName('repository.bundle')[0]!;
    bundle.content![bundle.content!.length - 1] ^= 0xff;
    const dest2 = join(tmp(), 'x');
    await expect(restoreSnapshot(pc2.ctx, { repositoryId: 'custom-test-repo', destination: dest2 })).rejects.toThrow(/SHA-256|불일치/);
    pc2.ctx.close();
  });

  it('인덱스 파일이 유실되어도 스냅샷 manifest.json 으로 재구축', async () => {
    await seedBackup();
    for (const f of drive.files.values()) if (f.name === 'custom-test-repo.json' || f.name === 'backup-index.json') f.trashed = true;
    const pc2 = makeContext(drive);
    await pc2.ctx.folders.ensureStructure();
    expect(await pc2.ctx.index.syncToCache()).toBe(0);
    const r = await pc2.ctx.index.rebuildFromManifests();
    expect(r).toEqual({ repositories: 1, snapshots: 1 });
    const dest = join(tmp(), 'rebuilt');
    mkdirSync(dest);
    const res = await restoreSnapshot(pc2.ctx, { repositoryId: 'custom-test-repo', destination: dest });
    expect(Object.keys(res.restored_refs).length).toBeGreaterThan(0);
    pc2.ctx.close();
  });
});
