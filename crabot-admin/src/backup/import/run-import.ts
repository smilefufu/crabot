/**
 * Crabot 原生导入编排：逐类别从归档读 payload → 对每条调注入的 upsert → 汇总 → finalize（reload+push）。
 * 依赖注入：AdminModule 侧接线真实回调（onConflict 绑进闭包），单测注入假回调。
 * 设计依据：2026-06-19-crabot-backup-import-design.md §4
 */
import type { BackupCategory } from '../types.js'
import type { CrabotImportSummary, ImportItemResult, ImportStatus, OnConflict } from './import-types.js'
import { readJsonArrayFromArchive, readArchiveTextFile } from './read-archive-category.js'

type UpsertFn = (record: unknown) => Promise<ImportStatus>

/** P6-D §3.18.1：旧 live Agent payload 整包拒绝（在任何 domain 写入前的 preflight 抛出）。 */
export class ImportPreflightRejected extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export type ImportDeps = {
  upsertProvider?: UpsertFn
  upsertChannel?: UpsertFn
  upsertMcp?: UpsertFn
  upsertSubagent?: UpsertFn
  upsertTemplate?: UpsertFn
  upsertFriend?: UpsertFn
  upsertSchedule?: UpsertFn
  upsertTask?: UpsertFn
  upsertSessionConfig?: UpsertFn
  /** P6-D：全量校验 agent 相关 payload（纯读+校验，零写入）。 */
  validateAgentPayload?: (archivePath: string) => Promise<{ coreConfigRaw: Record<string, unknown> | null; archiveRows: unknown[] }>
  /** P6-D：validate 通过后才允许调用——exact core config 进 CoreAgentConfigStore。 */
  applyCoreAgentConfig?: (raw: Record<string, unknown>, onConflict: OnConflict) => Promise<ImportItemResult[]>
  /** P6-D：validate 通过后才允许调用——archive record 恢复（幂等）。 */
  applyLegacyArchiveRows?: (rows: unknown[], onConflict: OnConflict) => Promise<ImportItemResult[]>
  importSkills?: (archivePath: string, onConflict: OnConflict) => Promise<ImportItemResult[]>
  importMemory?: (archivePath: string, onConflict: OnConflict) => Promise<ImportItemResult[]>
  /** 全部类别处理完后：save + 内存 reload + triggerPushAfter。 */
  finalize: () => Promise<void>
}

/** 类别 → 该类别 JSON 数组文件 payload 路径 + 对应 upsert 的 deps key + summary kind 标签。 */
const SIMPLE_ARRAY_IMPORT: Array<{
  category: BackupCategory; file: string; depKey: keyof ImportDeps; kind: string
}> = [
  { category: 'config', file: 'payload/config/model_providers.json', depKey: 'upsertProvider', kind: 'provider' },
  { category: 'config', file: 'payload/config/subagents.json', depKey: 'upsertSubagent', kind: 'subagent' },
  { category: 'config', file: 'payload/config/templates.json', depKey: 'upsertTemplate', kind: 'template' },
  { category: 'config', file: 'payload/config/session-configs.json', depKey: 'upsertSessionConfig', kind: 'session-config' },
  // P6-D：agent-instances.json 不在此表——由 preflight 分类（§3.18.1），live non-core 整包拒绝。
  { category: 'config', file: 'payload/config/mcp-servers.json', depKey: 'upsertMcp', kind: 'mcp' },
  { category: 'channels', file: 'payload/channels/friends.json', depKey: 'upsertFriend', kind: 'friend' },
  { category: 'tasks', file: 'payload/tasks/tasks.json', depKey: 'upsertTask', kind: 'task' },
  { category: 'tasks', file: 'payload/tasks/schedules.json', depKey: 'upsertSchedule', kind: 'schedule' },
]

export async function runCrabotImport(params: {
  archivePath: string
  categories: BackupCategory[]
  onConflict: OnConflict
  deps: ImportDeps
}): Promise<CrabotImportSummary> {
  const { archivePath, categories, onConflict, deps } = params
  const results: ImportItemResult[] = []
  const errors: string[] = []
  const selected = new Set(categories)

  // 注：以下导出文件不走本表，由 C1 的 deps 接线特殊处理或刻意不导入：
  //   - global_model_config.json（单对象非数组，C1 特殊落地）
  //   - agent-configs/crabot-agent.json（P6-D：由 importCoreAgentConfig 单独进 CoreStore）
  //   - channel-configs/<id>.json（随 channel 实例由 upsertChannel 一并写）
  //   - friend-permission-configs.json（按 friend_id 而非 id，留 C1 决定）
  //   - vendor.yaml（system mode 由 root 管，不导入）
  try {
    // P6-D §3.18.1：全包 preflight 必须先于任何 domain 写入（含 core config）。
    let agentPayload: { coreConfigRaw: Record<string, unknown> | null; archiveRows: unknown[] } | null = null
    if (selected.has('config')) {
      // 存在性检查是 preflight 的一部分：无 agent payload 时不需要校验器。
      const hasAgentPayload = (await readJsonArrayFromArchive(archivePath, 'payload/config/agent-implementations.json')).length > 0
        || (await readJsonArrayFromArchive(archivePath, 'payload/config/agent-instances.json')).length > 0
        || (await readArchiveTextFile(archivePath, 'payload/config/agent-configs/crabot-agent.json')) !== null
        || (await readArchiveTextFile(archivePath, 'payload/config/legacy-agent-archive.json')) !== null
      if (hasAgentPayload) {
        if (!deps.validateAgentPayload) {
          throw new ImportPreflightRejected('ADMIN_BACKUP_NON_CORE_AGENT_UNSUPPORTED', '缺少 agent payload 校验器')
        }
        agentPayload = await deps.validateAgentPayload(archivePath)
        // 校验通过 → 才允许写入
        if (agentPayload.coreConfigRaw && deps.applyCoreAgentConfig) {
          results.push(...(await deps.applyCoreAgentConfig(agentPayload.coreConfigRaw, onConflict)))
        }
        if (agentPayload.archiveRows.length > 0 && deps.applyLegacyArchiveRows) {
          results.push(...(await deps.applyLegacyArchiveRows(agentPayload.archiveRows, onConflict)))
        }
      }
    }

    for (const item of SIMPLE_ARRAY_IMPORT) {
      if (!selected.has(item.category)) continue
      const rows = await readJsonArrayFromArchive(archivePath, item.file)
      if (rows.length === 0) continue
      const upsert = deps[item.depKey] as UpsertFn | undefined
      if (!upsert) {
        errors.push(`缺少 ${item.kind} 的导入处理器`)
        continue
      }
      for (const row of rows) {
        const id = (row as { id?: string }).id ?? ''
        try {
          const status = await upsert(row)
          results.push({ kind: item.kind, id, status })
        } catch (err) {
          results.push({ kind: item.kind, id, status: 'failed', reason: String(err) })
        }
      }
    }

    // channels 实例（带 config）单独走 upsertChannel
    if (selected.has('channels')) {
      if (!deps.upsertChannel) {
        errors.push('缺少 channel 的导入处理器')
      } else {
        const rows = await readJsonArrayFromArchive(archivePath, 'payload/channels/channel-instances.json')
        for (const row of rows) {
          const id = (row as { id?: string }).id ?? ''
          try {
            const status = await deps.upsertChannel(row)
            results.push({ kind: 'channel', id, status })
          } catch (err) {
            results.push({ kind: 'channel', id, status: 'failed', reason: String(err) })
          }
        }
      }
    }

    if (selected.has('skills') && deps.importSkills) {
      try {
        results.push(...(await deps.importSkills(archivePath, onConflict)))
      } catch (err) {
        errors.push(`skills 导入失败：${String(err)}`)
      }
    }
    if (selected.has('memory') && deps.importMemory) {
      try {
        results.push(...(await deps.importMemory(archivePath, onConflict)))
      } catch (err) {
        errors.push(`memory 导入失败：${String(err)}`)
      }
    }
  } finally {
    // 无论中途是否抛错，finalize（save + reload + push）都要跑，避免半落盘不刷新
    await deps.finalize()
  }
  return { results, errors }
}
