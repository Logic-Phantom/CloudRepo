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
