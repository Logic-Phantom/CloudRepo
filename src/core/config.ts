import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { newId } from './utils/misc.js';
import type { ProviderKind } from './types.js';

export interface ManualRemote {
  id: string;
  name: string;
  owner: string;
  provider: ProviderKind;
  url: string;
  private: boolean;
  enabled: boolean;
}

/**
 * 비밀이 아닌 설정만 저장한다. 토큰/Client Secret은 OS Credential Store에 저장한다.
 */
export interface AppConfig {
  schema_version: number;
  device_id: string;
  google: {
    client_id: string | null;
    /** Drive 루트 폴더 이름 (My Drive/<이름>) */
    root_folder_name: string;
    /** 사용자가 선택/확정한 루트 폴더 ID (중복 폴더가 있을 때 사용) */
    root_folder_id: string | null;
    account_email: string | null;
  };
  schedule: {
    enabled: boolean;
    hour: number;
    minute: number;
    catch_up_missed: boolean;
  };
  github: {
    enabled: boolean;
    /** 자동 백업 대상에 포함할 조직 login 목록 */
    include_orgs: string[];
    include_collaborator_repos: boolean;
    include_archived: boolean;
    include_forks: boolean;
    auto_add_new: boolean;
  };
  gitlab: {
    enabled: boolean;
    base_url: string;
  };
  manual_remotes: ManualRemote[];
  excluded_repository_ids: string[];
  retry: {
    max_attempts: number;
  };
  upload: {
    chunk_size_mb: number;
  };
  temp_dir_override: string | null;
  /** AutoMateHQ Heartbeat 보고(선택). secret은 Credential Store(hq-heartbeat-secret)에 저장 */
  hq: {
    url: string | null;
    project_key: string;
  };
  retention: {
    /** 기본값: 무기한 보관. 자동 삭제는 사용자가 명시적으로 켜야 한다. */
    auto_delete_enabled: boolean;
    keep_days: number | null;
  };
}

export function defaultConfig(): AppConfig {
  return {
    schema_version: 1,
    device_id: newId(),
    google: {
      client_id: null,
      root_folder_name: 'Git',
      root_folder_id: null,
      account_email: null,
    },
    schedule: { enabled: true, hour: 3, minute: 0, catch_up_missed: true },
    github: {
      enabled: true,
      include_orgs: [],
      include_collaborator_repos: false,
      include_archived: true,
      include_forks: true,
      auto_add_new: true,
    },
    gitlab: { enabled: false, base_url: 'https://gitlab.com' },
    manual_remotes: [],
    excluded_repository_ids: [],
    retry: { max_attempts: 5 },
    upload: { chunk_size_mb: 8 },
    temp_dir_override: null,
    hq: { url: null, project_key: 'cloudrepo' },
    retention: { auto_delete_enabled: false, keep_days: null },
  };
}

function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return (override === undefined ? base : (override as T));
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b, v) : v;
  }
  return out as T;
}

export class ConfigStore {
  constructor(private readonly path: string) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  load(): AppConfig {
    if (!existsSync(this.path)) {
      const cfg = defaultConfig();
      this.save(cfg);
      return cfg;
    }
    const raw = JSON.parse(readFileSync(this.path, 'utf8'));
    return deepMerge(defaultConfig(), raw);
  }

  save(cfg: AppConfig): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  update(mutator: (cfg: AppConfig) => void): AppConfig {
    const cfg = this.load();
    mutator(cfg);
    this.save(cfg);
    return cfg;
  }
}

/** Drive에 공유되는 설정(기기 고유 값 제외) */
export function shareableConfig(cfg: AppConfig) {
  return {
    schema_version: cfg.schema_version,
    google: { root_folder_name: cfg.google.root_folder_name },
    schedule: cfg.schedule,
    github: cfg.github,
    gitlab: cfg.gitlab,
    manual_remotes: cfg.manual_remotes,
    excluded_repository_ids: cfg.excluded_repository_ids,
    retention: cfg.retention,
  };
}
