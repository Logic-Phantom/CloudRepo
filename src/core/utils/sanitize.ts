/**
 * 민감 정보 제거 유틸리티.
 * Remote URL, 로그, 오류 메시지에 포함될 수 있는 토큰/비밀번호/세션 URI를 제거한다.
 */

const SECRET_QUERY_KEYS = [
  'token',
  'access_token',
  'refresh_token',
  'private_token',
  'password',
  'passwd',
  'pwd',
  'key',
  'api_key',
  'apikey',
  'secret',
  'client_secret',
  'sig',
  'signature',
  'upload_id',
  'code',
];

/** URL의 userinfo(토큰/비밀번호)와 민감한 query 값을 제거한다. scp 형태(git@host:path)는 그대로 둔다. */
export function sanitizeUrl(input: string): string {
  if (!input) return input;
  const trimmed = input.trim();
  // scp-like ssh: user@host:path — 사용자명은 비밀이 아니므로 유지
  if (/^[\w.-]+@[\w.-]+:(?!\/\/)/.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return sanitizeText(trimmed);
  }
  if (url.protocol === 'ssh:') {
    url.password = '';
  } else if (url.username || url.password) {
    url.username = '';
    url.password = '';
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_KEYS.includes(key.toLowerCase())) url.searchParams.set(key, 'REDACTED');
  }
  return url.toString();
}

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  // https://user:token@host → https://host
  [/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_GITLAB_TOKEN]'],
  [/\bya29\.[A-Za-z0-9._-]+/g, '[REDACTED_GOOGLE_ACCESS_TOKEN]'],
  [/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[REDACTED_GOOGLE_REFRESH_TOKEN]'],
  [/\bGOCSPX-[A-Za-z0-9_-]+/g, '[REDACTED_CLIENT_SECRET]'],
  [/(authorization:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi, '$1[REDACTED]'],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]'],
  [/([?&](?:upload_id|access_token|token|key|code|client_secret)=)[^&\s"']+/gi, '$1REDACTED'],
];

/** 임의 텍스트에서 토큰/자격 증명 패턴을 제거한다. */
export function sanitizeText(input: string): string {
  if (!input) return input;
  let out = input;
  for (const [re, rep] of TEXT_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** 오류 객체를 사용자/로그에 안전한 문자열로 변환한다. */
export function sanitizeError(err: unknown): string {
  if (err instanceof Error) return sanitizeText(err.message);
  return sanitizeText(String(err));
}

/** Drive/파일 시스템/Git ref에 안전한 식별자 조각으로 변환 */
export function safeSegment(input: string): string {
  const s = input
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length ? s.slice(0, 200) : '_';
}
