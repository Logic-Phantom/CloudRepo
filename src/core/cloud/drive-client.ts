import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { backoffDelay, sleep } from '../utils/misc.js';
import { sanitizeText } from '../utils/sanitize.js';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
  size?: string;
  sha256Checksum?: string;
  md5Checksum?: string;
  createdTime?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
  trashed?: boolean;
  webViewLink?: string;
}

export interface DriveAbout {
  user?: { emailAddress?: string; displayName?: string };
  storageQuota?: { limit?: string; usage?: string; usageInDrive?: string; usageInDriveTrash?: string };
}

export interface DriveEndpoints {
  apiBase: string;
  uploadBase: string;
}

export const GOOGLE_DRIVE_ENDPOINTS: DriveEndpoints = {
  apiBase: 'https://www.googleapis.com/drive/v3',
  uploadBase: 'https://www.googleapis.com/upload/drive/v3',
};

export interface TokenProvider {
  getAccessToken(forceRefresh?: boolean): Promise<string>;
}

export const FILE_FIELDS = 'id,name,mimeType,parents,size,sha256Checksum,md5Checksum,createdTime,modifiedTime,appProperties,trashed,webViewLink';

export class DriveApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(sanitizeText(message));
    this.name = 'DriveApiError';
  }
  get isQuota() {
    return this.status === 403 && /storageQuotaExceeded|quotaExceeded/i.test(this.reason) && !/rateLimit/i.test(this.reason);
  }
  get isRateLimit() {
    return this.status === 429 || (this.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(this.reason));
  }
  get isRetryable() {
    return this.isRateLimit || this.status >= 500 || this.status === 0;
  }
}

export class DriveNetworkError extends Error {
  constructor(message: string) {
    super(sanitizeText(message));
    this.name = 'DriveNetworkError';
  }
}

export function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export type ResumableStatus = { done: true; file: DriveFile } | { done: false; offset: number };

export interface DriveClientOptions {
  endpoints?: DriveEndpoints;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  retryBaseMs?: number;
}

/**
 * Google Drive API v3 클라이언트.
 * - 401: Access Token 강제 갱신 후 1회 재시도
 * - 429/403 rateLimit/5xx/네트워크: 지수 백오프(Retry-After 존중)
 * - 그 외 4xx: 즉시 오류 (무한 재시도 금지)
 */
export class GoogleDriveClient {
  readonly endpoints: DriveEndpoints;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBaseMs: number;

  constructor(
    private readonly tokens: TokenProvider,
    opts: DriveClientOptions = {},
  ) {
    this.endpoints = opts.endpoints ?? GOOGLE_DRIVE_ENDPOINTS;
    this.maxRetries = opts.maxRetries ?? 6;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryBaseMs = opts.retryBaseMs ?? 1000;
  }

  private async parseError(res: Response): Promise<DriveApiError> {
    let reason = '';
    let message = `Drive API 오류 ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string; errors?: Array<{ reason?: string }>; status?: string } };
      reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? '';
      if (body.error?.message) message = `Drive API 오류 ${res.status}: ${body.error.message}`;
    } catch {
      /* ignore */
    }
    const ra = res.headers.get('retry-after');
    const retryAfterMs = ra ? (Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now())) : undefined;
    return new DriveApiError(res.status, reason, message, retryAfterMs);
  }

  /** 인증/재시도가 적용된 기본 요청. 2xx 및 accept에 포함된 상태 코드면 Response 반환 */
  async request(
    method: string,
    url: string,
    init: { body?: Buffer | string; headers?: Record<string, string>; accept?: number[]; noRetry?: boolean } = {},
  ): Promise<Response> {
    let refreshed = false;
    let refreshedToken: string | null = null;
    for (let attempt = 0; ; attempt++) {
      const token = refreshedToken ?? (await this.tokens.getAccessToken(false));
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          body: init.body,
          headers: { Authorization: `Bearer ${token}`, ...init.headers },
        });
      } catch (e) {
        if (init.noRetry || attempt >= this.maxRetries) throw new DriveNetworkError(`Drive 네트워크 오류: ${(e as Error).message}`);
        await sleep(backoffDelay(attempt, this.retryBaseMs));
        continue;
      }
      if (res.ok || init.accept?.includes(res.status)) return res;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await res.body?.cancel().catch(() => undefined);
        refreshedToken = await this.tokens.getAccessToken(true);
        continue;
      }
      const err = await this.parseError(res);
      if (err.isRetryable && !init.noRetry && attempt < this.maxRetries) {
        await sleep(err.retryAfterMs ?? backoffDelay(attempt, this.retryBaseMs));
        continue;
      }
      throw err;
    }
  }

  private url(path: string, params: Record<string, string | undefined> = {}, upload = false): string {
    const u = new URL((upload ? this.endpoints.uploadBase : this.endpoints.apiBase) + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  }

  async about(fields = 'user(emailAddress,displayName),storageQuota'): Promise<DriveAbout> {
    const res = await this.request('GET', this.url('/about', { fields }));
    return (await res.json()) as DriveAbout;
  }

  async listFiles(q: string, fields = FILE_FIELDS, orderBy = 'createdTime'): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.request(
        'GET',
        this.url('/files', {
          q,
          fields: `nextPageToken,files(${fields})`,
          pageSize: '1000',
          orderBy,
          spaces: 'drive',
          pageToken,
        }),
      );
      const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      out.push(...(body.files ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }

  async getFile(id: string, fields = FILE_FIELDS): Promise<DriveFile> {
    const res = await this.request('GET', this.url(`/files/${encodeURIComponent(id)}`, { fields }));
    return (await res.json()) as DriveFile;
  }

  async createFolder(name: string, parentId: string | null, appProperties: Record<string, string> = {}): Promise<DriveFile> {
    const res = await this.request('POST', this.url('/files', { fields: FILE_FIELDS }), {
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined, appProperties }),
    });
    return (await res.json()) as DriveFile;
  }

  /** 작은 파일(JSON 등) multipart 업로드 */
  async createSmallFile(
    name: string,
    parentId: string,
    content: Buffer | string,
    mimeType: string,
    appProperties: Record<string, string> = {},
  ): Promise<DriveFile> {
    const boundary = `rv${Math.random().toString(16).slice(2)}${Date.now()}`;
    const meta = JSON.stringify({ name, parents: [parentId], mimeType, appProperties });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      Buffer.isBuffer(content) ? content : Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await this.request('POST', this.url('/files', { uploadType: 'multipart', fields: FILE_FIELDS }, true), {
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return (await res.json()) as DriveFile;
  }

  /** 기존 파일 내용 교체 (인덱스 파일 등 가변 메타데이터 전용. 스냅샷 파일에는 사용하지 않는다) */
  async updateFileContent(id: string, content: Buffer | string, mimeType: string): Promise<DriveFile> {
    const res = await this.request('PATCH', this.url(`/files/${encodeURIComponent(id)}`, { uploadType: 'media', fields: FILE_FIELDS }, true), {
      headers: { 'Content-Type': mimeType },
      body: Buffer.isBuffer(content) ? content : Buffer.from(content),
    });
    return (await res.json()) as DriveFile;
  }

  async updateMetadata(id: string, patch: Partial<Pick<DriveFile, 'appProperties' | 'name'>>): Promise<DriveFile> {
    const res = await this.request('PATCH', this.url(`/files/${encodeURIComponent(id)}`, { fields: FILE_FIELDS }), {
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(patch),
    });
    return (await res.json()) as DriveFile;
  }

  async downloadBuffer(id: string): Promise<Buffer> {
    const res = await this.request('GET', this.url(`/files/${encodeURIComponent(id)}`, { alt: 'media' }));
    return Buffer.from(await res.arrayBuffer());
  }

  async downloadToFile(id: string, dest: string): Promise<void> {
    const res = await this.request('GET', this.url(`/files/${encodeURIComponent(id)}`, { alt: 'media' }));
    if (!res.body) throw new DriveNetworkError('다운로드 본문이 비어 있습니다.');
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
  }

  // ---------------- Resumable Upload ----------------

  async startResumableSession(
    meta: { name: string; parents: string[]; mimeType: string; appProperties?: Record<string, string> },
    size: number,
  ): Promise<string> {
    const res = await this.request('POST', this.url('/files', { uploadType: 'resumable', fields: FILE_FIELDS }, true), {
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': meta.mimeType,
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify(meta),
    });
    const loc = res.headers.get('location');
    if (!loc) throw new DriveApiError(res.status, 'noLocation', 'Resumable 세션 URI를 받지 못했습니다.');
    return loc;
  }

  private parseResumable(res: Response): Promise<ResumableStatus> | ResumableStatus {
    if (res.status === 200 || res.status === 201) {
      return res.json().then((file) => ({ done: true as const, file: file as DriveFile }));
    }
    // 308 Resume Incomplete
    const range = res.headers.get('range');
    const offset = range ? Number(/bytes=0-(\d+)/.exec(range)?.[1] ?? -1) + 1 : 0;
    return { done: false, offset };
  }

  /** 세션 상태 조회. 세션이 만료되면 DriveApiError(404/410) */
  async queryResumable(sessionUri: string, total: number): Promise<ResumableStatus> {
    const res = await this.request('PUT', sessionUri, {
      headers: { 'Content-Range': `bytes */${total}`, 'Content-Length': '0' },
      accept: [308],
      noRetry: true,
    });
    return this.parseResumable(res);
  }

  /** 청크 하나 전송. 재시도/재개 판단은 UploadManager가 한다 */
  async putChunk(sessionUri: string, chunk: Buffer, start: number, total: number): Promise<ResumableStatus> {
    const end = start + chunk.length - 1;
    const res = await this.request('PUT', sessionUri, {
      headers: { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(chunk.length) },
      body: chunk,
      accept: [308],
      noRetry: true,
    });
    return this.parseResumable(res);
  }
}
