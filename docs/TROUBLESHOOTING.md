# 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| `Google 재인증이 필요합니다` | Refresh Token 만료·취소. `auth login` 재실행. 7일마다 반복되면 OAuth 동의 화면을 **In production**으로 게시 ([설정 가이드 7절](GOOGLE_DRIVE_SETUP.md)) |
| `RepoVault 루트 폴더가 N개 발견` | 자동 병합하지 않습니다. `drive select-root <folderId>` 로 사용할 폴더 지정 |
| `Google Drive 저장 공간이 부족` | 신규 업로드만 중단, 기존 백업·미전송 데이터 유지. 공간 확보 후 `backup` 재실행 시 대기분부터 업로드 |
| `업로드 미완료 — 다음 실행에서 재시도` | 네트워크/5xx. `pending list`로 확인, `backup`으로 즉시 재시도 |
| `원격 접근 실패(auth_error)` | GitHub 토큰 만료. `gh auth login` 또는 `github set-token`. Drive 백업은 유지 |
| `원격 목록에서 사라짐` | GitHub에서 저장소 삭제/권한 상실. Drive 백업은 그대로 보존 |
| `LFS 객체를 백업하지 못했습니다` | git-lfs 미설치. `brew install git-lfs` / Git for Windows 설치 후 다음 변경 시 반영 (`backup --repo <id> --force`로 즉시) |
| 자동 백업이 안 돌아감 (macOS) | `schedule status`, `~/Library/Logs/RepoVault/agent.err.log` 확인 |
| 자동 백업이 안 돌아감 (Windows) | 작업 스케줄러 → `RepoVault\DailyBackup` 기록 확인 |
| 로컬 캐시가 이상함 | `cache.sqlite` 삭제 후 `drive resync` (또는 `drive rebuild`) |

로그 위치: macOS `~/Library/Logs/RepoVault/jobs/*.jsonl`, Drive `Git/logs/cloud-backup/`. 모든 로그는 토큰·비밀번호·세션 URI를 제거한 뒤 기록됩니다.
