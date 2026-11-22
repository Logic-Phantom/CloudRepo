import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 지수 백오프 + jitter (ms) */
export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve());
  });
  return hash.digest('hex');
}

export function sha256Buffer(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** UTC 타임스탬프: 20261122T030000Z */
export function utcStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function newId(): string {
  return randomUUID();
}

export function formatBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '확인 불가';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}
