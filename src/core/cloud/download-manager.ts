import { statSync } from 'node:fs';
import type { GoogleDriveClient } from './drive-client.js';
import { IntegrityError } from './upload-manager.js';
import { sha256File } from '../utils/misc.js';

/** Drive 파일을 내려받고 크기/SHA-256을 검증한다. 검증 실패 시 예외 (파일은 삭제하지 않음) */
export async function downloadVerified(
  drive: GoogleDriveClient,
  fileId: string,
  dest: string,
  expected: { size?: number; sha256?: string | null; name?: string },
): Promise<string> {
  await drive.downloadToFile(fileId, dest);
  const size = statSync(dest).size;
  if (expected.size !== undefined && size !== expected.size) {
    throw new IntegrityError(`다운로드 크기 불일치: ${expected.name ?? fileId} (예상 ${expected.size}, 실제 ${size})`);
  }
  const sha = await sha256File(dest);
  if (expected.sha256 && sha !== expected.sha256) throw new IntegrityError(`다운로드 SHA-256 불일치: ${expected.name ?? fileId}`);
  return sha;
}
