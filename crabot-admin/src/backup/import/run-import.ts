/**
 * Crabot 原生导入编排：逐类别从归档读 payload → 对每条调注入的 upsert → 汇总 → finalize（reload+push）。
 * 依赖注入：AdminModule 侧接线真实回调（onConflict 绑进闭包），单测注入假回调。
 * 设计依据：2026-06-19-crabot-backup-import-design.md §4
 */
import type { BackupCategory } from '../types.js'
import type { CrabotImportSummary, ImportItemResult, ImportStatus, OnConflict } from './import-types.js'
import { readJsonArrayFromArchive } from './read-archive-category.js'

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
  /** P6-D：exact core config 只进 CoreAgentConfigStore（静态 slot 校验）。 */
  importCoreAgentConfig?: (archivePath: string, onConflict: OnConflict) => Promise<ImportItemResult[]>
  /** P6-D：新格式 LegacyAgentArchiveRecord 恢复到 archive-only store（幂等/冲突规则见 §3.18.1）。 */
  ingestLegacyArchive?: (archivePath: string, onConflict: OnConflict) => Promise<ImportItemResult[]>
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
    // P6-D §3.18.1：全包 preflight 必须先于任何 domain 写入。
    if (selected.has('config')) {
      const legacyImpls = await readJsonArrayFromArchive(archivePath, 'payload/config/agent-implementations.json')
      const legacyInstances = await readJsonArrayFromArchive(archivePath, 'payload/config/agent-instances.json')
      const nonCore = legacyInstances.filter((row) => (row as { id?: string }).id !== 'crabot-agent')
      if (legacyImpls.length > 0 || nonCore.length > 0) {
        throw new ImportPreflightRejected(
          'ADMIN_BACKUP_NON_CORE_AGENT_UNSUPPORTED',
          `旧 live Agent payload 不再支持导入（implementations=${legacyImpls.length}, non-core instances=${nonCore.length}）；请先在旧版本隔离恢复并运行 startup archive migration，再导出新格式 archive`,
        )
      }
      if (deps.importCoreAgentConfig) {
        results.push(...(await deps.importCoreAgentConfig(archivePath, onConflict)))
      }
      if (deps.ingestLegacyArchive) {
        results.push(...(await deps.ingestLegacyArchive(archivePath, onConflict)))
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
  } catch (err) {
    // preflight 拒绝：整包零写入，直接抛出（不进 results/errors 的部分导入语义）
    if (err instanceof ImportPreflightRejected) throw err
    throw err
  } finally {
    // 无论中途是否抛错，finalize（save + reload + push）都要跑，避免半落盘不刷新
    await deps.finalize()
  }
  return { results, errors }
}
