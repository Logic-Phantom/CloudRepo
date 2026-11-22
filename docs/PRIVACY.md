# RepoVault 개인정보처리방침 / Privacy Policy

RepoVault는 사용자 PC에서 실행되는 오픈소스 데스크톱 백업 도구입니다. 운영 서버가 없으며 개발자는 어떤 사용자 데이터도 수집·전송·보관하지 않습니다.

- **Google 사용자 데이터 접근 범위**: `https://www.googleapis.com/auth/drive.file` — RepoVault가 사용자 Google Drive에 직접 만든 파일/폴더(`My Drive/Git`)만 생성·읽기·수정합니다. 다른 Drive 파일은 조회하거나 변경할 수 없습니다.
- **사용 목적**: 사용자 본인의 Git 저장소 백업 파일(bundle, manifest, 로그)을 사용자 본인의 Google Drive에 저장하고 복원하기 위해서만 사용합니다.
- **저장 위치**: 백업 데이터는 사용자 Google Drive에만 저장됩니다. OAuth 토큰은 사용자 PC의 OS 보안 저장소(macOS Keychain / Windows Credential Manager)에만 저장됩니다.
- **제3자 제공**: 없음. 광고·분석·판매 목적으로 사용하지 않습니다.
- **삭제**: 앱은 Drive 백업을 자동 삭제하지 않습니다. 사용자는 Google Drive에서 `Git` 폴더를 직접 삭제하고, <https://myaccount.google.com/permissions>에서 RepoVault 접근 권한을 언제든 회수할 수 있습니다.
- Google API에서 받은 정보의 사용은 [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)(Limited Use 요구 사항 포함)를 준수합니다.

RepoVault is a local desktop tool with no backend. It uses the `drive.file` scope solely to store and restore the user's own Git backups in the user's own Google Drive; no data is collected by the developer or shared with third parties.
