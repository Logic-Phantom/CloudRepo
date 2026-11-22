import { useMemo, useState } from 'react';
import { CloudUpload, Plus, RefreshCw, Search } from 'lucide-react';
import { api } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Badge, Button, Card, Empty, ErrorBox, formatBytes, formatTime } from '../../components/ui';

export function Repositories() {
  const repos = useAsync(() => api.repositories(), [], 15000);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'backed' | 'failed' | 'excluded'>('all');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState('');

  const rows = useMemo(() => {
    const cached = new Map((repos.data?.cached ?? []).map((r) => [r.id, r]));
    const excluded = new Set(repos.data?.excluded ?? []);
    const ids = new Set([...(repos.data?.targets ?? []).map((t) => t.id), ...cached.keys()]);
    return [...ids]
      .map((id) => {
        const t = repos.data?.targets.find((x) => x.id === id);
        const c = cached.get(id);
        return {
          id,
          name: t ? `${t.owner}/${t.name}` : `${c?.owner}/${c?.name}`,
          provider: t?.provider ?? c?.provider ?? '-',
          private: t?.private ?? !!c?.private,
          archived: t?.archived ?? !!c?.archived,
          excluded: excluded.has(id),
          status: c?.remote_status ?? null,
          message: c?.remote_message,
          lastChecked: c?.last_checked_at ?? null,
          lastBackup: c?.latest_backup_at ?? null,
          size: c?.total_size ?? 0,
          count: c?.snapshot_count ?? 0,
          restorable: !!c?.latest_snapshot_id,
        };
      })
      .filter((r) => r.name.toLowerCase().includes(q.toLowerCase()))
      .filter((r) => (filter === 'all' ? true : filter === 'backed' ? r.restorable : filter === 'excluded' ? r.excluded : ['remote_unavailable', 'auth_error', 'network_error'].includes(r.status ?? '')))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [repos.data, q, filter]);

  const discover = async () => {
    setBusy(true);
    try {
      const d = await api.discover();
      setInfo(`${d.github.login ? `GitHub ${d.github.login}: ` : ''}저장소 ${d.targets.length}개 확인${d.errors.length ? ` · ⚠ ${d.errors.join(' / ')}` : ''}`);
      await repos.reload();
    } catch (e) {
      setInfo((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">저장소 관리</h1>
        <Button onClick={discover} disabled={busy}><RefreshCw size={15} className={busy ? 'animate-spin' : ''} /> 원격 목록 새로고침</Button>
      </div>
      <ErrorBox error={repos.error} />
      {info && <div className="text-sm text-muted">{info}</div>}

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-1.5">
            <Search size={14} className="text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="저장소 검색" className="w-56 bg-transparent text-sm outline-none" />
          </div>
          {(['all', 'backed', 'failed', 'excluded'] as const).map((f) => (
            <Button key={f} variant={filter === f ? 'primary' : 'ghost'} onClick={() => setFilter(f)}>
              {{ all: '전체', backed: '복원 가능', failed: '실패', excluded: '제외됨' }[f]}
            </Button>
          ))}
        </div>
        {rows.length === 0 ? (
          <Empty>표시할 저장소가 없습니다. “원격 목록 새로고침”으로 GitHub 저장소를 불러오세요.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr><th className="pb-2">저장소</th><th>제공자</th><th>상태</th><th>마지막 확인</th><th>마지막 클라우드 백업</th><th className="text-right">Drive 용량</th><th>복원 가능</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id} className={r.excluded ? 'opacity-50' : ''}>
                  <td className="py-2.5">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-muted">{r.private ? 'private' : 'public'}{r.archived ? ' · archived' : ''} · 스냅샷 {r.count}</div>
                  </td>
                  <td className="text-muted">{r.provider}</td>
                  <td title={r.message ?? ''}><Badge status={r.status} /></td>
                  <td className="text-muted">{formatTime(r.lastChecked)}</td>
                  <td>{formatTime(r.lastBackup)}</td>
                  <td className="text-right tabular-nums">{formatBytes(r.size)}</td>
                  <td>{r.restorable ? <span className="text-ok">✓</span> : <span className="text-muted">-</span>}</td>
                  <td className="whitespace-nowrap text-right">
                    <Button variant="ghost" title="개별 백업" onClick={() => api.runBackup(r.id)}><CloudUpload size={14} /></Button>
                    <Button variant="ghost" onClick={async () => { await api.setExcluded(r.id, !r.excluded); repos.reload(); }}>{r.excluded ? '포함' : '제외'}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Git Remote 직접 등록 (GitLab, Gitea, 사내 Git, SSH 등)">
        <div className="flex gap-2">
          <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://gitlab.com/group/repo.git 또는 git@host:owner/repo.git" className="flex-1 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm outline-none" />
          <Button variant="primary" disabled={!newUrl} onClick={async () => { await api.addRemote(newUrl); setNewUrl(''); setInfo('등록했습니다. URL의 토큰/비밀번호는 저장 전에 제거됩니다.'); }}><Plus size={14} /> 등록</Button>
        </div>
      </Card>
    </div>
  );
}
