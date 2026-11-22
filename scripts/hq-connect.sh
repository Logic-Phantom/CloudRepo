#!/bin/zsh
# AutoMateHQ Heartbeat 키를 화면·셸 기록에 남기지 않고 Keychain에 저장한 뒤 연결을 테스트한다.
# 사용: zsh scripts/hq-connect.sh [HQ 주소]
set -eu
cd "${0:A:h}/.."
HQ_URL="${1:-https://automatehq.dlacoaud96.workers.dev}"
printf 'Heartbeat 키를 붙여 넣거나 입력하고 Enter (화면에 표시되지 않음): '
IFS= read -rs KEY
printf '\n'
KEY="${KEY//[[:space:]]/}"
if [[ "$KEY" != hqhb_* ]]; then
  echo '❌ hqhb_로 시작하는 키가 아닙니다. 저장하지 않았습니다.'
  exit 1
fi
printf '%s' "$KEY" | node dist/cli/main.js hq set --url "$HQ_URL"
unset KEY
node dist/cli/main.js hq test
