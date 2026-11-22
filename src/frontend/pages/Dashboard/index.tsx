import { useState } from 'react';
import { CloudUpload, RefreshCw, History, FolderOpen, RotateCcw } from 'lucide-react';
import { api } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Badge, Button, Card, Empty, ErrorBox, Stat, formatBytes, formatTime } from '../../components/ui';
import type { Page } from '../../App';

export function Dashboard({ go }: { go: (p: Page) => void }) {
  const status = useAsync(() => api.status(), [], 5000);
  const repos = useAsync(() => api.repositories(), [], 15000);
  const drive = useAsync(() => api.driveInfo(), [], 60000);
  const jobs = useAsync(() => api.jobs(), [], 10000);
  const [msg, setMsg] = useState<string | null>(null);
  const s = status.data;
  const running = s?.agent?.state === 'running';
  const last = s?.lastJob;

  const backupNow = async () => {
    try {
      await api.runBackup();
      setMsg('백그라운드 에이전트가 백업을 시작했습니다. 창을 닫아도 계속 진행됩니다.');
      setTimeout(status.reload, 800);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const cached = repos.data?.cached ?? [];
  const failed = cached.filter((r) => ['remote_unavailable', 'auth_error', 'network_error'].includes(r.remote_status ?? '')).length;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold">RepoVault</h1>
          <p className="mt-1 text-sm text-muted">Git 저장소를 Google Drive에 안전하게 보관하세요.</p>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Google Drive</dt>
            <dd>{s?.google.connected ? <span className="text-ok">연결됨 ({s.google.email ?? '계정 확인 중'})</span> : <span className="text-warn">연결 안 됨</span>}</dd>
            <dt className="text-muted">마지막 클라우드 백업</dt>
            <dd>{formatTime(last?.completed_at ?? null)}</dd>
            <dt className="text-muted">다음 자동 백업</dt>
            <dd>{s?.schedule.enabled ? formatTime(s.schedule.nextRun) : '꺼짐'}{s && s.schedule.enabled && !s.schedule.installed && <span className="ml-2 text-warn">(스케줄러 미등록)</span>}</dd>
          </dl>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="primary" onClick={backupNow} disabled={running || !s?.google.connected}>
            <CloudUpload size={15} /> {running ? '백업 진행 중…' : '지금 백업'}
          </Button>
          <Button onClick={() => go('repositories')}><RefreshCw size={15} /> 변경사항 확인</Button>
          <Button onClick={() => go('history')}><History size={15} /> 클라우드 백업 기록</Button>
          <Button onClick={() => go('restore')}><RotateCcw size={15} /> Drive에서 복원</Button>
          {s?.google.rootFolderLink && <Button variant="ghost" onClick={() => api.openExternal(s.google.rootFolderLink!)}><FolderOpen size={15} /> Drive 폴더</Button>}
        </div>
      </div>

      <ErrorBox error={status.error} />
      {msg && <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">{msg}</div>}
      {running && (
        <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm">
          백업 중: <b>{s?.agent?.current ?? '준비 중'}</b> {s?.agent?.progress && `(${s.agent.progress.done}/${s.agent.progress.total})`}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="전체 저장소" value={repos.data?.targets.length || cached.length} />
        <Stat label="최근 백업 성공" value={last?.success_count ?? 0} tone="ok" />
        <Stat label="변경 없음" value={last?.unchanged_count ?? 0} />
        <Stat label="백업 실패" value={(last?.failed_count ?? 0) || failed} tone={(last?.failed_count ?? 0) || failed ? 'bad' : 'default'} />
        <Stat label="Drive 사용량 (RepoVault)" value={formatBytes(drive.data?.repoVaultBytes ?? 0)} hint={drive.data?.quota ? `남은 공간 ${formatBytes(drive.data.quota.free)}` : '확인 불가'} />
        <Stat label="업로드 대기" value={s?.pendingUploads ?? 0} tone={s?.pendingUploads ? 'warn' : 'default'} hint={s?.tempUsageBytes ? `임시 ${formatBytes(s.tempUsageBytes)}` : undefined} />
      </div>

      <Card title="저장소 상태" right={<Button variant="ghost" onClick={() => go('repositories')}>전체 보기</Button>}>
        {cached.length === 0 ? (
          <Empty>아직 Drive 백업이 없습니다. Google Drive를 연결한 뒤 “지금 백업”을 눌러 주세요.</Empty>
        ) : (
          <div className="divide-y divide-line">
            {cached.slice(0, 12).map((r) => (
              <div key={r.id} className="flex items-center justify-between py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{r.owner}/{r.name}</div>
                  <div className="text-xs text-muted">마지막 확인 {formatTime(r.last_checked_at)} · 스냅샷 {r.snapshot_count}개 · {formatBytes(r.total_size)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge status={r.remote_status} />
                  {r.latest_snapshot_id ? <Badge status="backed_up" /> : <Badge status="no_backup" />}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="최근 클라우드 백업 이력">
        {(jobs.data ?? []).length === 0 ? (
          <Empty>백업 작업 기록이 없습니다.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr><th className="pb-2">시작</th><th>트리거</th><th>상태</th><th className="text-right">성공</th><th className="text-right">변경없음</th><th className="text-right">실패</th><th className="text-right">대기</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(jobs.data ?? []).slice(0, 8).map((j) => (
                <tr key={j.id}>
                  <td className="py-2">{formatTime(j.started_at)}</td>
                  <td className="text-muted">{j.job_type}</td>
                  <td><Badge status={j.status} /></td>
                  <td className="text-right tabular-nums">{j.success_count}</td>
                  <td className="text-right tabular-nums">{j.unchanged_count}</td>
                  <td className="text-right tabular-nums">{j.failed_count}</td>
                  <td className="text-right tabular-nums">{j.pending_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
