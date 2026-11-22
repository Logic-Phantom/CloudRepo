import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLaunchAgentPlist, installLaunchAgent, launchAgentStatus, uninstallLaunchAgent } from './macos.js';
import { buildTaskXml, installScheduledTask, scheduledTaskStatus, uninstallScheduledTask } from './windows.js';
import { run } from '../utils/exec.js';

export interface AgentCommand {
  command: string;
  args: string[];
}

/**
 * 스케줄러가 실행할 독립 에이전트 명령.
 * - 패키징된 Electron 앱: <App> --run-backup-agent
 * - 개발/CLI 설치: <node> <dist/cli/main.js> --run-backup-agent
 */
export function resolveAgentCommand(): AgentCommand {
  const electronVersion = process.versions.electron;
  if (electronVersion && !process.env.ELECTRON_RUN_AS_NODE) {
    return { command: process.execPath, args: ['--run-backup-agent'] };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const cli = realpathSync(join(here, '..', '..', 'cli', 'main.js'));
  return { command: process.execPath, args: [cli, '--run-backup-agent'] };
}

async function gitDir(): Promise<string | null> {
  const r = await run(process.platform === 'win32' ? 'where' : 'which', ['git'], { allowFailure: true });
  const p = r.stdout.trim().split(/\r?\n/)[0];
  return p ? dirname(p) : null;
}

export async function installSchedule(opts: { hour: number; minute: number; logDir: string; extraEnv?: Record<string, string> }): Promise<string> {
  const cmd = resolveAgentCommand();
  if (process.platform === 'darwin') {
    const g = await gitDir();
    const pathEnv = [...new Set([g, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean) as string[])].join(':');
    const plist = buildLaunchAgentPlist({
      programArgs: [cmd.command, ...cmd.args, '--trigger', 'schedule'],
      hour: opts.hour,
      minute: opts.minute,
      logDir: opts.logDir,
      pathEnv,
      extraEnv: opts.extraEnv,
    });
    return installLaunchAgent(plist);
  }
  if (process.platform === 'win32') {
    await installScheduledTask(buildTaskXml({ command: cmd.command, args: [...cmd.args, '--trigger', 'schedule'], hour: opts.hour, minute: opts.minute }));
    return 'Task Scheduler: \\RepoVault\\DailyBackup';
  }
  throw new Error('현재 OS에서는 자동 스케줄 등록을 지원하지 않습니다 (Windows/macOS 지원).');
}

export async function uninstallSchedule(): Promise<void> {
  if (process.platform === 'darwin') return uninstallLaunchAgent();
  if (process.platform === 'win32') return uninstallScheduledTask();
}

export async function scheduleStatus(): Promise<{ installed: boolean; detail: string }> {
  if (process.platform === 'darwin') return launchAgentStatus();
  if (process.platform === 'win32') return scheduledTaskStatus();
  return { installed: false, detail: 'unsupported' };
}

