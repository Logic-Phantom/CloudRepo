import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from '../utils/exec.js';

export const LAUNCH_AGENT_LABEL = 'com.repovault.daily-backup';

export function launchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 사용자 LaunchAgent plist.
 * - StartCalendarInterval: 매일 지정 시각 (절전 중 놓친 실행은 깨어날 때 launchd가 실행)
 * - RunAtLoad: 로그인/재부팅 시 1회 실행 → 에이전트가 "오늘 백업이 이미 끝났는지" 판단해 누락분만 보충
 */
export function buildLaunchAgentPlist(opts: { programArgs: string[]; hour: number; minute: number; logDir: string; pathEnv: string; extraEnv?: Record<string, string> }): string {
  const args = opts.programArgs.map((a) => `    <string>${esc(a)}</string>`).join('\n');
  const env = { PATH: opts.pathEnv, ...(opts.extraEnv ?? {}) };
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${opts.hour}</integer>
    <key>Minute</key>
    <integer>${opts.minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>StandardOutPath</key>
  <string>${esc(join(opts.logDir, 'agent.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(opts.logDir, 'agent.err.log'))}</string>
</dict>
</plist>
`;
}

export async function installLaunchAgent(plist: string): Promise<string> {
  const path = launchAgentPath();
  mkdirSync(dirname(path), { recursive: true });
  const uid = userInfo().uid;
  if (existsSync(path)) await run('launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { allowFailure: true });
  writeFileSync(path, plist, { mode: 0o644 });
  const r = await run('launchctl', ['bootstrap', `gui/${uid}`, path], { allowFailure: true });
  if (r.code !== 0 && !/already/i.test(r.stderr)) throw new Error(`LaunchAgent 등록 실패: ${r.stderr.trim()}`);
  await run('launchctl', ['enable', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { allowFailure: true });
  return path;
}

export async function uninstallLaunchAgent(): Promise<void> {
  const uid = userInfo().uid;
  await run('launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { allowFailure: true });
  rmSync(launchAgentPath(), { force: true });
}

export async function launchAgentStatus(): Promise<{ installed: boolean; loaded: boolean; detail: string }> {
  const installed = existsSync(launchAgentPath());
  const r = await run('launchctl', ['print', `gui/${userInfo().uid}/${LAUNCH_AGENT_LABEL}`], { allowFailure: true });
  const state = /state = (\w+)/.exec(r.stdout)?.[1] ?? '';
  const lastExit = /last exit code = ([^\n]+)/.exec(r.stdout)?.[1] ?? '';
  return { installed, loaded: r.code === 0, detail: r.code === 0 ? `state=${state} last_exit=${lastExit}` : 'not loaded' };
}
