import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepositoryTarget, SnapshotManifest } from '../types.js';

export type JobState = 'building' | 'pending_upload' | 'uploading' | 'completed';

export interface StagedFile {
  name: string;
  path: string;
  size: number;
  sha256: string;
  mimeType: string;
  role: string;
  file_id: string | null;
  verified: boolean;
  verified_by?: 'sha256Checksum' | 'download';
}

/** 임시 작업 상태. 업로드 미완료 시 다음 실행에서 이 파일로 재시도한다. */
export interface JobManifest {
  job_id: string;
  repository_id: string;
  /** 인증정보 없는 대상 정보 (재시도 시 인덱스 갱신에 사용) */
  target?: RepositoryTarget;
  snapshot_id: string;
  snapshot_folder: string;
  state: JobState;
  files: StagedFile[];
  manifest_draft: SnapshotManifest | null;
  manifest_file: StagedFile | null;
  retry_count: number;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 작업 단위 임시 디렉터리 관리. 이곳은 백업 저장소가 아니라 Scratch Workspace다.
 * {cache}/work/{job_id}/ { work.git, bundles, lfs, metadata, upload-staging, job.json }
 */
export class TempWorkspace {
  readonly root: string;
  constructor(
    readonly baseDir: string,
    readonly jobId: string,
  ) {
    this.root = join(baseDir, jobId);
  }

  get gitDir() { return join(this.root, 'work.git'); }
  get verifyDir() { return join(this.root, 'verify.git'); }
  get bundlesDir() { return join(this.root, 'bundles'); }
  get lfsDir() { return join(this.root, 'lfs'); }
  get metadataDir() { return join(this.root, 'metadata'); }
  get stagingDir() { return join(this.root, 'upload-staging'); }
  get jobFile() { return join(this.root, 'job.json'); }

  create() {
    for (const d of [this.root, this.bundlesDir, this.lfsDir, this.metadataDir, this.stagingDir]) mkdirSync(d, { recursive: true });
  }

  saveJob(job: JobManifest) {
    job.updated_at = new Date().toISOString();
    const tmp = this.jobFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(job, null, 2));
    renameSync(tmp, this.jobFile);
  }

  loadJob(): JobManifest | null {
    if (!existsSync(this.jobFile)) return null;
    try {
      return JSON.parse(readFileSync(this.jobFile, 'utf8')) as JobManifest;
    } catch {
      return null;
    }
  }

  /** 업로드에 필요 없는 Git 작업 디렉터리만 제거 (스테이징 파일은 유지) */
  removeGitWorkDirs() {
    for (const d of [this.gitDir, this.verifyDir]) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  }

  /** 전체 정리. 실패해도 예외를 던지지 않고 경고 메시지를 반환한다. */
  cleanup(): string | null {
    try {
      rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return existsSync(this.root) ? `임시 작업 공간이 완전히 삭제되지 않았습니다: ${this.root}` : null;
    } catch (e) {
      return `임시 작업 공간 정리 실패: ${(e as Error).message}`;
    }
  }

  static freeBytes(dir: string): number | null {
    try {
      mkdirSync(dir, { recursive: true });
      const s = statfsSync(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  }

  /** 앱 시작 시 고아 작업 탐지 */
  static scan(baseDir: string): Array<{ ws: TempWorkspace; job: JobManifest | null }> {
    if (!existsSync(baseDir)) return [];
    return readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const ws = new TempWorkspace(baseDir, d.name);
        return { ws, job: ws.loadJob() };
      });
  }
}
