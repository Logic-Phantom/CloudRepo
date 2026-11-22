#!/usr/bin/env bash
# RepoVault macOS 설정: 의존성 확인 → 빌드 → 테스트 → (선택) 스케줄 등록
set -euo pipefail
cd "$(dirname "$0")/.."

command -v git >/dev/null || { echo "Git이 필요합니다 (xcode-select --install)"; exit 1; }
command -v node >/dev/null || { echo "Node.js 22.13+ 가 필요합니다"; exit 1; }
command -v git-lfs >/dev/null || echo "⚠ git-lfs 미설치: LFS 저장소의 실제 파일은 백업되지 않습니다 (brew install git-lfs)"

npm install
npm run build
npm test

echo
echo "다음 단계:"
echo "  node dist/cli/main.js setup google --client-json <client_secret.json>"
echo "  node dist/cli/main.js auth login"
echo "  node dist/cli/main.js backup"
echo "  node dist/cli/main.js schedule install --time 03:00"
