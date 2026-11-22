# Cloud-Only 백업 정책

**영구 백업 데이터의 유일한 저장소는 사용자의 Google Drive입니다.** 로컬 디스크는 작업 중 scratch로만 씁니다.

## Drive 구조 (`My Drive/Git/`)
```text
Git/
├── manifest/
│   ├── backup-index.json                 # 전체 저장소 요약 (최신 스냅샷, 용량, 상태)
│   ├── devices/device-{uuid}.json        # PC별 마지막 실행 정보
│   └── repository-index/{repo-id}.json   # 저장소별 전체 스냅샷 목록 + Drive 파일 ID
├── repositories/
│   ├── github/{owner}/{repo}/snapshots/{UTC}_{snapshot_id}/
│   │   ├── repository.bundle             # 전체 브랜치/태그/보호 ref (단독 복원 가능)
│   │   ├── lfs-objects.tar.zst           # (LFS 사용 시)
│   │   ├── refs.json                     # 원격 ref / 보호 ref / 변경 내역
│   │   ├── submodules.json
│   │   ├── checksums.sha256
│   │   └── manifest.json                 # 마지막에 게시 — completed 일 때만 복원 목록 표시
│   ├── gitlab/ …
│   └── custom/ …
├── logs/cloud-backup/YYYY-MM/  logs/cloud-restore/YYYY-MM/
└── system/schema-version.json, integrity-reports/
```

## GitHub에서 삭제해도 Drive에는 남습니다
- 저장소가 GitHub 목록에서 사라지면 `remote_missing`으로 표시만 하고 **Drive 백업은 그대로 둡니다.**
- 브랜치 삭제/강제 푸시/태그 삭제·이동 시 과거 커밋은 `refs/repovault/preserved/...`로 보호되어 **이후 모든 스냅샷에 계속 포함**됩니다.
- 인증 오류·API 오류·Rate Limit은 삭제로 판단하지 않습니다.
- 기본 보관 정책은 **무기한**이며 앱은 Drive 파일을 자동 삭제하지 않습니다(연결 해제/앱 제거 포함).

## 성공 판정 (`Cloud Backup Completed`)
업로드 API 성공 + fileId 확보 + 원격 크기 일치 + `sha256Checksum` 일치(미제공 시 재다운로드 해시) + 로컬 복원 테스트 통과 + manifest(completed) 게시 + 인덱스 반영. 하나라도 빠지면 `Pending`으로 남고 복원 목록에 나오지 않습니다.

## 로컬에 남는 것
| 경로 (macOS) | 내용 | 성격 |
|---|---|---|
| `~/Library/Application Support/RepoVault/config.json` | 비밀 아닌 설정 | 재생성 가능 |
| `~/Library/Application Support/RepoVault/cache.sqlite` | 캐시 | Drive에서 재구축 |
| `~/Library/Caches/RepoVault/work/{job}` | 임시 작업 공간 / **미전송 데이터** | 업로드·검증 후 자동 삭제 |
| Keychain `RepoVault` 항목 | Refresh Token, 업로드 세션 URI | OS 보안 저장소 |

Windows: `%APPDATA%\RepoVault`, `%LOCALAPPDATA%\RepoVault\Cache`, Credential Manager `RepoVault:*`.
