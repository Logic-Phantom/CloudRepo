import { createHmac } from 'node:crypto';
import type { RuntimeContext } from '../context.js';
import { CredentialKeys } from '../security/credential-store.js';
import { sanitizeError } from '../utils/sanitize.js';
import type { BackupJobSummary } from '../types.js';

/**
 * AutoMateHQ Heartbeat 보고.
 * 백업이 매일 실제로 돌았는지·성공했는지를 HQ 대시보드에서 확인하기 위한 선택 기능이다.
 * HQ 전송 실패는 백업 결과에 영향을 주지 않는다(항상 경고 로그만 남긴다).
 * 계약: AutoMateHQ docs/HEARTBEAT_INTEGRATION.md (HMAC-SHA256 서명, secret은 본문에 넣지 않음)
 */

export type HeartbeatKind = 'start' | 'complete' | 'fail';

export interface HeartbeatRequest {
  kind: HeartbeatKind;
  payload: Record<string, unknown>;
}

const MISSING_REMOTE = '원격 목록에서 사라짐';

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** 작업 요약 → 보고할 heartbeat 종류·본문. skipped(이미 완료/중복 실행)는 보고하지 않는다. */
export function buildFinalHeartbeat(summary: BackupJobSummary): HeartbeatRequest | null {
  if (summary.status === 'skipped' || summary.status === 'running') return null;
  const by = (o: string) => summary.results.filter((r) => r.outcome === o);
  const created = by('created');
  const unchanged = by('unchanged');
  const failed = by('failed');
  const pending = by('pending_upload');
  // 원격에서 저장소를 지운 경우는 정상(Drive 백업 유지)으로 본다
  const unreachable = by('remote_unavailable').filter((r) => !(r.message ?? '').includes(MISSING_REMOTE));
  const missing = by('remote_unavailable').length - unreachable.length;
  const bytes = created.reduce((n, r) => n + (r.bytes_uploaded ?? 0), 0);

  const metrics = {
    repositories: summary.repository_count,
    created: created.length,
    unchanged: unchanged.length,
    failed: failed.length,
    pendingUpload: pending.length,
    remoteUnavailable: unreachable.length,
    remoteMissing: missing,
    bytesUploaded: bytes,
  };
  const base = {
    runId: summary.job_id,
    source: 'repovault',
    startedAt: summary.started_at,
    completedAt: summary.completed_at ?? new Date().toISOString(),
    metrics,
  };
  const counts = `대상 ${summary.repository_count} · 새 스냅샷 ${created.length} · 변경 없음 ${unchanged.length}`;

  if (summary.status === 'failed') {
    const msg = summary.message ?? '백업 작업 실패';
    return {
      kind: 'fail',
      payload: { ...base, stage: 'failed', errorCode: /재인증|invalid_grant|Client ID|연결되어 있지/.test(msg) ? 'DRIVE_REAUTH' : 'BACKUP_FAILED', message: clip(msg, 500) },
    };
  }

  const problems = [...failed, ...pending, ...unreachable];
  const allUnreachable = unreachable.length > 0 && created.length + unchanged.length === 0;
  if (failed.length || pending.length || allUnreachable) {
    const detail = problems
      .slice(0, 3)
      .map((r) => `${r.repository_id}: ${r.outcome}${r.message ? ` (${clip(r.message, 80)})` : ''}`)
      .join(' / ');
    return {
      kind: 'fail',
      payload: {
        ...base,
        stage: 'partial',
        errorCode: pending.length && !failed.length ? 'UPLOAD_PENDING' : 'BACKUP_PARTIAL',
        message: clip(`일부 백업 실패 — 실패 ${failed.length}, 업로드 대기 ${pending.length}, 원격 접근 실패 ${unreachable.length}. ${counts}. ${detail}`, 500),
      },
    };
  }
  const warn = unreachable.length ? ` (원격 접근 실패 ${unreachable.length}개는 기존 Drive 백업 유지)` : '';
  return { kind: 'complete', payload: { ...base, stage: 'done', message: clip(`Drive 백업 완료 — ${counts}${warn}`, 500) } };
}

export function signHeartbeat(secret: string, body: string, ts: number): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

export interface HqSettings {
  url: string;
  projectKey: string;
  secret: string;
}

export async function loadHqSettings(ctx: RuntimeContext): Promise<HqSettings | null> {
  const url = ctx.cfg.hq?.url;
  const projectKey = ctx.cfg.hq?.project_key;
  if (!url || !projectKey) return null;
  const secret = await ctx.creds.get(CredentialKeys.hqHeartbeatSecret).catch(() => null);
  if (!secret) return null;
  return { url: url.replace(/\/+$/, ''), projectKey, secret };
}

/** 서명 요청 전송. 예외를 던지지 않고 결과만 돌려준다. */
export async function sendHeartbeat(
  settings: HqSettings,
  req: HeartbeatRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify({ projectKey: settings.projectKey, ...req.payload });
  const ts = Math.floor(Date.now() / 1000);
  try {
    const res = await fetchImpl(`${settings.url}/api/v1/heartbeat/${req.kind}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HQ-Project': settings.projectKey,
        'X-HQ-Timestamp': String(ts),
        'X-HQ-Signature': signHeartbeat(settings.secret, body, ts),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, status: res.status, error: clip(await res.text().catch(() => ''), 200) };
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: sanitizeError(e) };
  }
}

/** 에이전트용: 설정이 없으면 조용히 건너뛰고, 실패는 경고 로그만 남긴다. */
export async function reportToHq(ctx: RuntimeContext, req: HeartbeatRequest | null, fetchImpl?: typeof fetch): Promise<void> {
  if (!req) return;
  try {
    const settings = await loadHqSettings(ctx);
    if (!settings) return;
    const r = await sendHeartbeat(settings, req, fetchImpl ?? fetch);
    if (!r.ok) ctx.log.warn(`HQ heartbeat(${req.kind}) 전송 실패 — 백업 결과에는 영향 없음: ${r.status ?? ''} ${r.error ?? ''}`.trim());
  } catch (e) {
    ctx.log.warn(`HQ heartbeat(${req.kind}) 전송 실패 — 백업 결과에는 영향 없음: ${sanitizeError(e)}`);
  }
}
