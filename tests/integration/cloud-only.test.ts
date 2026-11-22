import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { FakeRemote, makeContext, startDrive } from '../helpers/env.js';
import type { MockDriveServer } from '../helpers/mock-drive.js';
import { runBackupAgent } from '../../src/core/agent/backup-runner.js';
import { TempWorkspace } from '../../src/core/git/temp-workspace.js';
import type { RuntimeContext } from '../../src/core/context.js';
import { createManualRemote } from '../../src/core/providers/generic-git.js';

let drive: MockDriveServer;
let remote: FakeRemote;
let ctx: RuntimeContext;

beforeEach(async () => {
  drive = await startDrive();
  remote = new FakeRemote();
  ({ ctx } = makeContext(drive));
  const m = createManualRemote({ url: remote.bare, name: 'repo', owner: 'test', provider: 'custom' });
  ctx.configStore.update((c) => c.manual_remotes.push(m));
  ctx.reloadConfig();
  ctx.cfg.upload.chunk_size_mb = 0.25;
});
afterEach(async () => {
  ctx.close();
  remote.destroy();
  await drive.stop();
});

const isBundleUpload = (url: URL) => url.pathname === '/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'resumable';

describe('Cloud-Only 검증', () => {
  it('에이전트 전체 실행: Drive 백업 완료 후 로컬 임시 데이터 정리, 로그/장치 정보 Drive 보관', async () => {
    remote.commit('a.txt', 'x');
    remote.push();
    const s = await runBackupAgent(ctx, { trigger: 'manual' });
    expect(s.status).toBe('completed');
    expect(s.success_count).toBe(1);
    expect(readdirSync(ctx.workDir)).toEqual([]);
    expect([...drive.files.values()].some((f) => f.appProperties.repovault_role === 'backup-log')).toBe(true);
    expect([...drive.files.values()].some((f) => /^device-.+\.json$/.test(f.name))).toBe(true);
    expect(existsSync(ctx.paths.lockFile)).toBe(false);

    const s2 = await runBackupAgent(ctx, { trigger: 'manual' });
    expect(s2.unchanged_count).toBe(1);
    expect(s2.success_count).toBe(0);
  });

  it('업로드 실패 → 완료로 표시하지 않고 Pending 유지 → 다음 실행에서 재시도 후 정리', async () => {
    remote.commit('a.txt', 'x');
    remote.push();
    drive.fail(500, (_req, url) => isBundleUpload(url), 100);
    const s = await runBackupAgent(ctx, { trigger: 'manual' });
    expect(s.pending_count).toBe(1);
    expect(s.status).toBe('completed_with_errors');
    expect(drive.byName('manifest.json')).toHaveLength(0);
    const idx = await ctx.index.readRepositoryIndex('custom-test-repo');
    expect(idx?.data.snapshots.filter((x) => x.upload_status === 'completed') ?? []).toHaveLength(0);
    const staged = TempWorkspace.scan(ctx.workDir);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.job!.state).toBe('pending_upload');
    expect(existsSync(staged[0]!.ws.gitDir)).toBe(false); // git 작업 디렉터리는 이미 정리, 스테이징만 유지
    expect(ctx.cache.listPending().length).toBeGreaterThan(0);

    drive['faults'] = [];
    const s2 = await runBackupAgent(ctx, { trigger: 'manual' });
    expect(s2.success_count).toBe(1);
    expect(drive.byName('manifest.json')).toHaveLength(1);
    expect(readdirSync(ctx.workDir)).toEqual([]);
    expect(ctx.cache.listPending()).toHaveLength(0);
  });

  it('Drive 용량 부족 시 안전 중단 + 기존 백업 보호 + 미전송 데이터 유지', async () => {
    remote.commit('a.txt', 'x');
    remote.push();
    await runBackupAgent(ctx, { trigger: 'manual' });
    const before = drive.files.size;
    remote.commit('b.txt', 'y'.repeat(10000));
    remote.push();
    drive.quotaLimit = drive.usage() + 100;
    const s = await runBackupAgent(ctx, { trigger: 'manual' });
    expect(s.pending_count).toBe(1);
    expect(s.results.find((r) => r.outcome === 'pending_upload')!.message).toMatch(/저장 공간/);
    expect(drive.byName('repository.bundle')).toHaveLength(1);
    expect(drive.files.size).toBeGreaterThanOrEqual(before);
  });

  it('SQLite 캐시를 지워도 Drive에서 재구축', async () => {
    remote.commit('a.txt', 'x');
    remote.push();
    await runBackupAgent(ctx, { trigger: 'manual' });
    ctx.cache.clearRepositoryCache();
    expect(ctx.cache.listRepositories()).toHaveLength(0);
    expect(await ctx.index.syncToCache()).toBe(1);
    expect(ctx.cache.listSnapshots()).toHaveLength(1);
  });

  it('중복 실행 방지 (락)', async () => {
    const { AgentLock } = await import('../../src/core/agent/lock.js');
    const lock = new AgentLock(ctx.paths.lockFile);
    lock.acquire();
    const s = await runBackupAgent(ctx, { trigger: 'manual' });
    expect(s.status).toBe('skipped');
    lock.release();
  });
});
