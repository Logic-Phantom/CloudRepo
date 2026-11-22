import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const FOLDER = 'application/vnd.google-apps.folder';

export interface MockFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  content: Buffer | null;
  createdTime: string;
  modifiedTime: string;
  trashed: boolean;
}

interface Session {
  meta: { name: string; parents: string[]; mimeType: string; appProperties?: Record<string, string> };
  total: number;
  received: Buffer[];
  receivedLen: number;
  done: MockFile | null;
}

type Fault = { status: number; match: (req: IncomingMessage, url: URL) => boolean; remaining: number; acceptBody?: boolean };

/**
 * Google Drive API v3 의 필요한 부분만 구현한 테스트용 HTTP 서버.
 * files.list(q 파서), files.get(alt=media), files.create(folder/multipart/resumable), files.update(media), about.get
 * 장애 주입: 상태코드 실패, 청크 수신 후 응답 유실, 세션 만료, SHA-256 필드 미제공, 업로드 내용 손상, 용량 제한, 401
 */
export class MockDriveServer {
  readonly files = new Map<string, MockFile>();
  readonly sessions = new Map<string, Session>();
  readonly requests: Array<{ method: string; path: string }> = [];
  private server: Server | null = null;
  base = '';
  token = 'test-token';
  omitSha256 = false;
  quotaLimit: number | null = 15 * 1024 ** 3;
  email = 'tester@example.com';
  pageSize = 1000;
  corruptNextUpload = false;
  private faults: Fault[] = [];
  private clock = 0;

  get endpoints() {
    return { apiBase: `${this.base}/drive/v3`, uploadBase: `${this.base}/upload/drive/v3` };
  }

  async start() {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: String(e) } }));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  async stop() {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  /** 다음 n개의 일치 요청을 status 로 실패시킨다. acceptBody=true면 본문(청크)은 반영 후 실패 응답(응답 유실 시뮬레이션) */
  fail(status: number, match: (req: IncomingMessage, url: URL) => boolean, count = 1, acceptBody = false) {
    this.faults.push({ status, match, remaining: count, acceptBody });
  }

  expireAllSessions() {
    this.sessions.clear();
  }

  usage(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.content?.length ?? 0;
    return n;
  }

  byName(name: string): MockFile[] {
    return [...this.files.values()].filter((f) => f.name === name && !f.trashed);
  }

  private now() {
    this.clock++;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, this.clock)).toISOString();
  }

  private sha(f: MockFile) {
    return f.content ? createHash('sha256').update(f.content).digest('hex') : undefined;
  }

  private view(f: MockFile) {
    const isFolder = f.mimeType === FOLDER;
    return {
      kind: 'drive#file',
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents,
      appProperties: f.appProperties,
      trashed: f.trashed,
      createdTime: f.createdTime,
      modifiedTime: f.modifiedTime,
      webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
      ...(isFolder
        ? {}
        : {
            size: String(f.content?.length ?? 0),
            md5Checksum: f.content ? createHash('md5').update(f.content).digest('hex') : undefined,
            ...(this.omitSha256 ? {} : { sha256Checksum: this.sha(f) }),
          }),
    };
  }

  private create(meta: Session['meta'], content: Buffer | null): MockFile {
    let body = content;
    if (body && this.corruptNextUpload) {
      body = Buffer.from(body);
      if (body.length) body[0] = body[0]! ^ 0xff;
      this.corruptNextUpload = false;
    }
    const t = this.now();
    const f: MockFile = {
      id: `f_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      name: meta.name,
      mimeType: meta.mimeType ?? 'application/octet-stream',
      parents: meta.parents?.length ? meta.parents : ['root'],
      appProperties: meta.appProperties ?? {},
      content: meta.mimeType === FOLDER ? null : (body ?? Buffer.alloc(0)),
      createdTime: t,
      modifiedTime: t,
      trashed: false,
    };
    this.files.set(f.id, f);
    return f;
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
  }

  private err(res: ServerResponse, status: number, reason: string, message = reason) {
    this.json(res, status, { error: { code: status, message, errors: [{ reason, message }] } });
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  // ---------------- q parser ----------------
  private splitAnd(q: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inQ = false;
    let cur = '';
    for (let i = 0; i < q.length; i++) {
      const c = q[i]!;
      if (c === '\\' && inQ) {
        cur += c + q[i + 1];
        i++;
        continue;
      }
      if (c === "'") inQ = !inQ;
      if (!inQ && c === '{') depth++;
      if (!inQ && c === '}') depth--;
      if (!inQ && depth === 0 && q.slice(i, i + 5) === ' and ') {
        parts.push(cur.trim());
        cur = '';
        i += 4;
        continue;
      }
      cur += c;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  private unq(s: string): string {
    return s.replace(/^'/, '').replace(/'$/, '').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }

  private matches(f: MockFile, q: string): boolean {
    for (const clause of this.splitAnd(q)) {
      let m: RegExpExecArray | null;
      if ((m = /^name = ('(?:[^'\\]|\\.)*')$/.exec(clause))) {
        if (f.name !== this.unq(m[1]!)) return false;
      } else if ((m = /^('(?:[^'\\]|\\.)*') in parents$/.exec(clause))) {
        if (!f.parents.includes(this.unq(m[1]!))) return false;
      } else if ((m = /^mimeType (=|!=) ('(?:[^'\\]|\\.)*')$/.exec(clause))) {
        const eq = f.mimeType === this.unq(m[2]!);
        if (m[1] === '=' ? !eq : eq) return false;
      } else if ((m = /^trashed = (true|false)$/.exec(clause))) {
        if (f.trashed !== (m[1] === 'true')) return false;
      } else if ((m = /^appProperties has \{ key='([^']*)' and value='([^']*)' \}$/.exec(clause))) {
        if (f.appProperties[m[1]!] !== m[2]) return false;
      } else {
        throw new Error(`unsupported q clause: ${clause}`);
      }
    }
    return true;
  }

  // ---------------- handler ----------------
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.base);
    this.requests.push({ method: req.method ?? '', path: url.pathname });
    if (req.headers.authorization !== `Bearer ${this.token}`) return this.err(res, 401, 'authError', 'Invalid Credentials');

    const fault = this.faults.find((f) => f.remaining > 0 && f.match(req, url));
    if (fault) {
      fault.remaining--;
      if (!fault.acceptBody) {
        await this.body(req);
        return this.err(res, fault.status, fault.status === 403 ? 'rateLimitExceeded' : fault.status === 429 ? 'rateLimitExceeded' : 'backendError');
      }
    }

    // resumable session PUT
    const sm = /^\/upload\/session\/([\w-]+)$/.exec(url.pathname);
    if (sm && req.method === 'PUT') {
      const s = this.sessions.get(sm[1]!);
      const body = await this.body(req);
      if (!s) return this.err(res, 404, 'notFound', 'Upload session expired');
      const range = String(req.headers['content-range'] ?? '');
      const status = /^bytes \*\/(\d+)$/.exec(range);
      const chunk = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      if (s.done) return this.json(res, 200, this.view(s.done));
      if (chunk) {
        const start = Number(chunk[1]);
        if (start === s.receivedLen) {
          s.received.push(body);
          s.receivedLen += body.length;
        }
      } else if (!status) return this.err(res, 400, 'badRange');
      if (s.receivedLen >= s.total) {
        s.done = this.create(s.meta, Buffer.concat(s.received));
        if (fault?.acceptBody) return this.err(res, fault.status, 'backendError');
        return this.json(res, 200, this.view(s.done));
      }
      if (fault?.acceptBody) return this.err(res, fault.status, 'backendError');
      res.writeHead(308, s.receivedLen > 0 ? { Range: `bytes=0-${s.receivedLen - 1}` } : {}).end();
      return;
    }

    if (url.pathname === '/drive/v3/about' && req.method === 'GET') {
      return this.json(res, 200, {
        user: { emailAddress: this.email, displayName: 'Tester' },
        storageQuota: {
          ...(this.quotaLimit !== null ? { limit: String(this.quotaLimit) } : {}),
          usage: String(this.usage()),
          usageInDrive: String(this.usage()),
          usageInDriveTrash: '0',
        },
      });
    }

    if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const all = [...this.files.values()].filter((f) => this.matches(f, q)).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = all.slice(start, start + this.pageSize);
      const next = start + this.pageSize < all.length ? String(start + this.pageSize) : undefined;
      return this.json(res, 200, { files: page.map((f) => this.view(f)), ...(next ? { nextPageToken: next } : {}) });
    }

    if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
      const meta = JSON.parse((await this.body(req)).toString('utf8'));
      if (meta.mimeType !== FOLDER) return this.err(res, 400, 'badRequest');
      return this.json(res, 200, this.view(this.create(meta, null)));
    }

    const fm = /^\/drive\/v3\/files\/([\w-]+)$/.exec(url.pathname);
    if (fm) {
      const f = this.files.get(fm[1]!);
      if (!f) return this.err(res, 404, 'notFound', 'File not found');
      if (req.method === 'GET') {
        if (url.searchParams.get('alt') === 'media') {
          res.writeHead(200, { 'Content-Type': f.mimeType }).end(f.content ?? Buffer.alloc(0));
          return;
        }
        return this.json(res, 200, this.view(f));
      }
      if (req.method === 'PATCH') {
        const meta = JSON.parse((await this.body(req)).toString('utf8') || '{}');
        if (meta.name) f.name = meta.name;
        if (meta.appProperties) f.appProperties = { ...f.appProperties, ...meta.appProperties };
        if (meta.trashed !== undefined) f.trashed = meta.trashed;
        f.modifiedTime = this.now();
        return this.json(res, 200, this.view(f));
      }
    }

    if (url.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
      const type = url.searchParams.get('uploadType');
      const raw = await this.body(req);
      if (type === 'multipart') {
        const boundary = /boundary=([^;]+)/.exec(String(req.headers['content-type']))?.[1];
        const text = raw.toString('latin1');
        const parts = text.split(`--${boundary}`).filter((p) => p.trim() && p.trim() !== '--');
        const metaPart = parts[0]!.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
        const mediaPart = parts[1]!;
        const mediaStart = mediaPart.indexOf('\r\n\r\n') + 4;
        const media = Buffer.from(mediaPart.slice(mediaStart).replace(/\r\n$/, ''), 'latin1');
        const meta = JSON.parse(Buffer.from(metaPart, 'latin1').toString('utf8'));
        return this.json(res, 200, this.view(this.create(meta, media)));
      }
      if (type === 'resumable') {
        const meta = JSON.parse(raw.toString('utf8'));
        const total = Number(req.headers['x-upload-content-length'] ?? 0);
        if (this.quotaLimit !== null && this.usage() + total > this.quotaLimit) return this.err(res, 403, 'storageQuotaExceeded', 'The user has exceeded their Drive storage quota');
        const sid = randomUUID();
        this.sessions.set(sid, { meta, total, received: [], receivedLen: 0, done: null });
        res.writeHead(200, { Location: `${this.base}/upload/session/${sid}` }).end();
        return;
      }
    }

    const um = /^\/upload\/drive\/v3\/files\/([\w-]+)$/.exec(url.pathname);
    if (um && req.method === 'PATCH') {
      const f = this.files.get(um[1]!);
      if (!f) return this.err(res, 404, 'notFound');
      f.content = await this.body(req);
      f.modifiedTime = this.now();
      return this.json(res, 200, this.view(f));
    }

    return this.err(res, 404, 'notFound', `unhandled ${req.method} ${url.pathname}`);
  }
}
