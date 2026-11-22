import { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Badge, Button, Card, Empty, ErrorBox, formatBytes, formatTime } from '../../components/ui';

type Filter = 'all' | 'restorable' | 'changed' | 'pending';

export function CloudHistory() {
  const snaps = useAsync(() => api.snapshots(), [], 20000);
  const pending = useAsync(() => api.pending(), [], 10000);
  const [filter, setFilter] = useState<Filter>('all');
  const [repo, setRepo] = useState('');

  const repos = useMemo(() => [...new Set((snaps.data ?? []).map((s) => s.repository_id))].sort(), [snaps.data]);
  const rows = (snaps.data ?? [])
    .filter((s) => !repo || s.repository_id === repo)
    .filter((s) => (filter === 'restorable' ? s.restorable : filter === 'changed' ? s.data.changes.added.length + s.data.changes.updated.length + s.data.changes.deleted.length + s.data.changes.forced.length > 0 : filter === 'pending' ? !s.restorable : true));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">클라우드 백업 기록</h1>
      <ErrorBox error={snaps.error} />

      {(pending.data ?? []).filter(Boolean).length > 0 && (
        <Card title="업로드 대기열 (미전송 임시 데이터 — 아직 Drive 백업 아님)">
          <div className="divide-y divide-line text-sm">
            {(pending.data ?? []).filter(Boolean).map((p) => (
              <div key={p!.snapshot_id} className="flex justify-between py-2">
                <span>{p!.repository_id} <span className="text-muted">({p!.files.filter((f) => f.verified).length}/{p!.files.length} 파일 검증됨)</span></span>
                <span className="text-xs text-warn">재시도 {p!.retry_count}회 · 다음 {formatTime(p!.next_retry_at)} {p!.last_error ? `· ${p!.last_error.slice(0, 80)}` : ''}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div className="mb-4 flex flex-wrap gap-2">
          <select value={repo} onChange={(e) => setRepo(e.target.value)} className="rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm">
            <option value="">모든 저장소</option>
            {repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {(['all', 'restorable', 'changed', 'pending'] as const).map((f) => (
            <Button key={f} variant={filter === f ? 'primary' : 'ghost'} onClick={() => setFilter(f)}>{{ all: '전체', restorable: '복원 가능', changed: '변경 있음', pending: '미완료' }[f]}</Button>
          ))}
        </div>
        {rows.length === 0 ? (
          <Empty>스냅샷이 없습니다.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr><th className="pb-2">일시</th><th>저장소</th><th>Snapshot ID</th><th>변경</th><th className="text-right">용량</th><th>SHA-256</th><th>복원 테스트</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((s) => {
                const c = s.data.changes;
                return (
                  <tr key={s.snapshot_id}>
                    <td className="py-2.5 whitespace-nowrap">{formatTime(s.created_at_utc)}</td>
                    <td>{s.repository_id}</td>
                    <td className="font-mono text-xs text-muted">{s.snapshot_id.slice(0, 8)}</td>
                    <td className="text-xs">
                      {c.added.length > 0 && <span className="mr-2 text-ok">+{c.added.length}</span>}
                      {c.updated.length > 0 && <span className="mr-2 text-accent">~{c.updated.length}</span>}
                      {c.deleted.length > 0 && <span className="mr-2 text-warn">-{c.deleted.length}</span>}
                      {c.forced.length > 0 && <span className="mr-2 text-bad">강제 {c.forced.length}</span>}
                      <span className="text-muted">브랜치 {s.data.branch_count} · 태그 {s.data.tag_count}{s.data.preserved_ref_count ? ` · 보호 ${s.data.preserved_ref_count}` : ''}</span>
                    </td>
                    <td className="text-right tabular-nums">{formatBytes(s.archive_size)}</td>
                    <td><Badge status={s.data.verification_status === 'verified' ? 'ok' : 'pending_upload'} /></td>
                    <td><Badge status={s.data.restore_test_status === 'passed' || s.data.restore_test_status === 'skipped' ? 'ok' : 'failed'} /></td>
                    <td>{s.folder_id && <Button variant="ghost" onClick={() => api.openExternal(`https://drive.google.com/drive/folders/${s.folder_id}`)}><ExternalLink size={14} /></Button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
