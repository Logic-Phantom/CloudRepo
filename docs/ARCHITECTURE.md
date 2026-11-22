# RepoVault 아키텍처

## 기술 스택과 선택 이유
| 영역 | 사용 | 비고 |
|---|---|---|
| Desktop | **Electron 45** | 프롬프트 권장안은 Tauri+Rust였으나, 개발 PC에 Rust 툴체인이 없어 사용자 결정으로 Electron + TypeScript 채택. 모듈 경계는 권장 아키텍처와 1:1로 유지 |
| Frontend | React 19 + TypeScript + Vite 8 + Tailwind CSS 4 + Lucide | 다크 모드 기본, 한국어 UI |
| Core Engine | Node.js(TypeScript, ESM) | UI와 완전히 분리 — CLI/GUI/백그라운드 에이전트가 같은 엔진 사용 |
| Local cache | `node:sqlite` (내장 SQLite) | 네이티브 모듈 의존성 없음. **캐시 전용** |
| Git | 시스템 Git CLI (인자 배열 실행) | Shell 문자열 조합 금지 |
| Cloud | Google Drive API v3 (fetch 직접 호출) | OAuth Desktop + PKCE S256, Resumable Upload |
| Credentials | macOS Keychain(`security`), Windows Credential Manager(CredWrite) | 비밀값은 argv가 아닌 stdin으로 전달 |
| Scheduler | macOS LaunchAgent / Windows Task Scheduler | GUI 종료와 무관 |
| Test | Vitest + Mock Drive v3 HTTP 서버 + 임시 bare repo | 실제 계정 없이 42개 시나리오 검증 |

## 모듈 구조
```text
src/
├── core/                          # UI 독립 엔진
│   ├── git/
│   │   ├── git-engine.ts          # GitEngine: 비대화형 git 실행, 토큰은 GIT_CONFIG_* 환경변수 헤더로 주입
│   │   ├── change-detector.ts     # ChangeDetector: ls-remote 기반 변경 감지(fetch 없이)
│   │   ├── snapshot-engine.ts     # SnapshotEngine + BundleBuilder: Ref 보호/강제푸시 보존/bundle/fsck/로컬 복원테스트
│   │   ├── lfs-engine.ts          # LfsBackupEngine: LFS 감지, fetch --all, tar.zst 아카이브
│   │   ├── submodules.ts          # Submodule 메타데이터
│   │   ├── restore-engine.ts      # RestoreEngine: Drive 단독 복원
│   │   └── temp-workspace.ts      # TempWorkspaceManager: 작업 단위 scratch + job.json(재시도 상태)
│   ├── cloud/
│   │   ├── oauth.ts               # GoogleOAuthManager (PKCE, loopback, state, refresh)
│   │   ├── drive-client.ts        # GoogleDriveClient (재시도/백오프/401 갱신)
│   │   ├── folder-manager.ts      # DriveFolderManager (ID 기반, 루트 중복 감지)
│   │   ├── manifest.ts            # DriveManifestManager + CloudIndexReconciler
│   │   ├── upload-manager.ts      # ResumableUploadManager + CloudIntegrityVerifier
│   │   ├── download-manager.ts    # CloudRestoreDownloader
│   │   └── quota.ts               # CloudQuotaManager
│   ├── providers/                 # GitHubAdapter / GitLabAdapter / GenericGitAdapter
│   ├── agent/                     # BackupWorker, UploadRetryWorker, Lock, Legacy Migration
│   ├── scheduler/                 # macos.ts / windows.ts (OS별 분리)
│   ├── database/cache.ts          # SQLite 캐시 (재생성 가능)
│   ├── security/credential-store.ts
│   ├── discovery.ts               # RepositoryDiscovery
│   ├── context.ts / service.ts / config.ts / types.ts
├── cli/main.ts                    # `repovault` CLI + `--run-backup-agent`
├── electron/                      # main.ts(IPC, 에이전트 모드), preload.cts(최소 API 노출)
└── frontend/                      # React UI (Dashboard, Repositories, CloudHistory, CloudRestore, DriveManager, Settings)
```

## 백업 흐름
```text
[OS Scheduler / 수동] → 락 → Drive 인증·구조 확인 → (캐시 비었으면) Drive 인덱스 → SQLite
 → 미전송(Pending) 스냅샷 우선 재업로드
 → 저장소 목록 갱신 (API 실패를 삭제로 오판하지 않음)
 → 저장소별:
     ls-remote ⇄ 이전 스냅샷 refs.json 비교 ─ 동일 → 생략(마지막 확인 시각만 갱신)
     └ 변경 → 임시 bare repo → fetch heads/tags
             → 삭제/강제변경 ref를 refs/repovault/preserved/<시각-id>/... 로 보호
               (과거 객체가 없으면 이전 Drive 스냅샷 bundle을 받아 검증 후 import)
             → fsck → bundle create/verify → 새 bare로 import해 ref 일치 확인(복원 테스트)
             → LFS/Submodule/refs.json/checksums.sha256 스테이징, git 작업 디렉터리 즉시 삭제
             → 용량 검사 → Resumable Upload(bundle→lfs→refs→submodules→checksums)
             → 각 파일 size + sha256Checksum 검증(없으면 재다운로드 해시)
             → manifest.json(completed) 마지막 게시 → 저장소 인덱스/백업 인덱스 병합 갱신
             → 임시 작업 공간 삭제
 → 작업 로그 Drive logs/cloud-backup/YYYY-MM/ 업로드, 장치 정보 갱신
```

## 동시성 / 일관성
- Snapshot ID = UUID, 폴더명 `{UTC}_{uuid}`, manifest에 device_id 포함 → 다중 PC 충돌 없음
- 스냅샷 파일과 manifest.json은 **불변**(덮어쓰지 않음)
- Drive v3에는 조건부 쓰기(CAS)가 없으므로 인덱스는 *읽기→병합(합집합)→쓰기→재조회 검증→재시도*
- 인덱스가 손상/유실돼도 `drive rebuild`가 모든 `manifest.json`에서 재구축
- 같은 PC 중복 실행은 O_EXCL 락 파일(죽은 PID 자동 회수) + Task Scheduler `IgnoreNew`
