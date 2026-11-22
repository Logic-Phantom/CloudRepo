import type { Api } from '../types/api';

declare global {
  interface Window {
    repovault?: Record<string, (...args: unknown[]) => Promise<{ ok: boolean; data?: unknown; error?: string }>>;
  }
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const bridge = window.repovault;
  if (!bridge) throw new Error('RepoVault 데스크톱 앱에서 실행해 주세요 (Electron 브리지 없음).');
  const r = await bridge[channel]!(...args);
  if (!r.ok) throw new Error(r.error ?? '알 수 없는 오류');
  return r.data as T;
}

export const api: Api = new Proxy({} as Api, {
  get: (_t, prop: string) => (...args: unknown[]) => call(prop, ...args),
});
