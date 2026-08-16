/**
 * 类别 → DATA_DIR 下相对路径清单（声明式）。
 * kind=file 单文件可缺失；kind=dir 整目录递归。
 * 注意：这些路径相对 admin 的 data_dir（= DATA_DIR/admin），memory 例外（见 gather.ts）。
 * 设计依据：2026-06-19-crabot-backup-migration-design.md §5
 */
import { BACKUP_CATEGORIES, type BackupCategory } from './types.js'

export type CategoryPath = { rel: string; kind: 'file' | 'dir' }

export const CATEGORY_PATHS: Record<BackupCategory, CategoryPath[]> = {
  config: [
    { rel: 'global_model_config.json', kind: 'file' },
    { rel: 'model_providers.json', kind: 'file' },
    { rel: 'agent-instances.json', kind: 'file' },
    { rel: 'agent-configs', kind: 'dir' },
    // P6-D：legacy archive/tombstone 纳入 authenticated backup/export（§3.18）
    { rel: 'legacy-agent-archive.json', kind: 'file' },
    { rel: 'legacy-agent-tombstones.json', kind: 'file' },
    { rel: 'templates.json', kind: 'file' },
    { rel: 'subagents.json', kind: 'file' },
    { rel: 'mcp-servers.json', kind: 'file' },
    { rel: 'vendor.yaml', kind: 'file' },
    { rel: 'session-configs.json', kind: 'file' },
  ],
  channels: [
    { rel: 'channel-instances.json', kind: 'file' },
    { rel: 'channel-configs', kind: 'dir' },
    { rel: 'friends.json', kind: 'file' },
    { rel: 'friend-permission-configs.json', kind: 'file' },
  ],
  skills: [
    // skills.json 必须排在 skills 目录前：gather 先从 skills.json 算出保留的 skill name 集，
    // 再据此只拷对应子目录。重排会导致 skills/ 子目录被静默全部跳过。
    { rel: 'skills.json', kind: 'file' },
    { rel: 'skills', kind: 'dir' },
  ],
  // memory 走独立逻辑（gather.ts 单独处理），这里留空占位
  memory: [],
  tasks: [
    { rel: 'tasks.json', kind: 'file' },
    { rel: 'schedules.json', kind: 'file' },
  ],
}

export const DEFAULT_CATEGORIES: BackupCategory[] = ['config', 'channels', 'skills', 'memory', 'tasks']

export function isBackupCategory(v: string): v is BackupCategory {
  return (BACKUP_CATEGORIES as readonly string[]).includes(v)
}

export { BACKUP_CATEGORIES } from './types.js'
