#!/usr/bin/env node
/**
 * PC가 꺼져 있어도 백업되도록 GitHub Actions(클라우드 러너)에 RepoVault Secrets를 등록한다.
 * - 값은 이 PC의 OS 자격증명 저장소(Keychain/Credential Manager)와 config.json 에서 읽고
 * - GitHub 저장소 공개키로 암호화(libsodium sealed box)해 Actions Secrets API로 전송한다.
 * - 어떤 비밀값도 화면/로그에 출력하지 않는다.
 *
 * 사용법 (프로젝트 루트에서, `npm run build` 이후):
 *   node scripts/setup-cloud-backup.mjs                         # 현재 GitHub 자격증명을 백업용 토큰으로도 사용
 *   node scripts/setup-cloud-backup.mjs --backup-token-stdin < token.txt   # 백업 전용(읽기 전용) 토큰 권장
 *   옵션: --repo owner/name (기본 Logic-Phantom/CloudRepo), --run (등록 후 즉시 1회 실행)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sodium from 'libsodium-wrappers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = (p) => import(join(root, 'dist', 'core', p));
const { resolveAppPaths } = await core('utils/paths.js');
const { createCredentialStore, CredentialKeys } = await core('security/credential-store.js');
const { resolveGitHubToken } = await core('providers/github.js');

const args = process.argv.slice(2);
const repoIdx = args.indexOf('--repo');
const repo = repoIdx >= 0 ? args[repoIdx + 1] : 'Logic-Phantom/CloudRepo';
const runNow = args.includes('--run');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const paths = resolveAppPaths();
const cfg = JSON.parse(readFileSync(paths.configFile, 'utf8'));
const creds = createCredentialStore(join(paths.dataDir, 'credentials.json'));

const clientId = cfg.google?.client_id;
const clientSecret = await creds.get(CredentialKeys.googleClientSecret);
const refreshToken = await creds.get(CredentialKeys.googleRefreshToken);
if (!clientId || !refreshToken) {
  console.error('✖ 이 PC에서 먼저 Google 연결을 완료하세요: node dist/cli/main.js auth login');
  process.exit(1);
}

const admin = await resolveGitHubToken(creds);
if (!admin) {
  console.error('✖ GitHub 자격증명을 찾지 못했습니다 (gh auth login 또는 repovault github set-token).');
  process.exit(1);
}
let backupToken = admin.token;
if (args.includes('--backup-token-stdin')) {
  backupToken = await readStdin();
  if (!backupToken) {
    console.error('✖ stdin으로 백업용 GitHub 토큰을 전달하세요.');
    process.exit(1);
  }
} else {
  console.log(`⚠ 백업용 GitHub 토큰으로 현재 자격증명(${admin.source})을 사용합니다.`);
  console.log('  더 안전하게: Contents=Read-only, 모든 저장소 대상 fine-grained 토큰을 만들어 --backup-token-stdin 으로 전달하세요.');
}

// 등록 전에 백업용 토큰 검증: 유효성(401) + 코드 읽기(Contents) 권한
{
  const { GitHubAdapter } = await core('providers/github.js');
  const gh = new GitHubAdapter(backupToken);
  let login;
  try {
    login = (await gh.currentUser()).login;
  } catch {
    console.error('✖ 백업용 GitHub 토큰이 유효하지 않습니다(401). 클립보드에 토큰이 정확히 복사됐는지, 만료되지 않았는지 확인하세요. 아무것도 등록하지 않았습니다.');
    process.exit(1);
  }
  const repos = await gh.listRepositories({ includeOrgs: [], includeCollaborator: false, includeArchived: true, includeForks: true });
  const probe = repos.find((r) => r.private) ?? repos[0];
  if (!probe) {
    console.error('✖ 토큰으로 접근 가능한 저장소가 없습니다. Repository access를 "All repositories"로 설정하세요.');
    process.exit(1);
  }
  if (!(await gh.checkContentsAccess(probe.owner, probe.name))) {
    console.error('✖ 토큰에 코드 읽기 권한이 없습니다. Repository permissions → Contents: Read-only 를 추가하세요. 아무것도 등록하지 않았습니다.');
    process.exit(1);
  }
  console.log(`✔ 백업용 토큰 확인: ${login}, 접근 가능 저장소 ${repos.length}개 (private ${repos.filter((r) => r.private).length}개), 코드 읽기 권한 OK`);
}

const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${admin.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'RepoVault-Setup',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub API ${method} ${path} → ${res.status}`);
  return res.status === 204 || res.status === 201 ? null : res.json();
};

await sodium.ready;
const { key, key_id } = await api('GET', '/actions/secrets/public-key');
const pub = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
const seal = (v) => sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(v), pub), sodium.base64_variants.ORIGINAL);

const secrets = {
  REPOVAULT_GOOGLE_CLIENT_ID: clientId,
  REPOVAULT_GOOGLE_REFRESH_TOKEN: refreshToken,
  REPOVAULT_GITHUB_TOKEN: backupToken,
  ...(clientSecret ? { REPOVAULT_GOOGLE_CLIENT_SECRET: clientSecret } : {}),
};
for (const [name, value] of Object.entries(secrets)) {
  await api('PUT', `/actions/secrets/${name}`, { encrypted_value: seal(value), key_id });
  console.log(`✅ ${name} 등록`);
}
console.log(`\n${repo} 의 GitHub Actions가 매일 03:30(KST)에 PC와 무관하게 Google Drive로 백업합니다.`);

if (runNow) {
  await api('POST', '/actions/workflows/cloud-backup.yml/dispatches', { ref: 'main' });
  console.log(`▶ 1회 실행을 요청했습니다: https://github.com/${repo}/actions/workflows/cloud-backup.yml`);
}
