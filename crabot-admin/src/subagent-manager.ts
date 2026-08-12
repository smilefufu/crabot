/**
 * SubAgent 注册表管理器
 *
 * 仿 MCPServerManager / SkillManager 模式：data/admin/subagents.json + 文件原子写入。
 *
 * ## 持久化模型（v2，2026-05-24 起）
 *
 * Builtin entry 的 "代码默认值" 不落盘——磁盘上仅存：
 *  - 不可推导的状态字段：id / is_builtin / enabled / provider_id / model_id / model_role
 *    / created_at / updated_at
 *  - 用户实际改过的字段（override；与 getBuiltinSubAgents() 的 default 不同的字段）
 *
 * Load 时 merge codeDefault + storedOverride 还原完整 entry；save 时 diff 出 override。
 * 代码升级 default 后，未 override 的字段自动跟随；用户改过的字段永久保留。
 *
 * User-created entry（is_builtin=false）走全量落盘，逻辑不变。
 *
 * 文件格式 `{ version: 2, entries: [...] }`。v1（裸数组）自动迁移：所有 builtin entry 内容字段
 * 重置为 codeDefault（备份原文件 + warn 日志）。
 */

import fs from 'fs/promises'
import path from 'path'
import { generateId, generateTimestamp } from 'crabot-shared'
import type { SubAgentRegistryEntry, ModelRole } from './types.js'
import type { RegistryMutationRunner } from './mcp-skill-manager.js'
import type { OnConflict } from './backup/import/import-types.js'

export type CreateSubAgentParams = Omit<
  SubAgentRegistryEntry,
  'id' | 'is_builtin' | 'enabled' | 'created_at' | 'updated_at'
> & { enabled?: boolean }

export type UpdateSubAgentParams = Partial<
  Pick<
    SubAgentRegistryEntry,
    | 'name'
    | 'description'
    | 'when_to_use'
    | 'role'
    | 'workflow'
    | 'deliverables'
    | 'verification'
    | 'provider_id'
    | 'model_id'
    | 'model_role'
    | 'builtin_capabilities'
    | 'allowed_mcp_server_ids'
    | 'allowed_skill_ids'
    | 'max_turns'
    | 'hook_preset'
    | 'enabled'
  >
>

const STORAGE_FORMAT_VERSION = 2

/** 必落盘字段：用户/系统状态，无法从 codeDefault 推导。builtin 和 non-builtin 都存。 */
const PERSISTED_STATE_FIELDS = [
  'id',
  'is_builtin',
  'enabled',
  'provider_id',
  'model_id',
  'model_role',
  'created_at',
  'updated_at',
] as const

/** Builtin 的"可被用户 override"字段：落盘前 diff codeDefault，仅与 default 不同的值才写。 */
const BUILTIN_OVERRIDABLE_FIELDS = [
  'name',
  'description',
  'when_to_use',
  'role',
  'workflow',
  'deliverables',
  'verification',
  'builtin_capabilities',
  'allowed_mcp_server_ids',
  'allowed_skill_ids',
  'max_turns',
  'hook_preset',
  'system_only',
] as const

function runtimeSubAgentEntries(entries: Map<string, SubAgentRegistryEntry>): unknown[] {
  return Array.from(entries.values()).filter((entry) => entry.enabled).map((entry) => JSON.parse(JSON.stringify({
    id: entry.id, name: entry.name, description: entry.description, when_to_use: entry.when_to_use,
    role: entry.role, workflow: entry.workflow, deliverables: entry.deliverables,
    provider_id: entry.provider_id, model_id: entry.model_id, model_role: entry.model_role,
    builtin_capabilities: entry.builtin_capabilities, allowed_mcp_server_ids: entry.allowed_mcp_server_ids,
    allowed_skill_ids: entry.allowed_skill_ids, max_turns: entry.max_turns, hook_preset: entry.hook_preset,
  }))).sort((a: any, b: any) => a.id.localeCompare(b.id))
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bArr = b as unknown[]
    if (a.length !== bArr.length) return false
    return a.every((v, i) => isDeepEqual(v, bArr[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  const bk = Object.keys(bo)
  if (ak.length !== bk.length) return false
  return ak.every((k) => isDeepEqual(ao[k], bo[k]))
}

interface StoredFile {
  version: number
  entries: Record<string, unknown>[]
}

export class SubAgentManager {
  private entries: Map<string, SubAgentRegistryEntry> = new Map()
  private readonly filePath: string
  private readonly getBuiltinDefaults: () => SubAgentRegistryEntry[]
  private mutationRunner: RegistryMutationRunner | null = null
  private semanticSnapshotProvider: (() => unknown) | null = null
  private needsLegacyRewrite = false
  private legacyBackupPath: string | null = null

  constructor(dataDir: string, getBuiltinDefaults: () => SubAgentRegistryEntry[] = () => []) {
    this.filePath = path.join(dataDir, 'subagents.json')
    this.getBuiltinDefaults = getBuiltinDefaults
  }

  async initialize(): Promise<void> {
    await this.initializeLoadOnly()
  }

  async initializeLoadOnly(): Promise<void> {
    await this.load()
  }

  setMutationRunner(runner: RegistryMutationRunner): void { this.mutationRunner = runner }
  setSemanticSnapshotProvider(provider: () => unknown): void { this.semanticSnapshotProvider = provider }

  private async persistLegacyRewrite(): Promise<boolean> {
    if (!this.needsLegacyRewrite) return false
    if (this.legacyBackupPath) {
      await fs.copyFile(this.filePath, this.legacyBackupPath)
      this.legacyBackupPath = null
    }
    await this.save()
    this.needsLegacyRewrite = false
    return true
  }

  private async commit(next: Map<string, SubAgentRegistryEntry>): Promise<void> {
    const previous = this.entries
    const apply = async () => {
      this.entries = next
      if (!await this.persistLegacyRewrite()) await this.save()
    }
    if (!this.mutationRunner) return apply()
    await this.mutationRunner(['subagents'], async () => {
      this.entries = next
      try { return this.semanticSnapshotProvider?.() } finally { this.entries = previous }
    }, apply)
  }

  runtimeSemanticEntries(): unknown[] {
    return runtimeSubAgentEntries(this.entries)
  }

  private buildBuiltinMap(): Map<string, SubAgentRegistryEntry> {
    return new Map(this.getBuiltinDefaults().map((e) => [e.id, e]))
  }

  private async load(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf-8')
    } catch {
      this.entries = new Map()
      return
    }

    const parsed: unknown = JSON.parse(raw)
    const builtinMap = this.buildBuiltinMap()

    let rawEntries: Record<string, unknown>[]
    let needsRewrite = false

    if (Array.isArray(parsed)) {
      // v1 格式（裸数组）：迁移。备份原文件，builtin entry 仅保留 state 字段（内容字段重置为
      // codeDefault），non-builtin 不变。
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      this.legacyBackupPath = path.join(path.dirname(this.filePath), `.legacy-subagents-${ts}.json`)
      console.warn(
        `[SubAgentManager] 检测到 v1 格式 subagents.json，将在 coordinator recovery 后备份至 ${this.legacyBackupPath}。\n` +
          '正在迁移到 v2 override-only 格式：builtin subagent 的所有 prompt / capabilities / max_turns ' +
          '等内容字段将回退到代码默认值。\n如曾通过 Admin UI 改过 builtin，请对照备份文件重新设置。'
      )
      rawEntries = (parsed as Record<string, unknown>[]).map((e) => {
        if (!e.is_builtin) return e
        const out: Record<string, unknown> = {}
        for (const k of PERSISTED_STATE_FIELDS) out[k] = e[k]
        return out
      })
      needsRewrite = true
    } else if (parsed && typeof parsed === 'object' && (parsed as StoredFile).version === STORAGE_FORMAT_VERSION) {
      rawEntries = (parsed as StoredFile).entries
    } else {
      const v = (parsed as { version?: unknown })?.version
      throw new Error(
        `subagents.json: unsupported storage version ${JSON.stringify(v)}, expected ${STORAGE_FORMAT_VERSION}`
      )
    }

    this.entries = new Map()
    for (const stored of rawEntries) {
      const id = stored.id as string
      const isBuiltin = stored.is_builtin === true
      if (isBuiltin) {
        const codeDefault = builtinMap.get(id)
        if (!codeDefault) {
          // builtin 在代码里被删了（pruneObsoleteBuiltins 应该已经清掉），保底全量读
          this.entries.set(id, stored as unknown as SubAgentRegistryEntry)
          continue
        }
        const merged = {
          ...codeDefault,
          ...stored,
          is_builtin: true,
        } as SubAgentRegistryEntry
        this.entries.set(id, merged)
      } else {
        this.entries.set(id, stored as unknown as SubAgentRegistryEntry)
      }
    }

    if (needsRewrite) {
      // Startup recovery must observe the persisted source before legacy normalization. The caller
      // performs the post-recovery write through coordinator-owned seed/reconciliation.
      this.needsLegacyRewrite = true
    }
  }

  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.tmp`
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, filePath)
  }

  /** 把全量 entry 转成磁盘稀疏格式：builtin 仅保留 state + 与 codeDefault 不同的 override 字段。 */
  private stripBuiltinDefaults(
    entry: SubAgentRegistryEntry,
    builtinMap: Map<string, SubAgentRegistryEntry>
  ): Record<string, unknown> {
    if (!entry.is_builtin) {
      return entry as unknown as Record<string, unknown>
    }
    const codeDefault = builtinMap.get(entry.id)
    if (!codeDefault) {
      // 代码里没对应 default（应该已被 pruneObsoleteBuiltins 清掉，保底全量）
      return entry as unknown as Record<string, unknown>
    }
    const out: Record<string, unknown> = {}
    for (const k of PERSISTED_STATE_FIELDS) {
      out[k] = (entry as unknown as Record<string, unknown>)[k]
    }
    for (const k of BUILTIN_OVERRIDABLE_FIELDS) {
      const v = (entry as unknown as Record<string, unknown>)[k]
      const d = (codeDefault as unknown as Record<string, unknown>)[k]
      if (!isDeepEqual(v, d)) {
        out[k] = v
      }
    }
    return out
  }

  private async save(): Promise<void> {
    const builtinMap = this.buildBuiltinMap()
    const file: StoredFile = {
      version: STORAGE_FORMAT_VERSION,
      entries: Array.from(this.entries.values()).map((e) => this.stripBuiltinDefaults(e, builtinMap)),
    }
    await this.atomicWriteFile(this.filePath, JSON.stringify(file, null, 2))
  }

  list(): SubAgentRegistryEntry[] {
    return Array.from(this.entries.values())
  }

  listEnabled(): SubAgentRegistryEntry[] {
    return this.list().filter((e) => e.enabled)
  }

  get(id: string): SubAgentRegistryEntry | undefined {
    return this.entries.get(id)
  }

  getByName(name: string): SubAgentRegistryEntry | undefined {
    for (const e of this.entries.values()) {
      if (e.name === name) return e
    }
    return undefined
  }

  async upsertById(entry: SubAgentRegistryEntry, onConflict: OnConflict): Promise<'imported' | 'overwritten' | 'skipped'> {
    const exists = this.entries.has(entry.id)
    if (exists && onConflict === 'skip') return 'skipped'
    const next = new Map(this.entries)
    next.set(entry.id, entry)
    if (exists && JSON.stringify(this.runtimeSemanticEntries()) === JSON.stringify(runtimeSubAgentEntries(next))) {
      this.entries = next
      await this.save()
      return 'overwritten'
    }
    await this.commit(next)
    return exists ? 'overwritten' : 'imported'
  }

  async create(params: CreateSubAgentParams): Promise<SubAgentRegistryEntry> {
    if (this.getByName(params.name)) {
      throw new Error(`SubAgent "${params.name}" 已存在`)
    }
    this.validateModelSpec(params)
    const now = generateTimestamp()
    const entry: SubAgentRegistryEntry = {
      ...params,
      id: generateId(),
      is_builtin: false,
      enabled: params.enabled ?? true,
      created_at: now,
      updated_at: now,
    }
    const next = new Map(this.entries)
    next.set(entry.id, entry)
    await this.commit(next)
    return entry
  }

  async update(id: string, params: UpdateSubAgentParams): Promise<SubAgentRegistryEntry> {
    // 内置项（is_builtin=true）允许 update 修改任意字段。spec §1.1 "内置项可编辑可禁用不可删"。
    // 与代码默认值相同的字段在落盘时自动剔除（stripBuiltinDefaults），后续代码升级该字段会自动跟随；
    // 与默认值不同的字段视为 user override，永久保留。无需 is_user_modified 标志位。
    const existing = this.entries.get(id)
    if (!existing) throw new Error(`SubAgent not found: ${id}`)

    if (params.name && params.name !== existing.name) {
      const dup = this.getByName(params.name)
      if (dup && dup.id !== id) throw new Error(`SubAgent "${params.name}" 已存在`)
    }

    const next: SubAgentRegistryEntry = {
      ...existing,
      ...params,
      id: existing.id,
      is_builtin: existing.is_builtin,
      created_at: existing.created_at,
      updated_at: generateTimestamp(),
    }
    this.validateModelSpec(next)
    const currentRuntime = JSON.stringify({
      id: existing.id, name: existing.name, description: existing.description, when_to_use: existing.when_to_use,
      role: existing.role, workflow: existing.workflow, deliverables: existing.deliverables,
      provider_id: existing.provider_id, model_id: existing.model_id, model_role: existing.model_role,
      builtin_capabilities: existing.builtin_capabilities, allowed_mcp_server_ids: existing.allowed_mcp_server_ids,
      allowed_skill_ids: existing.allowed_skill_ids, max_turns: existing.max_turns, hook_preset: existing.hook_preset,
      enabled: existing.enabled,
    })
    const nextRuntime = JSON.stringify({
      id: next.id, name: next.name, description: next.description, when_to_use: next.when_to_use,
      role: next.role, workflow: next.workflow, deliverables: next.deliverables,
      provider_id: next.provider_id, model_id: next.model_id, model_role: next.model_role,
      builtin_capabilities: next.builtin_capabilities, allowed_mcp_server_ids: next.allowed_mcp_server_ids,
      allowed_skill_ids: next.allowed_skill_ids, max_turns: next.max_turns, hook_preset: next.hook_preset,
      enabled: next.enabled,
    })
    if (currentRuntime === nextRuntime) {
      this.entries.set(id, next)
      await this.save()
      return next
    }
    const nextEntries = new Map(this.entries)
    nextEntries.set(id, next)
    await this.commit(nextEntries)
    return next
  }

  async delete(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`SubAgent not found: ${id}`)
    if (entry.is_builtin) throw new Error(`内置 SubAgent "${entry.name}" 不可删除`)
    const next = new Map(this.entries)
    next.delete(id)
    await this.commit(next)
  }

  /** 内置项 seed：仅插入不存在的 entry。已存在的 builtin 的内容字段在 load 时由 codeDefault 提供，
   *  override 写在 stripBuiltinDefaults 落盘逻辑里，seed 路径不需要再覆盖。 */
  async seedBuiltin(entries: SubAgentRegistryEntry[]): Promise<void> {
    let changed = false
    const next = new Map(this.entries)
    for (const e of entries) {
      if (!next.has(e.id)) {
        next.set(e.id, e)
        changed = true
      }
    }
    if (changed) await this.commit(next)
    else await this.persistLegacyRewrite()
  }

  /**
   * 删除已废弃的内置 subagent entry。
   *
   * 调用方传当前活动的内置 id 列表（来自 getBuiltinSubAgents().map(s => s.id)）；
   * 本方法把所有 is_builtin=true 但不在该列表的 entry 删除，并 warn 日志。
   *
   * 用途：builtin subagent 在版本演进中被替换（如 vision → research_collector）时，
   * admin 启动 seed 之前调本方法清理旧 entry。
   */
  async pruneObsoleteBuiltins(activeBuiltinIds: string[]): Promise<void> {
    const obsolete: SubAgentRegistryEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.is_builtin && !activeBuiltinIds.includes(entry.id)) {
        obsolete.push(entry)
      }
    }
    if (obsolete.length === 0) return
    const next = new Map(this.entries)
    for (const e of obsolete) {
      console.warn(
        `[SubAgentManager] 删除已废弃的 builtin subagent: ${e.name} (id=${e.id}). ` +
          `如曾通过 Admin UI 编辑过 prompt，自定义内容将丢失。`
      )
      next.delete(e.id)
    }
    await this.commit(next)
  }

  private validateModelSpec(entry: Pick<SubAgentRegistryEntry, 'provider_id' | 'model_id' | 'model_role'>): void {
    const hasSpecific = entry.provider_id !== null && entry.model_id !== null
    const hasRole = entry.model_role !== null
    if (!hasSpecific && !hasRole) {
      throw new Error('model spec 缺失：provider_id+model_id 或 model_role 至少需一组')
    }
  }
}

export type ResolvedSubAgentModelSpec =
  | { mode: 'specific'; provider_id: string; model_id: string }
  | { mode: 'role'; role: ModelRole }

/**
 * 解析 subagent model 配置（hybrid 模式）。
 *
 * 优先级：
 *   1. provider_id 和 model_id 都非 null → mode='specific'（用户指定具体模型）
 *   2. model_role 非 null → mode='role'（按 role 查全局 model_config）
 *   3. 都缺 → 抛错（数据非法，SubAgentManager.validateModelSpec 应已拦截，此处再次防御）
 *
 * 调用方按 mode 进一步解析：
 *   - 'specific' → ModelProviderManager.buildConnectionInfo(provider_id, model_id)
 *   - 'role'     → 查 agent 实例 model_config[role] 拿 ModelSlotRef 后再 buildConnectionInfo
 */
export function resolveSubAgentModel(
  entry: Pick<SubAgentRegistryEntry, 'provider_id' | 'model_id' | 'model_role'>
): ResolvedSubAgentModelSpec {
  if (entry.provider_id !== null && entry.model_id !== null) {
    return { mode: 'specific', provider_id: entry.provider_id, model_id: entry.model_id }
  }
  if (entry.model_role !== null) {
    return { mode: 'role', role: entry.model_role }
  }
  throw new Error('SubAgent model 配置缺失：provider_id+model_id 或 model_role 至少需一组')
}
