# 복원 가이드 (Google Drive 단독)

기존 PC가 고장 나도 Google 계정만 있으면 복원할 수 있습니다.

## 새 PC에서
```bash
git clone https://github.com/Logic-Phantom/CloudRepo.git && cd CloudRepo
npm install && npm run build
node dist/cli/main.js setup google --client-json <client_secret.json>
node dist/cli/main.js auth login        # Drive의 Git 폴더/인덱스를 자동 인식
node dist/cli/main.js history           # 저장소/스냅샷 목록
```

## 복원 명령
```bash
# 최신 복원 가능 스냅샷 전체 (브랜치 + 태그 + 보호된 과거 ref)
node dist/cli/main.js restore github-logic-phantom-cutpick --dest ~/restore/CutPick

# 특정 시점
node dist/cli/main.js restore github-logic-phantom-cutpick --snapshot 3f2a9c1b --dest ~/restore/CutPick-0601

# 특정 브랜치/태그만
node dist/cli/main.js restore github-logic-phantom-cutpick --ref main --ref refs/tags/v1.0 --dest ~/restore/x

# origin 재설정
node dist/cli/main.js restore <repoId> --dest <dir> --set-remote https://github.com/me/new-repo.git
```

## 새 원격 저장소로 올리기
```bash
node dist/cli/main.js push-restored ~/restore/CutPick https://github.com/me/new.git            # 미리보기(dry-run)
node dist/cli/main.js push-restored ~/restore/CutPick https://github.com/me/new.git --execute  # 실제 push
```
`--mirror`/`--force`는 사용하지 않으므로 기존 원격 ref를 덮어쓰거나 삭제하지 않습니다.

## 안전장치
- 비어 있지 않은 폴더에는 복원하지 않습니다.
- 다운로드한 모든 파일의 크기·SHA-256을 manifest·checksums.sha256과 교차 검증합니다.
- `git bundle verify` → 임시 bare import → ref 일치 → 대상 폴더 생성 → ref·fsck 재검증.
- LFS 객체가 백업되지 않은 스냅샷은 경고와 함께 Git 커밋만 복원합니다.
- 실패해도 Drive 원본과 사용자 파일은 삭제하지 않습니다.

## 정기 검증
```bash
node dist/cli/main.js verify <repoId>   # Drive에서 내려받아 실제 복원 테스트, system/integrity-reports 에 기록
```
