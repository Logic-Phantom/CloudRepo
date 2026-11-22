# PC가 꺼져 있어도 백업하기 (클라우드 러너)

## 검토 결과
| 방법 | PC 꺼짐에도 동작 | 비용 | 판단 |
|---|---|---|---|
| macOS LaunchAgent / Windows 작업 스케줄러 (기존) | ✗ — 켜진 뒤 누락분 보충만 가능 | 무료 | PC가 켜져 있을 때의 기본 경로로 유지 |
| macOS `pmset` 예약 깨우기 | △ — 잠자기만 가능, 전원 꺼짐·덮개 닫힘·배터리 상황 제약 | 무료 | 신뢰도 낮아 제외 |
| 항상 켜진 서버/NAS/VPS | ✓ | 서버 비용·관리 | 필요 시 같은 CLI로 가능 (아래 "다른 러너") |
| **GitHub Actions 예약 워크플로** | **✓ — GitHub 서버에서 실행** | **공개 저장소는 무료** | **채택** |

GitHub Actions는 GitHub 서버에서 돌기 때문에 PC 전원과 무관합니다. 매일 03:30(KST)에 RepoVault 에이전트가 실행되어 **같은 Google Drive `Git` 폴더**에 백업합니다.

## 동작 방식
- 매 실행마다 새 가상 머신 → 로컬 캐시 없음 → Drive 인덱스에서 상태를 읽고, ls-remote로 **Drive의 마지막 스냅샷과 비교**해 바뀐 저장소만 백업합니다.
- 그래서 PC(03:00)와 클라우드(03:30)가 같은 날 모두 돌아도 중복 스냅샷이 생기지 않습니다. 먼저 돈 쪽이 백업하고, 다음 쪽은 "변경 없음"으로 끝납니다.
- 장치 ID `github-actions`로 기록되어 Drive `manifest/devices/` 에서 구분됩니다.
- 공개 저장소 Actions 로그에는 **요약 숫자만** 출력하고 저장소 이름은 남기지 않습니다. 상세 로그는 Drive `Git/logs/cloud-backup/` 에 저장됩니다.
- 실패나 업로드 대기가 있으면 워크플로가 실패로 끝나 GitHub이 이메일로 알려줍니다.
- Ubuntu 러너에는 git-lfs가 있어 **LFS 객체도 백업**됩니다.
- 60일 동안 저장소 활동이 없으면 GitHub이 예약 워크플로를 끄므로, 매 실행 끝에 워크플로를 다시 활성화(keepalive)합니다.

## 설정 (1회)
```bash
npm run build
node scripts/setup-cloud-backup.mjs --run
```
이 스크립트는 이 PC의 Keychain과 설정에서 값을 읽어 GitHub 저장소 공개키로 암호화한 뒤 **Actions Secrets**에 등록합니다. 값은 화면에 출력되지 않습니다.

| Secret | 내용 |
|---|---|
| `REPOVAULT_GOOGLE_CLIENT_ID` | OAuth Client ID |
| `REPOVAULT_GOOGLE_CLIENT_SECRET` | Desktop 앱 client secret(공개 클라이언트 값) |
| `REPOVAULT_GOOGLE_REFRESH_TOKEN` | Google Refresh Token — `drive.file` 범위라 RepoVault가 만든 파일만 접근 가능 |
| `REPOVAULT_GITHUB_TOKEN` | private 저장소를 읽을 GitHub 토큰 |

### 권장: 백업 전용 읽기 토큰
기본값은 PC에 저장된 GitHub 자격증명을 재사용합니다. 더 안전하게 하려면 GitHub → Settings → Developer settings → **Fine-grained token**:
- Repository access: **All repositories**
- Permissions: **Contents: Read-only** (Metadata: Read-only는 자동)

```bash
pbpaste | node scripts/setup-cloud-backup.mjs --backup-token-stdin --run
```

수동 실행/로그: 저장소 → **Actions → RepoVault Cloud Backup → Run workflow**

## 주의
- PC에서 `auth logout --revoke` 를 하면 같은 Refresh Token을 쓰는 클라우드 백업도 멈춥니다. 다시 연결한 뒤 스크립트를 다시 실행하세요.
- GitHub 토큰이 만료되면 워크플로가 실패 메일을 보냅니다. 새 토큰으로 스크립트를 다시 실행하세요.
- 중지: 저장소 → Actions → RepoVault Cloud Backup → `…` → Disable workflow (Drive 백업은 그대로 유지).

## 다른 러너 (항상 켜진 서버/NAS)
같은 방식으로 어디서나 실행할 수 있습니다.
```bash
REPOVAULT_CREDENTIAL_BACKEND=env REPOVAULT_DEVICE_ID=my-nas \
REPOVAULT_GOOGLE_CLIENT_ID=... REPOVAULT_SECRET_GOOGLE_CLIENT_SECRET=... \
REPOVAULT_SECRET_GOOGLE_REFRESH_TOKEN=... REPOVAULT_SECRET_GITHUB_TOKEN=... \
node dist/cli/main.js --run-backup-agent --trigger cloud
```
