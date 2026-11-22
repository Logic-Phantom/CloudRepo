import type { ReactNode } from 'react';

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '확인 불가';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `오늘 ${time}`;
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `내일 ${time}`;
  return d.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function Card({ title, children, right, className = '' }: { title?: ReactNode; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-panel p-5 ${className}`}>
      {(title || right) && (
        <header className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">{title}</h3>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode; hint?: string; tone?: 'default' | 'ok' | 'warn' | 'bad' }) {
  const color = { default: 'text-text', ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' }[tone];
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3.5">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Button({ children, onClick, variant = 'default', disabled, title }: { children: ReactNode; onClick?: () => void; variant?: 'default' | 'primary' | 'ghost' | 'danger'; disabled?: boolean; title?: string }) {
  const styles = {
    default: 'border border-line bg-panel-2 hover:bg-[#1d2230] text-text',
    primary: 'bg-accent hover:brightness-110 text-white',
    ghost: 'hover:bg-panel-2 text-muted hover:text-text',
    danger: 'border border-bad/40 text-bad hover:bg-bad/10',
  }[variant];
  return (
    <button title={title} disabled={disabled} onClick={onClick} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 ${styles}`}>
      {children}
    </button>
  );
}

const BADGE: Record<string, [string, string]> = {
  created: ['Drive 백업 완료', 'ok'],
  ok: ['정상', 'ok'],
  backed_up: ['Drive 백업 완료', 'ok'],
  unchanged: ['변경 없음', 'muted'],
  changed: ['변경 감지', 'accent'],
  pending_upload: ['업로드 대기', 'warn'],
  failed: ['백업 실패', 'bad'],
  remote_unavailable: ['원격 접근 실패', 'bad'],
  remote_missing: ['원격에서 사라짐', 'warn'],
  auth_error: ['인증 오류', 'bad'],
  network_error: ['네트워크 오류', 'warn'],
  completed: ['완료', 'ok'],
  completed_with_errors: ['일부 실패', 'warn'],
  running: ['실행 중', 'accent'],
  skipped: ['건너뜀', 'muted'],
  no_backup: ['백업 없음', 'muted'],
};

export function Badge({ status }: { status: string | null | undefined }) {
  const [label, tone] = BADGE[status ?? ''] ?? [status ?? '-', 'muted'];
  const cls = {
    ok: 'bg-ok/12 text-ok border-ok/25',
    warn: 'bg-warn/12 text-warn border-warn/25',
    bad: 'bg-bad/12 text-bad border-bad/25',
    accent: 'bg-accent/12 text-accent border-accent/25',
    muted: 'bg-white/5 text-muted border-line',
  }[tone];
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">{children}</div>;
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>;
}
