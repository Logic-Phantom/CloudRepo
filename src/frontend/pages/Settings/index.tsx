import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { api } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Button, Card, ErrorBox } from '../../components/ui';

export function Settings() {
  const cfg = useAsync(() => api.config(), []);
  const status = useAsync(() => api.status(), []);
  const [time, setTime] = useState('03:00');
  const [orgs, setOrgs] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cfg.data) return;
    setTime(`${String(cfg.data.schedule.hour).padStart(2, '0')}:${String(cfg.data.schedule.minute).padStart(2, '0')}`);
    setOrgs(cfg.data.github.include_orgs.join(', '));
  }, [cfg.data]);

  const save = async (patch: any, message = '저장했습니다.') => {
    try {
      await api.saveConfig(patch);
      setMsg(message);
      cfg.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!cfg.data) return <ErrorBox error={cfg.error} />;
  const c = cfg.data;
  const toggle = (section: string, key: string) => save({ [section]: { ...c[section], [key]: !c[section][key] } });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">설정</h1>
      <ErrorBox error={error} />
      {msg && <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">{msg}</div>}

      <Card title="자동 백업 (GUI 종료 상태에서도 OS 스케줄러로 실행)">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted">매일</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded-lg border border-line bg-panel-2 px-2 py-1" />
          <Button variant="primary" onClick={async () => {
            try {
              const [h, m] = time.split(':').map(Number);
              const where = await api.scheduleInstall(h!, m!);
              setMsg(`자동 백업 등록: 매일 ${time} (${where})`);
              status.reload();
            } catch (e) { setError((e as Error).message); }
          }}><Save size={14} /> 스케줄 등록/변경</Button>
          <Button variant="danger" onClick={async () => { await api.scheduleUninstall(); setMsg('자동 백업을 껐습니다. Drive 백업은 유지됩니다.'); status.reload(); }}>자동 백업 끄기</Button>
          <span className="text-muted">현재: {status.data?.schedule.installed ? `등록됨 (${status.data.schedule.detail})` : '미등록'}</span>
        </div>
        <p className="mt-2 text-xs text-muted">PC가 꺼져 있거나 절전 중이라 놓친 백업은 다음 로그인/기상 시 자동 보충합니다. 업로드 대기 데이터는 매 실행 시 우선 재시도합니다.</p>
      </Card>

      <Card title="GitHub">
        <div className="space-y-2 text-sm">
          {[
            ['include_archived', 'Archived 저장소 포함'],
            ['include_forks', 'Fork 저장소 포함'],
            ['auto_add_new', '새 저장소 자동 등록'],
            ['include_collaborator_repos', '협업(타인 소유) 저장소 포함'],
          ].map(([k, label]) => (
            <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={!!c.github[k!]} onChange={() => toggle('github', k!)} /> {label}</label>
          ))}
          <div className="flex items-center gap-2 pt-2">
            <span className="text-muted">포함할 조직</span>
            <input value={orgs} onChange={(e) => setOrgs(e.target.value)} placeholder="org1, org2" className="flex-1 rounded-lg border border-line bg-panel-2 px-2 py-1" />
            <Button onClick={() => save({ github: { ...c.github, include_orgs: orgs.split(',').map((s) => s.trim()).filter(Boolean) } })}>저장</Button>
          </div>
        </div>
      </Card>

      <Card title="저장 / 보안">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>영구 백업 위치: Google Drive (My Drive/{c.google.root_folder_name}) — 로컬 영구 백업 경로는 제공하지 않습니다.</li>
          <li>로컬 임시 작업 공간은 업로드·검증 완료 후 자동 정리됩니다.</li>
          <li>보관 정책: {c.retention.auto_delete_enabled ? `${c.retention.keep_days}일` : '무기한 (자동 삭제 없음)'}</li>
          <li>OAuth Refresh Token·업로드 세션은 OS 자격 증명 저장소에만 저장됩니다.</li>
          <li>업로드 청크 크기: {c.upload.chunk_size_mb} MB · 최대 재시도 {c.retry.max_attempts}회</li>
        </ul>
      </Card>
    </div>
  );
}
