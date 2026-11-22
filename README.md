# RepoVault — Google Drive 단일 저장소 Git 자동 백업·복원

GitHub(공개 + **private**) 및 일반 Git 원격 저장소를 **매일 자동으로 Google Drive(`My Drive/Git`)에 백업**하고,
다른 PC에서 **Google Drive만으로 복원**하는 Windows/macOS 데스크톱 애플리케이션입니다.

- 영구 백업 위치는 **Google Drive 하나뿐** (로컬은 작업 중 임시 공간만 사용, 업로드·검증 후 자동 삭제)
- **GitHub에서 저장소/브랜치/태그를 삭제하거나 강제 푸시해도 Drive에는 과거 상태가 남습니다**
- GUI를 꺼도 OS 스케줄러(macOS LaunchAgent / Windows 작업 스케줄러)가 매일 백업
- **PC가 꺼져 있어도 GitHub Actions(클라우드 러너)가 매일 백업** — [docs/CLOUD_RUNNER.md](docs/CLOUD_RUNNER.md)
- Google OAuth Desktop + PKCE(S256), 최소 권한 `drive.file`, 토큰은 Keychain/Credential Manager에만 저장

```text
GitHub / GitLab / Git Remote
   → 임시 bare repo → ls-remote 변경 감지 → 삭제/강제변경 Ref 보호
   → git bundle + LFS tar.zst + refs.json + checksums.sha256
   → Google Drive Resumable Upload → size + SHA-256 검증 → manifest.json(completed) 게시
   → 인덱스 병합 갱신 → 로컬 임시 공간 정리
```

## 빠른 시작
```bash
npm install && npm run build
node dist/cli/main.js setup google --client-json ~/Downloads/client_secret_XXXX.json   # Google Cloud Console에서 받은 Desktop 앱 JSON
node dist/cli/main.js auth login            # 브라우저 인증 → My Drive/Git 생성
node dist/cli/main.js repos list            # GitHub 저장소(private 포함) 자동 탐색
node dist/cli/main.js backup                # 지금 백업
node dist/cli/main.js schedule install --time 03:00   # 매일 자동 백업 등록
npm start                                   # 데스크톱 앱(GUI)
```
Google Cloud Console 설정은 [docs/GOOGLE_DRIVE_SETUP.md](docs/GOOGLE_DRIVE_SETUP.md)를 따라 주세요.
**동의 화면을 `In production`으로 게시하지 않으면 Refresh Token이 7일 후 만료되어 자동 백업이 멈춥니다.**

## 주요 명령
| 명령 | 설명 |
|---|---|
| `status` | Drive 연결/스케줄/마지막 작업/업로드 대기 요약 |
| `backup [--repo id] [--force]` | 지금 백업 (변경 없는 저장소는 자동 생략) |
| `history [--repo id]` | 스냅샷 기록 |
| `restore <repoId> --dest <빈 폴더> [--snapshot id] [--ref ...]` | Drive 단독 복원 |
| `verify <repoId>` | Drive에서 내려받아 실제 복원 테스트 |
| `drive status \| resync \| rebuild` | 용량, 인덱스 재동기화/재구축 |
| `repos add <url>` / `repos exclude <id>` | 수동 Remote 등록 / 백업 제외 |
| `schedule install \| uninstall \| status` | 자동 백업 |
| `pending list` | 아직 Drive에 올라가지 않은 임시 데이터 |
| `hq set --url <HQ> \| status \| test \| clear` | AutoMateHQ에 백업 결과 보고(Heartbeat 키는 stdin → Keychain) |
| `migrate-legacy <path>` | 기존 로컬 bare 백업 → Drive 이전 |

## 문서
- [아키텍처](docs/ARCHITECTURE.md) · [Cloud-Only 정책 / Drive 구조](docs/CLOUD_ONLY_BACKUP.md)
- [PC가 꺼져 있어도 백업 (클라우드 러너)](docs/CLOUD_RUNNER.md)
- [Google Cloud Console 설정](docs/GOOGLE_DRIVE_SETUP.md) · [설치/사용/마이그레이션](docs/INSTALL_GUIDE.md)
- [복원 가이드](docs/RESTORE_GUIDE.md) · [문제 해결](docs/TROUBLESHOOTING.md)

## 프로젝트 구조
```text
src/core/      엔진 (git · cloud · providers · agent · scheduler · database · security)
src/cli/       CLI + 백그라운드 에이전트 진입점 (--run-backup-agent)
src/electron/  Electron 메인/프리로드 (GUI 프로세스와 엔진 분리)
src/frontend/  React UI: Dashboard / Repositories / CloudHistory / CloudRestore / DriveManager / Settings
tests/         git · cloud · upload · restore · scheduler · integration (Mock Drive v3 서버)
docs/  scripts/
```

## 테스트
```bash
npm test
```
실제 Google 계정 없이 **Mock Google Drive v3 HTTP 서버**와 임시 bare 저장소로 검증합니다 (현재 **46개 통과**).

| 영역 | 검증 시나리오 |
|---|---|
| Git 백업 | 최초 백업, 변경 없음 생략, 새 커밋/브랜치 감지, **브랜치 삭제 후 과거 커밋 보존**, **강제 푸시 + gc 후 이전 커밋 복구**, 태그 추가/삭제, 원격 삭제 시 Drive 백업 유지, 빈 저장소, Submodule 메타데이터, 백업 후 임시 공간 비어 있음 |
| Upload | 멀티 청크 Resumable, 응답 유실 후 상태조회·재개, 세션 만료 → 새 세션, 앱 재시작 후 저장 세션으로 재개, 중복 업로드 방지, SHA-256 불일치·스테이징 손상 탐지, sha256 미제공 시 재다운로드 검증, 401 토큰 갱신, 429/5xx 백오프, 용량 부족 |
| OAuth | PKCE S256, drive.file/offline 인증 URL, loopback 코드 수신·state 검증, Refresh Token 저장 위치, invalid_grant → 재인증 |
| Drive 구조 | `My Drive/Git` 표준 구조 생성, 새 PC에서 동일 폴더 탐색, 루트 중복 시 자동 병합 금지, 삭제된 폴더 ID 재검색, **두 기기 동시 인덱스 갱신 무손실** |
| 복원 | **로컬 데이터·원격 모두 없는 새 PC에서 Drive만으로 복원** (브랜치/태그/커밋 해시 일치), 특정 브랜치만, 비어있지 않은 폴더 거부, 손상 Bundle 중단, 인덱스 유실 시 manifest로 재구축 |
| 통합 | 에이전트 전체 실행 후 임시 데이터 0, 로그/장치정보 Drive 보관, 업로드 실패 시 Pending 유지→재시도 후 정리, 용량 부족 안전 중단, SQLite 삭제 후 재구축, 중복 실행 락 |

## 남은 제한 사항
- **기술 스택**: 프롬프트 권장안(Tauri 2 + Rust) 대신 **Electron + TypeScript** — 개발 PC에 Rust가 없고 설치가 허용되지 않아 사용자 결정으로 변경. 모듈 경계는 권장 구조와 동일.
- **Windows**: Credential Manager·작업 스케줄러 코드는 구현됐지만 이 저장소의 테스트는 macOS에서만 실행됨 (XML 생성은 단위 테스트). Windows 실기기 검증 필요.
- **Git LFS**: 이 PC에 git-lfs 미설치 → LFS 사용 저장소는 `lfs_status=tool_missing`으로 표시(Git 커밋은 정상 백업). LFS 아카이브/복원 경로는 실기기 E2E 미검증.
- **Incremental Snapshot**: 프롬프트 지침대로 Full Snapshot 우선 구현, Incremental은 미구현(기본 OFF 항목).
- **클라이언트 측 암호화**(선택 기능) 미구현.
- 설치 패키지(DMG/NSIS) 빌드 스크립트는 구성했으나 코드 서명·공증은 미적용.

---

## 작업 내역

### 2026-11-22 — v0.1.0 최초 구현
- 프로젝트 구조 구성 (core / cli / electron / frontend / tests / docs / scripts)
- **Core 엔진**: GitEngine(비대화형·토큰 헤더 주입), ls-remote 변경 감지, Full Snapshot(Ref 보호 네임스페이스 `refs/repovault/preserved/*`, 필요 시 이전 Drive bundle에서 과거 객체 복구), bundle verify + fsck + 업로드 전 로컬 복원 테스트, LFS(tar.zst) / Submodule 메타데이터
- **Google Drive 계층**: OAuth Desktop(PKCE S256·loopback·state·refresh·재인증), Drive v3 클라이언트(401 갱신·429/5xx 백오프), ID 기반 폴더 관리(루트 중복 감지), Resumable Upload(세션 재개·만료 처리·중복 방지·SHA-256 검증), 용량 사전 검사, 인덱스 병합·재조회 검증·manifest 기반 재구축
- **백그라운드 에이전트**: 중복 실행 락, 미전송 데이터 우선 재시도, 원격 목록 변경 처리(삭제 ≠ 오류), 작업 로그·장치 정보 Drive 보관, 누락 실행 보충 판정
- **스케줄러**: macOS LaunchAgent(매일 + RunAtLoad 보충), Windows Task Scheduler XML(StartWhenAvailable, IgnoreNew, LeastPrivilege)
- **Provider**: GitHub(페이지네이션, private/archived/fork/조직 옵션, gh·키체인 토큰 자동 탐색), GitLab, Generic Remote(URL 토큰 제거)
- **복원**: Drive 단독 복원, 특정 시점/브랜치/태그, origin 재설정, 비파괴 push(dry-run 기본)
- **GUI**: Electron + React 대시보드/저장소/백업 기록/복원/Drive 관리/설정 (한국어, 다크 모드)
- **CLI**: setup / auth / github / repos / backup / history / restore / verify / drive / schedule / pending / migrate-legacy / status
- 테스트 42개 작성·통과, 문서 6종 작성
- 실제 GitHub 계정에서 private 포함 저장소 36개 탐색 및 private 저장소 인증 fetch 확인

### 2026-11-22 — AutoMateHQ 백업 결과 보고
- 백업 에이전트가 실행 시작·결과를 AutoMateHQ Heartbeat로 보고(`src/core/agent/hq-reporter.ts`). 설정이 없으면 아무것도 보내지 않고, HQ 전송 실패는 백업 결과에 영향 없음
- 판정: 전부 백업/변경 없음 → complete. 실패·업로드 대기 → fail(`BACKUP_PARTIAL`·`UPLOAD_PENDING`), 작업 실패 → fail(`BACKUP_FAILED`·`DRIVE_REAUTH`). 원격에서 사라진 저장소는 실패로 보지 않음. 이미 완료된 날의 보충 실행·중복 실행은 보고 안 함
- `hq set|status|test|clear` CLI, 키는 OS 자격증명 저장소(`hq-heartbeat-secret`)에만 저장. 테스트 4개 추가(총 46개 통과)

### 2026-11-22 — 실제 Google Drive 연동 및 운영 시작
- Google Cloud 프로젝트 `RepoVault` 생성, Drive API 활성화, OAuth 동의 화면(외부) 구성 및 **프로덕션 게시**(Refresh Token 7일 만료 방지), Desktop OAuth Client 발급
- 개인정보처리방침 [docs/PRIVACY.md](docs/PRIVACY.md) 추가 (동의 화면 게시 요건)
- Google 계정 연결 → `My Drive/Git` 폴더 구조 자동 생성
- **첫 전체 백업: GitHub 저장소 36개(private 포함) 모두 Drive 스냅샷 생성 성공, 실패·업로드 대기 0건, 로컬 임시 데이터 0** (Drive 사용 약 2.3 GB)
- 실제 Drive에서 private 저장소(`chiply`)를 내려받아 복원 검증 통과 (`verify`)
- macOS LaunchAgent 등록: 매일 03:00 자동 백업 + 로그인 시 누락분 보충

### 2026-11-22 — PC가 꺼져 있어도 백업 (클라우드 러너)
- 검토: OS 스케줄러는 PC가 켜져야 동작, `pmset` 깨우기는 전원 꺼짐 불가 → **GitHub Actions 예약 워크플로** 채택 (공개 저장소 무료, GitHub 서버에서 실행)
- `.github/workflows/cloud-backup.yml`: 매일 03:30 KST, Drive 기준 변경 감지라 PC 백업과 중복 스냅샷 없음, LFS 포함, 60일 비활성화 방지 keepalive
- 환경 변수 자격 증명(`REPOVAULT_CREDENTIAL_BACKEND=env`), 공개 로그에 private 저장소 이름 미출력, 실패 시 워크플로 실패(메일 알림)
- `scripts/setup-cloud-backup.mjs`: Keychain 값을 암호화해 Actions Secrets 등록 (값 미출력)
- 로컬에서 빈 환경 + 환경 변수만으로 실제 Drive 백업 시뮬레이션 성공 (36개 확인, 실패 0). 테스트 47개 통과
