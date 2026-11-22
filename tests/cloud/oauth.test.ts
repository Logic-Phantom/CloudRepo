import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { base64url, buildAuthUrl, createPkcePair, GoogleOAuthManager, ReauthRequiredError, DRIVE_FILE_SCOPE } from '../../src/core/cloud/oauth.js';
import { MemoryCredentialStore, CredentialKeys } from '../../src/core/security/credential-store.js';

let server: Server;
let base = '';
let lastBody: URLSearchParams | null = null;
let mode: 'ok' | 'invalid_grant' = 'ok';
let issuedChallenge = '';

beforeEach(async () => {
  mode = 'ok';
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    lastBody = new URLSearchParams(Buffer.concat(chunks).toString());
    if (mode === 'invalid_grant') {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }
    if (lastBody.get('grant_type') === 'authorization_code') {
      const v = lastBody.get('code_verifier')!;
      const ok = base64url(createHash('sha256').update(v).digest()) === issuedChallenge && lastBody.get('code') === 'AUTH_CODE';
      if (!ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: 'ya29.access', refresh_token: '1//refresh-token-value-xxxxxxxxxxxxxxxx', expires_in: 3600 }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: 'ya29.refreshed', expires_in: 3600 }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const endpoints = () => ({ authUrl: 'https://accounts.example.test/auth', tokenUrl: `${base}/token`, revokeUrl: `${base}/revoke` });

describe('OAuth 2.0 Desktop + PKCE', () => {
  it('PKCE S256 challenge = BASE64URL(SHA256(verifier))', () => {
    const p = createPkcePair();
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(p.challenge).toBe(base64url(createHash('sha256').update(p.verifier).digest()));
    expect(p.method).toBe('S256');
  });

  it('인증 URL: drive.file 최소 스코프, offline, PKCE, state 포함', () => {
    const u = new URL(buildAuthUrl(endpoints(), { clientId: 'cid', redirectUri: 'http://127.0.0.1:5555', state: 'st', challenge: 'ch' }));
    expect(u.searchParams.get('scope')).toBe(DRIVE_FILE_SCOPE);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('state')).toBe('st');
  });

  it('Loopback redirect 로 코드 수신 → 토큰 교환 → Refresh Token은 Credential Store에만 저장', async () => {
    const creds = new MemoryCredentialStore();
    await creds.set(CredentialKeys.googleClientSecret, 'GOCSPX-public-desktop-secret');
    const m = new GoogleOAuthManager(creds, 'cid', endpoints());
    await m.authorizeInteractive({
      opener: async (url) => {
        const u = new URL(url);
        issuedChallenge = u.searchParams.get('code_challenge')!;
        const redirect = `${u.searchParams.get('redirect_uri')}/?code=AUTH_CODE&state=${u.searchParams.get('state')}`;
        await fetch(redirect);
      },
    });
    expect(await creds.get(CredentialKeys.googleRefreshToken)).toBe('1//refresh-token-value-xxxxxxxxxxxxxxxx');
    expect(lastBody!.get('client_secret')).toBe('GOCSPX-public-desktop-secret');
    expect(await m.getAccessToken()).toBe('ya29.access');
    expect(await m.getAccessToken(true)).toBe('ya29.refreshed');
  });

  it('state 불일치(CSRF) 거부', async () => {
    const m = new GoogleOAuthManager(new MemoryCredentialStore(), 'cid', endpoints());
    await expect(
      m.authorizeInteractive({
        opener: async (url) => {
          const u = new URL(url);
          await fetch(`${u.searchParams.get('redirect_uri')}/?code=AUTH_CODE&state=forged`);
        },
      }),
    ).rejects.toThrow(/state/);
  });

  it('Refresh Token 만료/취소(invalid_grant) → ReauthRequiredError, 토큰 없음도 동일', async () => {
    const creds = new MemoryCredentialStore();
    const m = new GoogleOAuthManager(creds, 'cid', endpoints());
    await expect(m.getAccessToken()).rejects.toBeInstanceOf(ReauthRequiredError);
    await creds.set(CredentialKeys.googleRefreshToken, '1//revoked');
    mode = 'invalid_grant';
    await expect(m.getAccessToken(true)).rejects.toBeInstanceOf(ReauthRequiredError);
  });
});
