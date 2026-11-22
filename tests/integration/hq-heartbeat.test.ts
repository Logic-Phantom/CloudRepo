import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeRemote, makeContext, startDrive } from '../helpers/env.js';
import type { MockDriveServer } from '../helpers/mock-drive.js';
import { runBackupAgent } from '../../src/core/agent/backup-runner.js';
import { buildFinalHeartbeat, signHeartbeat } from '../../src/core/agent/hq-reporter.js';
import { CredentialKeys } from '../../src/core/security/credential-store.js';
import type { RuntimeContext } from '../../src/core/context.js';
import type { BackupJobSummary } from '../../src/core/types.js';
import { createManualRemote } from '../../src/core/providers/generic-git.js';

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const SECRET = 'hqhb_test_secret';
let drive: MockDriveServer;
let remote: FakeRemote;
let ctx: RuntimeContext;
let hq: Server;
let received: Received[];
let hqStatus = 200;

beforeEach(async () => {
  received = [];
  hqStatus = 200;
  hq = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body });
      res.writeHead(hqStatus, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => hq.listen(0, '127.0.0.1', r));
  drive = await startDrive();
  remote = new FakeRemote();
  ({ ctx } = makeContext(drive));
  const m = createManualRemote({ url: remote.bare, name: 'repo', owner: 'test', provider: 'custom' });
  ctx.configStore.update((c) => {
    c.manual_remotes.push(m);
    c.hq = { url: `http://127.0.0.1:${(hq.address() as AddressInfo).port}`, project_key: 'cloudrepo' };
  });
  ctx.reloadConfig();
  ctx.cfg.upload.chunk_size_mb = 0.25;
});
afterEach(async () => {
  ctx.close();
  remote.destroy();
  await drive.stop();
  await new Promise((r) => hq.close(r));
});

function summary(over: Partial<BackupJobSummary>): BackupJobSummary {
  return {
    job_id: 'job-1',
    trigger: 'schedule',
    started_at: '2026-11-22T18:00:00.000Z',
    completed_at: '2026-11-22T18:05:00.000Z',
    status: 'completed',
    repository_count: 2,
    success_count: 1,
    unchanged_count: 1,
    failed_count: 0,
    pending_count: 0,
    results: [
      { repository_id: 'a', outcome: 'created', bytes_uploaded: 100 },
      { repository_id: 'b', outcome: 'unchanged' },
    ],
    ...over,
  };
}

describe('AutoMateHQ Heartbeat 보고', () => {
  it('키가 있으면 start → complete를 서명해 보내고, 서명이 HQ 계약과 맞는다', async () => {
    await ctx.creds.set(CredentialKeys.hqHeartbeatSecret, SECRET);
    remote.commit('a.txt', 'x');
    remote.push();
    const s = await runBackupAgent(ctx, { trigger: 'manual' });
    expect(s.status).toBe('completed');
    expect(received.map((r) => r.path)).toEqual(['/api/v1/heartbeat/start', '/api/v1/heartbeat/complete']);
    for (const r of received) {
      const ts = Number(r.headers['x-hq-timestamp']);
      expect(r.headers['x-hq-project']).toBe('cloudrepo');
      expect(r.headers['x-hq-signature']).toBe(signHeartbeat(SECRET, r.body, ts));
      expect(r.body).not.toContain(SECRET);
    }
    const done = JSON.parse(received[1]!.body);
    expect(done).toMatchObject({ projectKey: 'cloudrepo', runId: s.job_id, source: 'repovault', metrics: { created: 1, failed: 0 } });
  });

  it('키가 없으면 보고하지 않고 백업은 그대로 성공한다', async () => {
    remote.commit('a.txt', 'x');
    remote.push();
    const s = await runBackupAgent(ctx, { trigger: 'manual' });
    expect(s.status).toBe('completed');
    expect(received).toEqual([]);
  });

  it('HQ가 오류를 돌려줘도 백업 결과는 바뀌지 않는다', async () => {
    await ctx.creds.set(CredentialKeys.hqHeartbeatSecret, SECRET);
    hqStatus = 500;
    remote.commit('a.txt', 'x');
    remote.push();
    const s = await runBackupAgent(ctx, { trigger: 'manual' });
    expect(s.status).toBe('completed');
    expect(received).toHaveLength(2);
  });

  it('요약 → 보고 종류 판정', () => {
    expect(buildFinalHeartbeat(summary({}))!.kind).toBe('complete');
    expect(buildFinalHeartbeat(summary({ status: 'skipped' }))).toBeNull();
    const failed = buildFinalHeartbeat(summary({ status: 'failed', message: 'Google 재인증이 필요합니다' }))!;
    expect(failed.kind).toBe('fail');
    expect(failed.payload.errorCode).toBe('DRIVE_REAUTH');
    const partial = buildFinalHeartbeat(
      summary({ status: 'completed_with_errors', results: [{ repository_id: 'a', outcome: 'created' }, { repository_id: 'c', outcome: 'pending_upload', message: '업로드 미완료' }] }),
    )!;
    expect(partial.kind).toBe('fail');
    expect(partial.payload.errorCode).toBe('UPLOAD_PENDING');
    // 원격에서 지운 저장소는 실패로 보지 않는다
    const missing = buildFinalHeartbeat(
      summary({ status: 'completed_with_errors', results: [{ repository_id: 'a', outcome: 'unchanged' }, { repository_id: 'gone', outcome: 'remote_unavailable', message: '원격 목록에서 사라짐 — Drive 백업 유지' }] }),
    )!;
    expect(missing.kind).toBe('complete');
    expect((missing.payload.message as string).length).toBeLessThanOrEqual(500);
  });
});
