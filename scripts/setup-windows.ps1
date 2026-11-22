# RepoVault Windows 설정: 의존성 확인 → 빌드 → 테스트
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git for Windows가 필요합니다: https://git-scm.com/download/win' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22.13+ 가 필요합니다' }
if (-not (Get-Command git-lfs -ErrorAction SilentlyContinue)) { Write-Warning 'git-lfs 미설치: LFS 파일은 백업되지 않습니다' }

npm install
npm run build
npm test

Write-Host ''
Write-Host '다음 단계:'
Write-Host '  node dist/cli/main.js setup google --client-json <client_secret.json>'
Write-Host '  node dist/cli/main.js auth login'
Write-Host '  node dist/cli/main.js backup'
Write-Host '  node dist/cli/main.js schedule install --time 03:00'
