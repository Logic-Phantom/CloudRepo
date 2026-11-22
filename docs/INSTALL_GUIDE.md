# 설치 / 사용 / 마이그레이션 가이드

## 요구 사항
- macOS 13+ 또는 Windows 10/11
- Git 2.30+ (필수), Git LFS (LFS 저장소가 있을 때 권장)
- Node.js 22.13+ (CLI/개발 실행 시. 패키징된 앱은 불필요)
- GitHub 인증: `gh auth login`, macOS 키체인/Git Credential Manager에 저장된 자격 증명, 또는 `repovault github set-token`

## 설치 (소스)
```bash
npm install
npm run build
npm test            # Mock Drive 기반 전체 테스트
```

## 최초 설정
```bash
node dist/cli/main.js setup google --client-json ~/Downloads/client_secret_XXXX.json
node dist/cli/main.js auth login
node dist/cli/main.js github status
node dist/cli/main.js repos list
node dist/cli/main.js backup                     # 첫 전체 백업
node dist/cli/main.js schedule install --time 03:00
```

## 데스크톱 앱
```bash
npm start            # 빌드 후 Electron 실행
npm run dist:mac     # macOS DMG (release/)
npm run dist:win     # Windows NSIS 설치 파일 (Windows에서 실행 권장)
```
패키징된 앱은 `RepoVault --run-backup-agent` 로 GUI 없이 백업을 수행하며, 설정 화면의 "스케줄 등록"이 이 명령을 OS 스케줄러에 등록합니다.

## 자동 실행
| OS | 등록 위치 | 동작 |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.repovault.daily-backup.plist` | 매일 지정 시각 + 로그인 시(누락분만) |
| Windows | 작업 스케줄러 `\RepoVault\DailyBackup` | 매일 + 로그온 5분 후, StartWhenAvailable, 관리자 권한 불필요 |

해제: `node dist/cli/main.js schedule uninstall` (Drive 백업은 유지)

## Legacy Migration (기존 로컬 bare 백업 → Drive)
```bash
node dist/cli/main.js migrate-legacy /path/to/old-backups --dry-run   # 대상 확인
node dist/cli/main.js migrate-legacy /path/to/old-backups             # 업로드·검증·Manifest 등록
```
기존 로컬 데이터는 삭제하지 않습니다. 모든 대상의 업로드와 `verify` 통과를 확인한 뒤 직접 정리하세요.

## 앱 제거
1. `node dist/cli/main.js schedule uninstall`
2. (선택) `node dist/cli/main.js auth logout --revoke` — Google 측 권한 회수 + Keychain 토큰 삭제
3. 앱/소스 폴더 삭제. `~/Library/Caches/RepoVault/work` 에 남은 폴더가 있다면 **아직 Drive에 올라가지 않은 임시 데이터**입니다(`pending list`로 확인).

Google Drive의 `Git` 폴더와 백업 파일은 어떤 경우에도 앱이 삭제하지 않습니다.
