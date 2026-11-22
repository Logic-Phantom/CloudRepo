# Google Cloud Console 설정 가이드

RepoVault는 Google Drive API v3를 **사용자 본인의 OAuth 계정**으로 호출합니다(서비스 계정 사용 안 함). 백업 파일의 소유자는 사용자 본인입니다.

## 1. 프로젝트 만들기
1. <https://console.cloud.google.com/> 접속 → 상단 프로젝트 선택 → **새 프로젝트** (예: `RepoVault`)

## 2. Google Drive API 활성화
1. **API 및 서비스 → 라이브러리** → `Google Drive API` 검색 → **사용**

## 3. OAuth 동의 화면 (Google Auth Platform)
1. **API 및 서비스 → OAuth 동의 화면** (또는 *Google Auth Platform → 브랜딩*)
2. 앱 이름 `RepoVault`, 사용자 지원 이메일, 개발자 연락처 입력
3. 대상(Audience): 개인 Gmail 계정이면 **외부(External)**
4. **데이터 액세스(Scopes)**: `https://www.googleapis.com/auth/drive.file` 만 추가
   - `drive.file`은 *비민감(non-sensitive)* 스코프 — RepoVault가 만든 파일만 접근할 수 있습니다.
   - 전체 Drive 권한(`drive`)은 요청하지 않습니다.

## 4. OAuth Client ID 만들기
1. **사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
2. 애플리케이션 유형: **데스크톱 앱(Desktop app)**
3. 생성 후 **JSON 다운로드** (`client_secret_xxx.apps.googleusercontent.com.json`)

> Desktop 앱의 client secret은 Google 문서상 *비밀로 취급되지 않는 공개 클라이언트 값*입니다. RepoVault는 보안을 PKCE(S256) + OS 자격 증명 저장소에 의존하며, secret은 평문 설정 파일이 아닌 Keychain/Credential Manager에 보관합니다.

## 5. RepoVault에 Client 등록
```bash
node dist/cli/main.js setup google --client-json ~/Downloads/client_secret_XXXX.json
```
또는 앱 → **Google Drive → client_secret JSON 불러오기**

## 6. Google 계정 연결
```bash
node dist/cli/main.js auth login
```
브라우저에서 계정 선택 → 권한 승인. 앱이 `127.0.0.1:<임의 포트>` loopback으로 코드를 받고, `state` 검증 후 PKCE로 토큰을 교환합니다.
연결이 끝나면 **My Drive/Git** 폴더가 생성됩니다.

## 7. ⚠️ 장기 무인 백업을 위한 게시 상태(Publishing status)
- 동의 화면이 **Testing** 상태면 Refresh Token이 **7일 후 만료**됩니다 → 매일 자동 백업이 1주일 뒤 멈춥니다.
- **Google Auth Platform → 대상(Audience) → 앱 게시(Publish app)** 로 **In production** 전환을 권장합니다.
- `drive.file` 같은 비민감 스코프만 쓰면 일반적으로 정식 검증 심사 없이 게시할 수 있습니다(Google 정책은 변경될 수 있으니 콘솔 안내를 확인하세요). 미검증 앱 경고 화면이 보이면 *고급 → RepoVault(으)로 이동* 으로 진행합니다.
- 토큰이 만료/취소되면 RepoVault는 `Re-authentication Required` 상태가 되며 **어떤 Drive 파일도 삭제하지 않습니다.** `auth login`으로 다시 연결하면 됩니다.

## 참고 문서
- OAuth 2.0 for Desktop Apps: https://developers.google.com/identity/protocols/oauth2/native-app
- Refresh Token 만료 조건: https://developers.google.com/identity/protocols/oauth2#expiration
- Drive API Scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Resumable Upload: https://developers.google.com/workspace/drive/api/guides/manage-uploads
- files 리소스 (sha256Checksum): https://developers.google.com/workspace/drive/api/reference/rest/v3/files
- about.get (storageQuota): https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get
