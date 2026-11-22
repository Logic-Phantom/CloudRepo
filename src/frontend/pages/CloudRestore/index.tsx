import { useEffect, useState } from 'react';
import { FolderOpen, RotateCcw } from 'lucide-react';
import { api } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Button, Card, Empty, ErrorBox, formatBytes, formatTime } from '../../components/ui';

export function CloudRestore() {
  const repos = useAsync(() => api.repositories(), []);
  const [repo, setRepo] = useState('');
  const snaps = useAsync(() => (repo ? api.snapshots(repo) : Promise.resolve([])), [repo]);
  const [snap, setSnap] = useState('');
  const [manifest, setManifest] = useState<any>(null);
  const [dest, setDest] = useState('');
  const [remote, setRemote] = useState('');
  const [selectedRefs, setSelectedRefs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    setManifest(null);
    setSelectedRefs([]);
    if (repo && snap) api.snapshotManifest(repo, snap).then(setManifest).catch((e) => setError(e.message));
  }, [repo, snap]);

  const refs: string[] = manifest ? Object.keys(manifest.refs_summary ?? {}) : [];

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.restore({ repositoryId: repo, snapshotId: snap, destination: dest, refs: selectedRefs.length ? selectedRefs : undefined, setRemoteUrl: remote || undefined });
      setResult(`✅ 복원 완료: ${r.destination} — ref ${Object.keys(r.restored_refs).length}개 검증, LFS ${r.lfs}${r.warnings.length ? `\n⚠ ${r.warnings.join('\n⚠ ')}` : ''}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Drive에서 복원</h1>
      <p className="text-sm text-muted">로컬 백업 없이 Google Drive의 스냅샷만으로 복원합니다. 기존 폴더는 절대 덮어쓰지 않습니다.</p>
      <ErrorBox error={error} />
      {result && <pre className="whitespace-pre-wrap rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok">{result}</pre>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1. 저장소 / 시점 선택">
          <select value={repo} onChange={(e) => { setRepo(e.target.value); setSnap(''); }} className="mb-3 w-full rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-sm">
            <option value="">저장소 선택…</option>
            {(repos.data?.cached ?? []).filter((r) => r.snapshot_count > 0).map((r) => <option key={r.id} value={r.id}>{r.owner}/{r.name} ({r.snapshot_count})</option>)}
          </select>
          {repo && ((snaps.data ?? []).length === 0 ? <Empty>스냅샷이 없습니다.</Empty> : (
            <div className="max-h-80 space-y-1 overflow-auto">
              {(snaps.data ?? []).map((s) => (
                <label key={s.snapshot_id} className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-sm ${snap === s.snapshot_id ? 'border-accent bg-accent/10' : 'border-line'} ${s.restorable ? '' : 'opacity-50'}`}>
                  <span><input type="radio" className="mr-2" disabled={!s.restorable} checked={snap === s.snapshot_id} onChange={() => setSnap(s.snapshot_id)} />{formatTime(s.created_at_utc)} <span className="font-mono text-xs text-muted">{s.snapshot_id.slice(0, 8)}</span></span>
                  <span className="text-xs text-muted">{formatBytes(s.archive_size)} · 브랜치 {s.data.branch_count} · 태그 {s.data.tag_count}</span>
                </label>
              ))}
            </div>
          ))}
        </Card>

        <Card title="2. 복원 내용 확인">
          {!manifest ? <Empty>스냅샷을 선택하면 브랜치/태그와 무결성 정보를 보여줍니다.</Empty> : (
            <div className="space-y-3 text-sm">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted">저장소</dt><dd>{manifest.owner}/{manifest.repository_name}</dd>
                <dt className="text-muted">일시</dt><dd>{new Date(manifest.created_at_utc).toLocaleString('ko-KR')}</dd>
                <dt className="text-muted">Bundle</dt><dd>{formatBytes(manifest.archive_size)} · SHA-256 {String(manifest.archive_sha256 ?? '-').slice(0, 16)}…</dd>
                <dt className="text-muted">LFS / Submodule</dt><dd>{manifest.lfs_status} / {manifest.submodule_status}</dd>
                <dt className="text-muted">무결성</dt><dd className="text-ok">{manifest.verification_status} · 복원 테스트 {manifest.restore_test_status}</dd>
              </dl>
              <div>
                <div className="mb-1 text-xs text-muted">특정 브랜치/태그만 복원 (선택 안 하면 전체 + 보호된 과거 ref)</div>
                <div className="max-h-40 overflow-auto rounded-lg border border-line p-2 font-mono text-xs">
                  {refs.map((r) => (
                    <label key={r} className="flex items-center gap-2 py-0.5">
                      <input type="checkbox" checked={selectedRefs.includes(r)} onChange={(e) => setSelectedRefs(e.target.checked ? [...selectedRefs, r] : selectedRefs.filter((x) => x !== r))} />
                      {r} <span className="text-muted">{String(manifest.refs_summary[r]).slice(0, 8)}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card title="3. 복원 위치">
        <div className="flex flex-wrap gap-2">
          <input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="빈 폴더 또는 새 폴더 경로" className="min-w-80 flex-1 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm" />
          <Button onClick={async () => { const d = await api.chooseDirectory(); if (d) setDest(d); }}><FolderOpen size={14} /> 선택</Button>
        </div>
        <input value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="(선택) 복원 후 origin 으로 설정할 원격 URL" className="mt-2 w-full rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm" />
        <div className="mt-4 flex justify-end">
          <Button variant="primary" disabled={!repo || !snap || !dest || busy} onClick={run}><RotateCcw size={14} /> {busy ? '복원 중…' : '복원 실행'}</Button>
        </div>
      </Card>
    </div>
  );
}
