import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDrive, tmp } from '../helpers/env.js';
import type { MockDriveServer } from '../helpers/mock-drive.js';
import { GoogleDriveClient, DriveApiError } from '../../src/core/cloud/drive-client.js';
import { ResumableUploadManager, IntegrityError } from '../../src/core/cloud/upload-manager.js';
import { MemoryCredentialStore } from '../../src/core/security/credential-store.js';
import { StaticTokenProvider } from '../../src/core/cloud/oauth.js';
import { sha256Buffer } from '../../src/core/utils/misc.js';

let drive: MockDriveServer;
let client: GoogleDriveClient;
let creds: MemoryCredentialStore;
let up: ResumableUploadManager;
let parent: string;
let tokens: StaticTokenProvider;

const CHUNK = 256 * 1024;

function file(size: number) {
  const data = randomBytes(size);
  const p = join(tmp(), 'blob.bin');
  writeFileSync(p, data);
  return { p, data, sha: sha256Buffer(data) };
}
const spec = (f: ReturnType<typeof file>, key = 'k1') => ({ localPath: f.p, name: 'repository.bundle', parentId: parent, mimeType: 'application/octet-stream', sha256: f.sha, sessionKey: key });
const isChunk = (req: { method?: string; headers: Record<string, unknown> }) => req.method === 'PUT' && /^bytes \d+-/.test(String(req.headers['content-range'] ?? ''));

beforeEach(async () => {
  drive = await startDrive();
  tokens = new StaticTokenProvider(drive.token);
  client = new GoogleDriveClient(tokens, { endpoints: drive.endpoints, retryBaseMs: 1 });
  creds = new MemoryCredentialStore();
  up = new ResumableUploadManager(client, creds);
  parent = (await client.createFolder('snap', null)).id;
});
afterEach(async () => drive.stop());

describe('Resumable Upload', () => {
  it('여러 청크로 업로드하고 SHA-256(sha256Checksum)으로 검증', async () => {
    const f = file(CHUNK * 3 + 1234);
    const r = await up.upload(spec(f), { chunkSize: CHUNK, retryBaseMs: 1 });
    expect(r.verifiedBy).toBe('sha256Checksum');
    expect(drive.files.get(r.fileId)!.content!.equals(f.data)).toBe(true);
    expect(drive.requests.filter((x) => x.path.startsWith('/upload/session/')).length).toBeGreaterThanOrEqual(4);
  });

  it('청크 전송 중 응답 유실(5xx) → 서버 상태 조회 후 이어서 전송', async () => {
    const f = file(CHUNK * 4);
    drive.fail(503, (req) => isChunk(req as never), 2, true);
    const r = await up.upload(spec(f), { chunkSize: CHUNK, retryBaseMs: 1 });
    expect(drive.files.get(r.fileId)!.content!.equals(f.data)).toBe(true);
  });

  it('세션 만료 → 새 세션으로 재업로드', async () => {
    const f = file(CHUNK * 3);
    let n = 0;
    drive.fail(503, (req) => {
      if (isChunk(req as never) && ++n === 2) {
        drive.expireAllSessions();
        return true;
      }
      return false;
    }, 1);
    const r = await up.upload(spec(f), { chunkSize: CHUNK, retryBaseMs: 1 });
    expect(drive.files.get(r.fileId)!.content!.equals(f.data)).toBe(true);
  });

  it('앱 재시작 후 저장된 세션으로 재개', async () => {
    const f = file(CHUNK * 3);
    // 첫 실행: 2번째 청크부터 계속 실패 → 재시도 한도 초과로 중단
    let n = 0;
    drive.fail(500, (req) => isChunk(req as never) && ++n >= 2, 100);
    await expect(up.upload(spec(f, 'resume'), { chunkSize: CHUNK, maxAttempts: 2, retryBaseMs: 1 })).rejects.toBeInstanceOf(DriveApiError);
    expect(await creds.get('upload-session:resume')).toBeTruthy();
    // 재시작: 장애 해소
    drive['faults'] = [];
    const up2 = new ResumableUploadManager(client, creds);
    const r = await up2.upload(spec(f, 'resume'), { chunkSize: CHUNK, retryBaseMs: 1 });
    expect(drive.files.get(r.fileId)!.content!.equals(f.data)).toBe(true);
    expect(await creds.get('upload-session:resume')).toBeNull();
    expect(drive.byName('repository.bundle')).toHaveLength(1);
  });

  it('동일 파일 중복 업로드 방지 (응답 유실 후 재실행 시 기존 파일 재사용)', async () => {
    const f = file(1000);
    const a = await up.upload(spec(f, 'a'));
    const b = await up.upload(spec(f, 'b'));
    expect(b.reused).toBe(true);
    expect(b.fileId).toBe(a.fileId);
    expect(drive.byName('repository.bundle')).toHaveLength(1);
  });

  it('원격 SHA-256 불일치 탐지', async () => {
    const f = file(5000);
    drive.corruptNextUpload = true;
    await expect(up.upload(spec(f))).rejects.toBeInstanceOf(IntegrityError);
  });

  it('sha256Checksum 미제공 시 다시 내려받아 검증', async () => {
    drive.omitSha256 = true;
    const f = file(4000);
    const r = await up.upload(spec(f));
    expect(r.verifiedBy).toBe('download');
  });

  it('스테이징 파일 손상 시 업로드 거부', async () => {
    const f = file(100);
    await expect(up.upload({ ...spec(f), sha256: '0'.repeat(64) })).rejects.toBeInstanceOf(IntegrityError);
  });

  it('401 → 토큰 갱신 후 재시도, 429/5xx 지수 백오프', async () => {
    drive.fail(429, (_req, url) => url.pathname === '/drive/v3/about', 2);
    const a = await client.about();
    expect(a.user?.emailAddress).toBe('tester@example.com');
    drive.token = 'rotated';
    let calls = 0;
    const rotating = new GoogleDriveClient(
      {
        async getAccessToken(force) {
          calls++;
          return force ? 'rotated' : 'stale';
        },
      },
      { endpoints: drive.endpoints, retryBaseMs: 1 },
    );
    await rotating.about();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('용량 부족은 재시도하지 않고 즉시 오류', async () => {
    drive.quotaLimit = 10;
    const f = file(1000);
    await expect(up.upload(spec(f))).rejects.toSatisfy((e: unknown) => e instanceof DriveApiError && e.isQuota);
  });
});
