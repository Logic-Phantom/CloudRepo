import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { run } from '../utils/exec.js';

export const TASK_NAME = '\\RepoVault\\DailyBackup';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function quoteArg(a: string): string {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/**
 * Task Scheduler XML.
 * - 사용자 계정(InteractiveToken)·최소 권한(LeastPrivilege) → 관리자 권한 불필요
 * - StartWhenAvailable: PC가 꺼져 놓친 실행을 다음 가능한 시점에 보충
 * - MultipleInstancesPolicy=IgnoreNew: 중복 실행 방지 (에이전트 자체 락과 이중 보호)
 * - LogonTrigger: 로그인 시 누락분 확인
 */
export function buildTaskXml(opts: { command: string; args: string[]; hour: number; minute: number; userId?: string; startDate?: Date }): string {
  const d = opts.startDate ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const boundary = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(opts.hour)}:${pad(opts.minute)}:00`;
  const user = opts.userId ?? `${process.env.USERDOMAIN ?? ''}${process.env.USERDOMAIN ? '\\' : ''}${userInfo().username}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>RepoVault: Git 저장소를 Google Drive에 매일 백업</Description>
    <URI>${esc(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${boundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${esc(user)}</UserId>
      <Delay>PT5M</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${esc(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT12H</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT30M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(opts.command)}</Command>
      <Arguments>${esc(opts.args.map(quoteArg).join(' '))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export async function installScheduledTask(xml: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rv-task-'));
  try {
    const file = join(dir, 'task.xml');
    // schtasks는 UTF-16LE + BOM XML을 기대한다
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
    await run('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', file, '/F']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function uninstallScheduledTask(): Promise<void> {
  await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { allowFailure: true });
}

export async function setScheduledTaskEnabled(enabled: boolean): Promise<void> {
  await run('schtasks', ['/Change', '/TN', TASK_NAME, enabled ? '/ENABLE' : '/DISABLE'], { allowFailure: true });
}

export async function scheduledTaskStatus(): Promise<{ installed: boolean; detail: string }> {
  const r = await run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], { allowFailure: true });
  return { installed: r.code === 0, detail: r.stdout.trim() };
}
