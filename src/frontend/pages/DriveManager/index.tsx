import { useState } from 'react';
import { FileJson, FolderOpen, LogIn, LogOut, RefreshCw, Wrench } from 'lucide-react';
import { api } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Button, Card, ErrorBox, formatBytes, formatTime } from '../../components/ui';

export function DriveManager() {
  const status = useAsync(() => api.status(), [], 10000);
  const drive = useAsync(() => api.driveInfo(), [], 60000);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const g = status.data?.google;

  const act = async (name: string, fn: () => Promise<string>) => {
    setBusy(name);
    setError(null);
    try {
      setMsg(await fn());
      status.reload();
      drive.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const q = drive.data?.quota;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Google Drive 관리</h1>
      <ErrorBox error={error ?? status.error} />
      {msg && <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">{msg}</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="계정 연결">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted">OAuth Client</dt><dd>{g?.clientConfigured ? <span className="text-ok">설정됨</span> : <span className="text-warn">미설정</span>}</dd>
            <dt className="text-muted">연결 상태</dt><dd>{g?.connected ? <span className="text-ok">연결됨</span> : <span className="text-warn">연결 안 됨</span>}</dd>
            <dt className="text-muted">계정</dt><dd>{g?.email ?? '-'}</dd>
            <dt className="text-muted">권한 범위</dt><dd className="text-muted">drive.file (RepoVault가 만든 파일만)</dd>
            <dt className="text-muted">백업 폴더</dt><dd>My Drive/{g?.rootFolderName}</dd>
            <dt className="text-muted">토큰 저장소</dt><dd className="text-muted">{status.data?.credentialBackend}</dd>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => act('json', async () => { const r = await api.setupClientJson(); return r ? `OAuth Client 설정 완료 (${r.clientId})` : '취소됨'; })}><FileJson size={14} /> client_secret JSON 불러오기</Button>
            <Button variant="primary" disabled={!g?.clientConfigured || !!busy} onClick={() => act('login', async () => { const r = await api.authLogin(); return `연결 완료: ${r.email} · 기존 저장소 ${r.repositories}개 인식`; })}><LogIn size={14} /> {g?.connected ? '인증 갱신' : 'Google 계정 연결'}</Button>
            {g?.rootFolderLink && <Button onClick={() => api.openExternal(g.rootFolderLink!)}><FolderOpen size={14} /> Drive 폴더 열기</Button>}
            {g?.connected && <Button variant="danger" onClick={() => { if (confirm('로컬 연결만 해제합니다. Google Drive의 백업 파일은 삭제되지 않습니다. 계속할까요?')) act('logout', async () => { await api.authLogout(false); return '연결 해제됨 (Drive 파일은 그대로 유지)'; }); }}><LogOut size={14} /> 연결 해제</Button>}
          </div>
        </Card>

        <Card title="저장 공간">
          {q ? (
            <>
              <div className="mb-2 h-2 overflow-hidden rounded-full bg-panel-2">
                <div className="h-full bg-accent" style={{ width: q.limit && q.usage !== null ? `${Math.min(100, (q.usage / q.limit) * 100)}%` : '0%' }} />
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted">전체</dt><dd>{formatBytes(q.limit)}</dd>
                <dt className="text-muted">사용</dt><dd>{formatBytes(q.usage)}</dd>
                <dt className="text-muted">남은 공간</dt><dd>{formatBytes(q.free)}</dd>
                <dt className="text-muted">RepoVault 사용량</dt><dd>{formatBytes(drive.data?.repoVaultBytes)}</dd>
                <dt className="text-muted">업로드 대기 임시 데이터</dt><dd>{formatBytes(status.data?.tempUsageBytes)}</dd>
                <dt className="text-muted">마지막 확인</dt><dd>{formatTime(q.checkedAt)}</dd>
              </dl>
            </>
          ) : (
            <p className="text-sm text-muted">{drive.data?.error ?? '확인 불가'}</p>
          )}
        </Card>
      </div>

      <Card title="클라우드 인덱스">
        <p className="mb-3 text-sm text-muted">로컬 캐시(SQLite)는 언제든 Drive Manifest로 다시 만들 수 있습니다.</p>
        <div className="flex gap-2">
          <Button disabled={!!busy} onClick={() => act('resync', async () => `저장소 ${await api.resync()}개 동기화`)}><RefreshCw size={14} /> 인덱스 재동기화</Button>
          <Button disabled={!!busy} onClick={() => act('rebuild', async () => { const r = await api.rebuild(); return `스냅샷 ${r.snapshots}개로 저장소 ${r.repositories}개 인덱스 재구축`; })}><Wrench size={14} /> Manifest에서 재구축</Button>
        </div>
      </Card>
    </div>
  );
}
