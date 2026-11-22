import { describe, expect, it } from 'vitest';
import { buildLaunchAgentPlist } from '../../src/core/scheduler/macos.js';
import { buildTaskXml } from '../../src/core/scheduler/windows.js';
import { isRunDue, nextRunTime } from '../../src/core/agent/backup-runner.js';
import { sanitizeText, sanitizeUrl } from '../../src/core/utils/sanitize.js';
import { classifyRemoteError } from '../../src/core/git/git-engine.js';
import { parseRemote } from '../../src/core/providers/generic-git.js';

describe('스케줄러', () => {
  it('macOS LaunchAgent plist: 매일 03:00, RunAtLoad(누락 보충), 인자 배열', () => {
    const p = buildLaunchAgentPlist({ programArgs: ['/usr/bin/node', '/Apps/Repo Vault/main.js', '--run-backup-agent'], hour: 3, minute: 0, logDir: '/tmp/l', pathEnv: '/usr/bin' });
    expect(p).toContain('<string>com.repovault.daily-backup</string>');
    expect(p).toContain('<key>Hour</key>\n    <integer>3</integer>');
    expect(p).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(p).toContain('<string>/Apps/Repo Vault/main.js</string>');
  });

  it('Windows Task XML: StartWhenAvailable, IgnoreNew, LeastPrivilege', () => {
    const x = buildTaskXml({ command: 'C:\\Program Files\\RepoVault\\RepoVault.exe', args: ['--run-backup-agent', '--trigger', 'schedule'], hour: 3, minute: 30, userId: 'PC\\me', startDate: new Date(2026, 0, 2) });
    expect(x).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    expect(x).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(x).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(x).toContain('<StartBoundary>2026-01-02T03:30:00</StartBoundary>');
  });

  it('누락 실행 판정', () => {
    const now = new Date(2026, 5, 10, 9, 0);
    expect(isRunDue(null, 3, 0, now)).toBe(true);
    expect(isRunDue(new Date(2026, 5, 10, 3, 5).toISOString(), 3, 0, now)).toBe(false);
    expect(isRunDue(new Date(2026, 5, 9, 23, 0).toISOString(), 3, 0, now)).toBe(true);
    expect(isRunDue(new Date(2026, 5, 9, 3, 5).toISOString(), 3, 0, new Date(2026, 5, 10, 2, 0))).toBe(false);
    expect(nextRunTime(3, 0, now).getDate()).toBe(11);
  });
});

describe('보안 유틸', () => {
  it('Remote URL/로그에서 토큰 제거', () => {
    expect(sanitizeUrl('https://user:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(sanitizeUrl('https://example.com/r.git?private_token=abc')).toBe('https://example.com/r.git?private_token=REDACTED');
    expect(sanitizeUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
    const t = sanitizeText('fatal: https://x:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com Authorization: Bearer ya29.secretsecret https://x/upload?upload_id=XYZ 1//0abcdefghijklmnopqrstuvwxyz');
    expect(t).not.toMatch(/ghp_|ya29\.secret|XYZ|1\/\/0abc/);
  });

  it('원격 오류 분류: 인증/삭제/네트워크를 구분', () => {
    expect(classifyRemoteError('remote: Repository not found.')).toBe('remote_unavailable');
    expect(classifyRemoteError('fatal: could not read Username for https://github.com: terminal prompts disabled')).toBe('auth_error');
    expect(classifyRemoteError('fatal: unable to access: Could not resolve host: github.com')).toBe('network_error');
  });

  it('Remote URL 파싱', () => {
    expect(parseRemote('git@gitlab.com:group/sub/proj.git')).toEqual({ host: 'gitlab.com', owner: 'sub', name: 'proj' });
    expect(parseRemote('https://tok@github.com/Logic-Phantom/CloudRepo.git')).toEqual({ host: 'github.com', owner: 'Logic-Phantom', name: 'CloudRepo' });
  });
});
