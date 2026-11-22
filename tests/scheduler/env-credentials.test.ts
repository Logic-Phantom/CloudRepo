import { describe, expect, it } from 'vitest';
import { EnvCredentialStore } from '../../src/core/security/credential-store.js';

describe('클라우드 러너용 환경 변수 자격 증명', () => {
  it('키 → REPOVAULT_SECRET_* 매핑, 쓰기는 메모리에만', async () => {
    const env = { REPOVAULT_SECRET_GOOGLE_REFRESH_TOKEN: ' 1//abc ', REPOVAULT_SECRET_GITHUB_TOKEN: 'tok' };
    const s = new EnvCredentialStore(env);
    expect(await s.get('google-refresh-token')).toBe('1//abc');
    expect(await s.get('github-token')).toBe('tok');
    expect(await s.get('google-client-secret')).toBeNull();
    await s.set('upload-session:job:file', 'https://session');
    expect(await s.get('upload-session:job:file')).toBe('https://session');
    expect(Object.keys(env)).toHaveLength(2);
    await s.delete('upload-session:job:file');
    expect(await s.get('upload-session:job:file')).toBeNull();
  });
});

describe('Git 인증 헤더 (CI 회귀)', () => {
  it('토큰 헤더 앞에 빈 extraHeader로 기존 헤더(checkout 토큰 등)를 초기화해 중복 Authorization(400)을 막는다', async () => {
    const { GitEngine } = await import('../../src/core/git/git-engine.js');
    const env = new GitEngine({ auth: [{ urlPrefix: 'https://github.com/', username: 'x-access-token', token: 't' }] }).env();
    const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    const idx = pairs.findIndex(([k]) => k === 'http.https://github.com/.extraHeader');
    expect(pairs[idx]![1]).toBe('');
    expect(pairs[idx + 1]![1]).toMatch(/^Authorization: Basic /);
  });
});
