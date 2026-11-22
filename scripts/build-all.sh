#!/usr/bin/env bash
# 타입 검사 → 테스트 → 빌드 → 현재 OS용 설치 패키지
set -euo pipefail
cd "$(dirname "$0")/.."
npm run typecheck
npm test
npm run build
case "$(uname -s)" in
  Darwin) npx electron-builder --mac ;;
  MINGW*|MSYS*|CYGWIN*) npx electron-builder --win ;;
  *) echo "패키징은 macOS/Windows에서 실행하세요." ;;
esac
