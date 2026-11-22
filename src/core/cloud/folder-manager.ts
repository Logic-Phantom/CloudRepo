import { DriveApiError, escapeQuery, FOLDER_MIME, type DriveFile, type GoogleDriveClient } from './drive-client.js';
import type { CacheDb } from '../database/cache.js';
import { stableStringify } from '../utils/misc.js';
import { SCHEMA_VERSION } from '../types.js';

export const ROOT_ROLE = 'root';

export class MultipleRootFoldersError extends Error {
  constructor(readonly candidates: DriveFile[]) {
    super(
      `Google Drive에서 RepoVault 루트 폴더가 ${candidates.length}개 발견되었습니다. 자동 병합/삭제하지 않습니다. ` +
        '`repovault drive select-root <folderId>`로 사용할 폴더를 선택해 주세요.',
    );
    this.name = 'MultipleRootFoldersError';
  }
}

export const STANDARD_FOLDERS: string[][] = [
  ['manifest'],
  ['manifest', 'devices'],
  ['manifest', 'repository-index'],
  ['repositories'],
  ['logs'],
  ['logs', 'cloud-backup'],
  ['logs', 'cloud-restore'],
  ['system'],
  ['system', 'integrity-reports'],
];

/**
 * Drive 폴더 관리. 이름이 아니라 Drive ID 기준으로 관리하고, 캐시된 ID가 무효하면 재검색한다.
 * drive.file 스코프이므로 앱이 만든 파일/폴더만 조회된다.
 */
export class DriveFolderManager {
  private rootId: string | null = null;

  constructor(
    private readonly drive: GoogleDriveClient,
    private readonly cache: CacheDb,
    private readonly rootName: string,
    private readonly pinnedRootId: string | null = null,
  ) {}

  /** 루트 폴더 후보 검색 (앱이 만든 폴더만) */
  async findRootCandidates(): Promise<DriveFile[]> {
    const q =
      `name = '${escapeQuery(this.rootName)}' and mimeType = '${FOLDER_MIME}' and trashed = false ` +
      `and appProperties has { key='repovault_role' and value='${ROOT_ROLE}' }`;
    return this.drive.listFiles(q);
  }

  async resolveRoot(createIfMissing = true): Promise<string> {
    if (this.rootId) return this.rootId;
    const pinned = this.pinnedRootId ?? this.cache.getKv('drive_root_id');
    if (pinned) {
      try {
        const f = await this.drive.getFile(pinned, 'id,trashed,mimeType');
        if (!f.trashed && f.mimeType === FOLDER_MIME) {
          this.rootId = f.id;
          this.cache.setKv('drive_root_id', f.id);
          return f.id;
        }
      } catch (e) {
        if (!(e instanceof DriveApiError && e.status === 404)) throw e;
      }
      // 캐시된 ID 무효 → 안전하게 재검색
      this.cache.clearFolderCache();
      this.cache.setKv('drive_root_id', null);
    }
    const candidates = await this.findRootCandidates();
    if (candidates.length > 1 && !this.pinnedRootId) throw new MultipleRootFoldersError(candidates);
    let root = candidates[0];
    if (!root) {
      if (!createIfMissing) throw new Error('Google Drive에서 RepoVault 백업 폴더를 찾을 수 없습니다.');
      root = await this.drive.createFolder(this.rootName, null, { repovault_role: ROOT_ROLE, repovault_schema: String(SCHEMA_VERSION) });
    }
    this.rootId = root.id;
    this.cache.setKv('drive_root_id', root.id);
    return root.id;
  }

  async ensureStructure(): Promise<string> {
    const root = await this.resolveRoot(true);
    for (const p of STANDARD_FOLDERS) await this.ensureFolder(p);
    const sys = await this.ensureFolder(['system']);
    const existing = await this.findChild(sys, 'schema-version.json', false);
    if (!existing) {
      await this.drive.createSmallFile(
        'schema-version.json',
        sys,
        stableStringify({ schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(), app: 'RepoVault' }),
        'application/json',
        { repovault_role: 'schema-version' },
      );
    }
    return root;
  }

  async findChild(parentId: string, name: string, folder: boolean): Promise<DriveFile | null> {
    const q =
      `name = '${escapeQuery(name)}' and '${escapeQuery(parentId)}' in parents and trashed = false` +
      (folder ? ` and mimeType = '${FOLDER_MIME}'` : ` and mimeType != '${FOLDER_MIME}'`);
    const files = await this.drive.listFiles(q);
    // 동시 생성으로 중복 폴더가 생기면 가장 먼저 만든 폴더를 일관되게 사용
    return files.sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''))[0] ?? null;
  }

  async findChildren(parentId: string, name: string): Promise<DriveFile[]> {
    const q = `name = '${escapeQuery(name)}' and '${escapeQuery(parentId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`;
    return this.drive.listFiles(q);
  }

  /** 경로 세그먼트 기준으로 폴더를 찾고 없으면 만든다 (ID 캐시 사용, 무효 시 재검색) */
  async ensureFolder(segments: string[], appProperties: Record<string, string> = {}): Promise<string> {
    let parent = await this.resolveRoot(true);
    const walked: string[] = [];
    for (const seg of segments) {
      walked.push(seg);
      const key = walked.join('/');
      const cached = this.cache.getFolderId(key);
      if (cached) {
        parent = cached;
        continue;
      }
      let f = await this.findChild(parent, seg, true);
      if (!f) {
        const isLeaf = walked.length === segments.length;
        f = await this.drive.createFolder(seg, parent, isLeaf ? appProperties : {});
      }
      this.cache.setFolderId(key, f.id);
      parent = f.id;
    }
    return parent;
  }

  /** 캐시된 폴더 ID가 404일 때 호출: 캐시를 비우고 다시 찾는다 */
  invalidate() {
    this.cache.clearFolderCache();
  }

  folderLink(id: string) {
    return `https://drive.google.com/drive/folders/${id}`;
  }
}
