import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { run } from '../utils/exec.js';

export const CREDENTIAL_SERVICE = 'RepoVault';

export const CredentialKeys = {
  googleRefreshToken: 'google-refresh-token',
  googleClientSecret: 'google-client-secret',
  githubToken: 'github-token',
  gitlabToken: 'gitlab-token',
  uploadSession: (id: string) => `upload-session:${id}`,
} as const;

/**
 * OS 자격 증명 저장소 추상화.
 * - macOS: Keychain (`security` CLI, 비밀값은 argv가 아닌 stdin으로 전달)
 * - Windows: Credential Manager (PowerShell + CredWrite/CredRead P/Invoke, 값은 stdin 전달)
 * - 테스트: MemoryCredentialStore
 */
export interface CredentialStore {
  readonly kind: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  readonly kind = 'memory';
  private readonly map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

function keychainQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class MacKeychainStore implements CredentialStore {
  readonly kind = 'macos-keychain';
  constructor(private readonly service = CREDENTIAL_SERVICE) {}

  async get(key: string): Promise<string | null> {
    const r = await run('security', ['find-generic-password', '-s', this.service, '-a', key, '-w'], {
      allowFailure: true,
      timeoutMs: 20000,
    });
    if (r.code !== 0) return null;
    return r.stdout.replace(/\n$/, '');
  }

  async set(key: string, value: string): Promise<void> {
    if (/[\r\n]/.test(value)) throw new Error('자격 증명 값에 줄바꿈을 포함할 수 없습니다.');
    // `security -i`는 stdin에서 명령을 읽으므로 비밀값이 프로세스 인자 목록에 노출되지 않는다.
    const cmd = `add-generic-password -U -s ${keychainQuote(this.service)} -a ${keychainQuote(key)} -l ${keychainQuote(`${this.service} ${key}`)} -w ${keychainQuote(value)}\n`;
    const r = await run('security', ['-i'], { input: cmd, allowFailure: true, timeoutMs: 20000 });
    if (r.code !== 0 || /error/i.test(r.stderr)) {
      throw new Error(`Keychain 저장 실패: ${r.stderr.trim()}`);
    }
  }

  async delete(key: string): Promise<void> {
    await run('security', ['delete-generic-password', '-s', this.service, '-a', key], {
      allowFailure: true,
      timeoutMs: 20000,
    });
  }
}

const WIN_CRED_PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RvCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);
  public static void Write(string target, string secret) {
    byte[] b = Encoding.Unicode.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.Persist = 2; c.UserName = "RepoVault";
    c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
    try { if (!CredWrite(ref c, 0)) throw new Exception("CredWrite " + Marshal.GetLastWin32Error()); }
    finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static string Read(string target) {
    IntPtr p; if (!CredRead(target, 1, 0, out p)) return null;
    try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); }
    finally { CredFree(p); }
  }
}
"@
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
switch ($in.op) {
  'get' { $v = [RvCred]::Read($in.target); if ($v -ne $null) { [Console]::Out.Write($v) } else { exit 3 } }
  'set' { [RvCred]::Write($in.target, $in.value) }
  'delete' { [void][RvCred]::CredDelete($in.target, 1, 0) }
}
`;

export class WindowsCredentialStore implements CredentialStore {
  readonly kind = 'windows-credential-manager';
  constructor(private readonly service = CREDENTIAL_SERVICE) {}
  private target(key: string) {
    return `${this.service}:${key}`;
  }
  private async ps(payload: Record<string, string>) {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_CRED_PS], {
      input: JSON.stringify(payload),
      allowFailure: true,
      timeoutMs: 30000,
    });
  }
  async get(key: string) {
    const r = await this.ps({ op: 'get', target: this.target(key) });
    return r.code === 0 ? r.stdout : null;
  }
  async set(key: string, value: string) {
    const r = await this.ps({ op: 'set', target: this.target(key), value });
    if (r.code !== 0) throw new Error(`Credential Manager 저장 실패: ${r.stderr.trim()}`);
  }
  async delete(key: string) {
    await this.ps({ op: 'delete', target: this.target(key) });
  }
}

/**
 * OS 보안 저장소가 없는 환경(Linux 등)용 폴백. 0600 권한 파일. 기본값으로 쓰지 않는다.
 */
export class FileCredentialStore implements CredentialStore {
  readonly kind = 'file-0600';
  constructor(private readonly path: string) {}
  private read(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    return JSON.parse(readFileSync(this.path, 'utf8'));
  }
  private write(data: Record<string, string>) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
  async get(key: string) {
    return this.read()[key] ?? null;
  }
  async set(key: string, value: string) {
    const d = this.read();
    d[key] = value;
    this.write(d);
  }
  async delete(key: string) {
    const d = this.read();
    delete d[key];
    this.write(d);
  }
}

export function createCredentialStore(fallbackFile: string, platform = process.platform): CredentialStore {
  if (process.env.REPOVAULT_CREDENTIAL_BACKEND === 'file') return new FileCredentialStore(fallbackFile);
  if (platform === 'darwin') return new MacKeychainStore();
  if (platform === 'win32') return new WindowsCredentialStore();
  return new FileCredentialStore(fallbackFile);
}
