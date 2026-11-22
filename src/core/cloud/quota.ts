import type { GoogleDriveClient } from './drive-client.js';

export interface QuotaInfo {
  limit: number | null;
  usage: number | null;
  usageInDrive: number | null;
  usageInTrash: number | null;
  free: number | null;
  checkedAt: string;
  email: string | null;
}

export class QuotaInsufficientError extends Error {
  constructor(
    readonly needed: number,
    readonly free: number,
  ) {
    super(`Google Drive 저장 공간이 부족합니다. 필요: ${needed} bytes, 남은 공간: ${free} bytes. 기존 백업은 그대로 보존되며, 업로드 대기 파일은 재시도 대기열에 남습니다.`);
    this.name = 'QuotaInsufficientError';
  }
}

const num = (v: string | undefined) => (v === undefined || v === null || v === '' ? null : Number(v));

/** Drive about.get 기반 용량 조회. 제공되지 않는 값은 null(UI에서 '확인 불가')로 둔다 */
export async function getQuota(drive: GoogleDriveClient): Promise<QuotaInfo> {
  const a = await drive.about();
  const limit = num(a.storageQuota?.limit);
  const usage = num(a.storageQuota?.usage);
  return {
    limit,
    usage,
    usageInDrive: num(a.storageQuota?.usageInDrive),
    usageInTrash: num(a.storageQuota?.usageInDriveTrash),
    free: limit !== null && usage !== null ? Math.max(0, limit - usage) : null,
    checkedAt: new Date().toISOString(),
    email: a.user?.emailAddress ?? null,
  };
}

/** 업로드 전 용량 사전 검사 (limit 미제공 = 무제한/확인 불가 → 통과) */
export async function assertQuota(drive: GoogleDriveClient, neededBytes: number): Promise<QuotaInfo> {
  const q = await getQuota(drive);
  if (q.free !== null && q.free < Math.ceil(neededBytes * 1.02) + 1024 * 1024) throw new QuotaInsufficientError(neededBytes, q.free);
  return q;
}
