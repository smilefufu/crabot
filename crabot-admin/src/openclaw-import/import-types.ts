/**
 * 导入结果的共享类型。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §8 / §9
 */

export type ImportItemStatus = 'imported' | 'skipped'

export type ImportSkipReason =
  | 'conflict' // crabot 已存在同名/同类 → 跳过（以 crabot 为准）
  | 'not-migratable' // OAuth / SecretRef / 不支持类型
  | 'missing-secret' // 必需明文 secret 不在备份
  | 'invalid-name' // 派生实例名不满足白名单（如 account_id 含大写/点号）

export type ImportItemResult = {
  kind: 'provider' | 'channel' | 'mcp' | 'skill' | 'memory' | 'workspace'
  name: string
  status: ImportItemStatus
  reason?: ImportSkipReason
}
