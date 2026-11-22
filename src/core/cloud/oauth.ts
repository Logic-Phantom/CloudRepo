import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { run } from '../utils/exec.js';
import { sanitizeText } from '../utils/sanitize.js';
import { CredentialKeys, type CredentialStore } from '../security/credential-store.js';
import type { TokenProvider } from './drive-client.js';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export interface OAuthEndpoints {
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
}

export const GOOGLE_OAUTH_ENDPOINTS: OAuthEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
};

export class ReauthRequiredError extends Error {
  constructor(message = 'Google 재인증이 필요합니다. `repovault auth login`을 실행하거나 앱에서 "인증 갱신"을 눌러 주세요.') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 PKCE (S256) */
export function createPkcePair(): { verifier: string; challenge: string; method: 'S256' } {
  const verifier = base64url(randomBytes(48)); // 64자, [A-Za-z0-9-_]
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

export function buildAuthUrl(
  endpoints: OAuthEndpoints,
  p: { clientId: string; redirectUri: string; state: string; challenge: string; scope?: string; loginHint?: string },
): string {
  const u = new URL(endpoints.authUrl);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', p.scope ?? DRIVE_FILE_SCOPE);
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  if (p.loginHint) u.searchParams.set('login_hint', p.loginHint);
  return u.toString();
}

export async function openInBrowser(url: string): Promise<void> {
  if (process.platform === 'darwin') await run('open', [url]);
  else if (process.platform === 'win32') await run('rundll32', ['url.dll,FileProtocolHandler', url]);
  else await run('xdg-open', [url], { allowFailure: true });
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

const SUCCESS_HTML = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>RepoVault</title>
<body style="font-family:system-ui;background:#0b0d12;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>✅ Google Drive 연결 완료</h1><p>이 창을 닫고 RepoVault로 돌아가세요.</p></div></body></html>`;
const FAIL_HTML = (msg: string) => `<!doctype html><html lang="ko"><meta charset="utf-8"><title>RepoVault</title>
<body style="font-family:system-ui;background:#0b0d12;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>⚠️ 인증 실패</h1><p>${msg.replace(/[<>&]/g, '')}</p></div></body></html>`;

/**
 * Google OAuth 2.0 Desktop App 흐름 (Authorization Code + PKCE S256 + Loopback Redirect + state 검증).
 * Refresh Token은 OS Credential Store에만 저장한다. Access Token은 메모리에만 유지한다.
 */
export class GoogleOAuthManager implements TokenProvider {
  private accessToken: string | null = null;
  private accessExpiresAt = 0;
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly creds: CredentialStore,
    private readonly clientId: string,
    private readonly endpoints: OAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async clientSecret(): Promise<string | null> {
    return this.creds.get(CredentialKeys.googleClientSecret);
  }

  /**
   * 브라우저 인증을 수행한다. opener를 주입하면 테스트/GUI에서 URL 처리 방식을 바꿀 수 있다.
   */
  async authorizeInteractive(opts: { opener?: (url: string) => Promise<void>; timeoutMs?: number; loginHint?: string } = {}): Promise<void> {
    const pkce = createPkcePair();
    const state = base64url(randomBytes(24));
    const opener = opts.opener ?? openInBrowser;
    let server: Server | null = null;
    const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      let redirectUri = '';
      const timer = setTimeout(() => reject(new Error('인증 시간이 초과되었습니다. 다시 시도해 주세요.')), opts.timeoutMs ?? 5 * 60 * 1000);
      server = createServer((req, res) => {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (u.pathname !== '/') {
          res.writeHead(404).end();
          return;
        }
        const err = u.searchParams.get('error');
        const got = u.searchParams.get('code');
        const gotState = u.searchParams.get('state');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAIL_HTML(err));
          clearTimeout(timer);
          reject(new Error(`Google 인증이 거부되었습니다: ${err}`));
          return;
        }
        if (!got || gotState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAIL_HTML('state 검증 실패'));
          clearTimeout(timer);
          reject(new Error('OAuth state 검증에 실패했습니다(CSRF 의심). 다시 시도해 주세요.'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML);
        clearTimeout(timer);
        resolve({ code: got, redirectUri });
      });
      server.listen(0, '127.0.0.1', () => {
        const port = (server!.address() as AddressInfo).port;
        redirectUri = `http://127.0.0.1:${port}`;
        const url = buildAuthUrl(this.endpoints, {
          clientId: this.clientId,
          redirectUri,
          state,
          challenge: pkce.challenge,
          loginHint: opts.loginHint,
        });
        opener(url).catch(reject);
      });
      server.on('error', reject);
    }).finally(() => {
      (server as Server | null)?.close();
    });

    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      code: code.code,
      redirect_uri: code.redirectUri,
      code_verifier: pkce.verifier,
    });
    if (!tokens.refresh_token) {
      throw new Error('Refresh Token을 받지 못했습니다. Google 계정의 앱 권한을 해제한 뒤 다시 연결해 주세요.');
    }
    await this.creds.set(CredentialKeys.googleRefreshToken, tokens.refresh_token);
    this.setAccess(tokens);
  }

  private setAccess(t: TokenResponse) {
    this.accessToken = t.access_token ?? null;
    this.accessExpiresAt = Date.now() + Math.max(0, (t.expires_in ?? 3600) - 120) * 1000;
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const body = new URLSearchParams({ client_id: this.clientId, ...params });
    const secret = await this.clientSecret();
    if (secret) body.set('client_secret', secret);
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoints.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (e) {
      throw new Error(`Google 토큰 서버에 연결할 수 없습니다: ${(e as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || json.error) {
      if (json.error === 'invalid_grant' || json.error === 'unauthorized_client' || json.error === 'invalid_client') {
        throw new ReauthRequiredError(
          `Google 인증이 만료되었거나 취소되었습니다(${json.error}). 다시 연결해 주세요. ` +
            '(OAuth 동의 화면이 Testing 상태면 Refresh Token이 7일 후 만료됩니다)',
        );
      }
      throw new Error(sanitizeText(`토큰 요청 실패 ${res.status}: ${json.error ?? ''} ${json.error_description ?? ''}`));
    }
    return json;
  }

  async hasRefreshToken(): Promise<boolean> {
    return !!(await this.creds.get(CredentialKeys.googleRefreshToken));
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.accessToken && Date.now() < this.accessExpiresAt) return this.accessToken;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const refresh = await this.creds.get(CredentialKeys.googleRefreshToken);
      if (!refresh) throw new ReauthRequiredError('Google Drive가 연결되어 있지 않습니다. 먼저 Google 계정을 연결해 주세요.');
      const t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
      if (t.refresh_token && t.refresh_token !== refresh) await this.creds.set(CredentialKeys.googleRefreshToken, t.refresh_token);
      this.setAccess(t);
      return this.accessToken!;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** 로컬 연결 해제. revoke=true 이면 Google 측 권한도 회수. Drive 파일은 절대 삭제하지 않는다. */
  async disconnect(revoke = false): Promise<void> {
    const refresh = await this.creds.get(CredentialKeys.googleRefreshToken);
    if (revoke && refresh) {
      await this.fetchImpl(this.endpoints.revokeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refresh }),
      }).catch(() => undefined);
    }
    await this.creds.delete(CredentialKeys.googleRefreshToken);
    this.accessToken = null;
  }
}

/** 테스트/Mock 서버용 고정 토큰 공급자 */
export class StaticTokenProvider implements TokenProvider {
  refreshCount = 0;
  constructor(private token: string) {}
  async getAccessToken(force = false) {
    if (force) this.refreshCount++;
    return this.token;
  }
}
