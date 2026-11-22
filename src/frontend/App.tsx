import { useState } from 'react';
import { Cloud, Database, History, LayoutDashboard, RotateCcw, Settings as SettingsIcon } from 'lucide-react';
import { Dashboard } from './pages/Dashboard';
import { Repositories } from './pages/Repositories';
import { CloudHistory } from './pages/CloudHistory';
import { CloudRestore } from './pages/CloudRestore';
import { DriveManager } from './pages/DriveManager';
import { Settings } from './pages/Settings';

export type Page = 'dashboard' | 'repositories' | 'history' | 'restore' | 'drive' | 'settings';

const NAV: Array<{ id: Page; label: string; icon: typeof Cloud }> = [
  { id: 'dashboard', label: '대시보드', icon: LayoutDashboard },
  { id: 'repositories', label: '저장소', icon: Database },
  { id: 'history', label: '백업 기록', icon: History },
  { id: 'restore', label: '복원', icon: RotateCcw },
  { id: 'drive', label: 'Google Drive', icon: Cloud },
  { id: 'settings', label: '설정', icon: SettingsIcon },
];

export function App() {
  const [page, setPage] = useState<Page>('dashboard');
  return (
    <div className="flex h-full">
      <aside className="drag flex w-56 shrink-0 flex-col border-r border-line bg-panel pt-10">
        <div className="px-5 pb-6">
          <div className="text-base font-semibold tracking-tight">RepoVault</div>
          <div className="text-xs text-muted">Cloud-Only Git Backup</div>
        </div>
        <nav className="no-drag space-y-0.5 px-2">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setPage(id)} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${page === id ? 'bg-panel-2 text-text' : 'text-muted hover:bg-panel-2 hover:text-text'}`}>
              <Icon size={16} /> {label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto px-8 pb-10 pt-10">
        {page === 'dashboard' && <Dashboard go={setPage} />}
        {page === 'repositories' && <Repositories />}
        {page === 'history' && <CloudHistory />}
        {page === 'restore' && <CloudRestore />}
        {page === 'drive' && <DriveManager />}
        {page === 'settings' && <Settings />}
      </main>
    </div>
  );
}
