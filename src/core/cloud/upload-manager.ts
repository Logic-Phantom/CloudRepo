import { openSync, readSync, closeSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DriveApiError, DriveNetworkError, escapeQuery, type DriveFile, type GoogleDriveClient } from './drive-client.js';
import type { CredentialStore } from '../security/credential-store.js';
import { CredentialKeys } from '../security/credential-store.js';
import { backoffDelay, sha256File, sleep } from '../utils/misc.js';

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}

export interface UploadSpec {
  localPath: string;
  name: string;
  parentId: string;
  mimeType: string;
  sha256: string;
  /** 업로드 세션 재개용 키 (pending upload id) */
  sessionKey: string;
  appProperties?: Record<string, string>;
}

export interface VerifiedUpload {
  file: DriveFile;
  fileId: string;
  size: number;
  sha256: string;
  verifiedBy: 'sha256Checksum' | 'download';
  reused: boolean;
}

export interface UploadOptions {
  chunkSize?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  onProgress?: (sent: number, total: number) => void;
}

const MIN_CHUNK = 256 * 1024;

/**
 * 원격 파일 검증: 크기 일치 + sha256Checksum 비교. 원격 SHA-256 필드가 없으면 다시 내려받아 해시를 계산한다.
 */
export async function verifyRemoteFile(
  drive: GoogleDriveClient,
  fileId: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<{ file: DriveFile; verifiedBy: 'sha256Checksum' | 'download' }> {
  const file = await drive.getFile(fileId);
  if (file.trashed) throw new IntegrityError(`업로드된 파일이 휴지통에 있습니다: ${file.name}`);
  const size = Number(file.size ?? -1);
  if (size !== expectedSize) throw new IntegrityError(`파일 크기 불일치: ${file.name} (로컬 ${expectedSize}, Drive ${size})`);
  if (file.sha256Checksum) {
    if (file.sha256Checksum.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new IntegrityError(`SHA-256 불일치: ${file.name}`);
    }
    return { file, verifiedBy: 'sha256Checksum' };
  }
  const dir = mkdtempSync(join(tmpdir(), 'rv-verify-'));
  try {
    const p = join(dir, 'blob');
    await drive.downloadToFile(fileId, p);
    const h = await sha256File(p);
    if (h !== expectedSha256) throw new IntegrityError(`다운로드 검증 SHA-256 불일치: ${file.name}`);
    return { file, verifiedBy: 'download' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Drive Resumable Upload + 무결성 검증.
 * - 동일 폴더에 동일 SHA-256 파일이 이미 있으면 재사용 (응답 유실 대비 및 중복 업로드 방지)
 * - 세션 URI는 OS Credential Store에 보관하고 로그에 남기지 않는다
 * - 세션 만료(404/410) 시 새 세션으로 처음부터 다시 업로드
 * - 5xx/네트워크 오류 시 서버에 업로드 상태를 조회한 뒤 이어서 전송
 */
export class ResumableUploadManager {
  constructor(
    private readonly drive: GoogleDriveClient,
    private readonly creds: CredentialStore,
  ) {}

  async findExisting(spec: UploadSpec): Promise<DriveFile | null> {
    const q =
      `name = '${escapeQuery(spec.name)}' and '${escapeQuery(spec.parentId)}' in parents and trashed = false ` +
      `and appProperties has { key='rv_sha256' and value='${spec.sha256}' }`;
    const files = await this.drive.listFiles(q);
    return files[0] ?? null;
  }

  async upload(spec: UploadSpec, opts: UploadOptions = {}): Promise<VerifiedUpload> {
    const size = statSync(spec.localPath).size;
    const local = await sha256File(spec.localPath);
    if (local !== spec.sha256) throw new IntegrityError(`스테이징 파일이 손상되었습니다: ${spec.name}`);

    // 1) 중복 방지 / 응답 유실 복구
    const existing = await this.findExisting(spec);
    if (existing) {
      try {
        const v = await verifyRemoteFile(this.drive, existing.id, size, spec.sha256);
        await this.clearSession(spec.sessionKey);
        return { file: v.file, fileId: existing.id, size, sha256: spec.sha256, verifiedBy: v.verifiedBy, reused: true };
      } catch (e) {
        if (!(e instanceof IntegrityError)) throw e;
        // 손상된 기존 업로드는 재사용하지 않고 새로 올린다 (삭제하지 않음)
      }
    }

    const chunkSize = Math.max(MIN_CHUNK, Math.floor((opts.chunkSize ?? 8 * 1024 * 1024) / MIN_CHUNK) * MIN_CHUNK);
    const maxAttempts = opts.maxAttempts ?? 8;
    const sessionKeyName = CredentialKeys.uploadSession(spec.sessionKey);
    const meta = {
      name: spec.name,
      parents: [spec.parentId],
      mimeType: spec.mimeType,
      appProperties: { ...(spec.appProperties ?? {}), rv_sha256: spec.sha256, rv_size: String(size) },
    };

    let session = await this.creds.get(sessionKeyName);
    let offset = 0;
    let failures = 0;
    let done: DriveFile | null = null;

    const newSession = async () => {
      session = await this.drive.startResumableSession(meta, size);
      await this.creds.set(sessionKeyName, session);
      offset = 0;
    };

    if (session) {
      try {
        const st = await this.drive.queryResumable(session, size);
        if (st.done) done = st.file;
        else offset = st.offset;
      } catch (e) {
        if (e instanceof DriveApiError && (e.status === 404 || e.status === 410 || (e.status >= 400 && e.status < 500))) await newSession();
        else throw e;
      }
    } else {
      await newSession();
    }

    const fd = openSync(spec.localPath, 'r');
    try {
      while (!done) {
        const len = Math.min(chunkSize, size - offset);
        const buf = Buffer.alloc(Math.max(0, len));
        if (len > 0) readSync(fd, buf, 0, len, offset);
        try {
          // 빈 파일은 'bytes */0' 으로 완료 처리
          const st = size === 0 ? await this.drive.queryResumable(session!, 0) : await this.drive.putChunk(session!, buf, offset, size);
          if (st.done) done = st.file;
          else {
            offset = st.offset;
            failures = 0;
          }
          opts.onProgress?.(st.done ? size : offset, size);
        } catch (e) {
          failures++;
          if (failures > maxAttempts) throw e;
          if (e instanceof DriveApiError && (e.status === 404 || e.status === 410)) {
            // 세션 만료 → 새 세션
            await newSession();
            continue;
          }
          if (e instanceof DriveApiError && e.isQuota) throw e;
          if (e instanceof DriveApiError && !e.isRetryable && e.status !== 400) throw e;
          if (!(e instanceof DriveApiError) && !(e instanceof DriveNetworkError) && !(e instanceof TypeError)) throw e;
          await sleep(e instanceof DriveApiError && e.retryAfterMs ? e.retryAfterMs : backoffDelay(failures, opts.retryBaseMs ?? 1000, 30_000));
          // 서버에 실제로 받은 범위를 조회해 이어서 전송
          try {
            const st = await this.drive.queryResumable(session!, size);
            if (st.done) done = st.file;
            else offset = st.offset;
          } catch (qe) {
            if (qe instanceof DriveApiError && (qe.status === 404 || qe.status === 410)) await newSession();
            else if (failures >= maxAttempts) throw qe;
          }
        }
      }
    } finally {
      closeSync(fd);
    }

    await this.clearSession(spec.sessionKey);
    const v = await verifyRemoteFile(this.drive, done.id, size, spec.sha256);
    return { file: v.file, fileId: done.id, size, sha256: spec.sha256, verifiedBy: v.verifiedBy, reused: false };
  }

  async clearSession(sessionKey: string) {
    await this.creds.delete(CredentialKeys.uploadSession(sessionKey)).catch(() => undefined);
  }
}
