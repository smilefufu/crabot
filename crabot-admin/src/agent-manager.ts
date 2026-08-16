/**
 * Core Agent 配置存储（P6-D 收窄）。
 *
 * 只负责 exact `crabot-agent` 的行为配置（system prompt / model refs / timezone / extra）
 * 与旧 model_config key 迁移。动态 AgentImplementation/AgentInstance registry 已退役：
 * - 静态身份：CORE_AGENT_DEFINITION（core-agent-definition.ts）+ CORE_AGENT_INSTANCE
 * - 存量记录：legacy-agent-archive.json（CoreAgentCutoverStore/LegacyAgentArchiveStore）
 * 本文件不再读写 agent-implementations.json / agent-instances.json。
 */

import fs from 'fs/promises'
import path from 'path'
import { canonicalizeJson, generateTimestamp, type RpcClient } from 'crabot-shared'
import { durableAtomicWriteFile } from './durable-file.js'
import type {
  AgentImplementation,
  AgentInstance,
  AgentInstanceConfig,
  UpdateAgentConfigParams,
  ListAgentImplementationsParams,
  ListAgentInstancesParams,
  ModelSlotRef,
  ModelRole,
} from './types.js'

import type { ConfigDomain, CoreAgentConfigMutationContext } from './core-agent-config-revision-store.js'
import { CORE_AGENT_DEFINITION } from './core-agent-definition.js'

export type ConfigMutationRunner = (
  domains: ConfigDomain[],
  prepareAfterSnapshot: () => Promise<unknown>,
  applySourceMutation: (context: CoreAgentConfigMutationContext) => Promise<void>,
) => Promise<void>


/** 唯一 core Agent 实例身份（静态，release-owned；不再是可 CRUD 的 registry record）。 */
export const CORE_AGENT_INSTANCE: AgentInstance = Object.freeze({
  id: 'crabot-agent',
  implementation_id: 'crabot-agent',
  name: 'Crabot Agent',
  specialization: 'Unified core agent',
  max_concurrent_tasks: 5,
  auto_start: true,
  start_priority: 20,
  module_registered: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
})

const DEFAULT_AGENT_CONFIG: AgentInstanceConfig = {
  instance_id: 'crabot-agent',
  system_prompt: '',
  model_config: {},
  max_iterations: 10,
  tools_readonly: false,
}

// ============================================================================
// AgentManager
// ============================================================================

export class AgentManager {
  /** 仅 exact core 的行为配置（legacy instance config 只存在于 archive，不再进运行时 map）。 */
  private configs: Map<string, AgentInstanceConfig> = new Map()
  /** Loaded snapshot configs that must only be persisted after coordinator recovery. */
  private readonly pendingSnapshotConfigMigrations = new Set<string>()

  private readonly dataDir: string
  private readonly configsDir: string
  private onConfigChangedCallback: (() => void) | null = null
  private mutationRunner: ConfigMutationRunner | null = null
  private semanticSnapshotProvider: (() => unknown) | null = null
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.configsDir = path.join(dataDir, 'agent-configs')
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await fs.mkdir(this.configsDir, { recursive: true })
    await this.loadData()
  }

  async initializeCoreDefaultsAndMigrations(): Promise<void> {
    await this.ensureCoreConfig()
    await this.migrateAllModelConfigs()
  }

  // ============================================================================
  // 静态身份（只读；动态 Implementation/Instance registry 已退役）
  // ============================================================================

  /** 唯一可读 implementation 是静态 core 定义（兼容旧 id 'default'）。 */
  getImplementation(id: string): AgentImplementation | undefined {
    return id === 'crabot-agent' || id === 'default' ? CORE_AGENT_DEFINITION : undefined
  }

  /** 唯一实例是 exact core 静态身份。 */
  getInstance(id: string): AgentInstance | undefined {
    return id === 'crabot-agent' ? CORE_AGENT_INSTANCE : undefined
  }


  // ============================================================================
  // Config CRUD
  // ============================================================================

  getConfig(instanceId: string): AgentInstanceConfig | undefined {
    return this.configs.get(instanceId)
  }

  listConfigs(): AgentInstanceConfig[] {
    return Array.from(this.configs.values())
  }

  async updateConfig(params: UpdateAgentConfigParams): Promise<AgentInstanceConfig> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await this.updateConfigUnlocked(params)
    } finally {
      release()
    }
  }

  private async updateConfigUnlocked(params: UpdateAgentConfigParams): Promise<AgentInstanceConfig> {
    const existing = this.configs.get(params.instance_id)
    if (!existing) {
      throw new Error(`Config not found for instance: ${params.instance_id}`)
    }

    const updated: AgentInstanceConfig = {
      ...existing,
      ...(params.system_prompt !== undefined && { system_prompt: params.system_prompt }),
      ...(params.model_config !== undefined && { model_config: params.model_config }),
      ...(params.mcp_server_ids !== undefined && { mcp_server_ids: params.mcp_server_ids }),
      ...(params.skill_ids !== undefined && { skill_ids: params.skill_ids }),
      ...(params.max_iterations !== undefined && { max_iterations: params.max_iterations }),
      ...(params.tools_readonly !== undefined && { tools_readonly: params.tools_readonly }),
      ...(params.timezone !== undefined && { timezone: params.timezone }),
      ...(params.extra !== undefined && { extra: params.extra }),
    }

    const apply = async () => {
      this.configs.set(params.instance_id, updated)
      await this.saveConfig(params.instance_id)
    }
    const domains: ConfigDomain[] = [
      ...(params.model_config !== undefined && canonicalizeJson(existing.model_config) !== canonicalizeJson(updated.model_config) ? ['models' as const] : []),
      ...(
        (params.system_prompt !== undefined && existing.system_prompt !== updated.system_prompt) ||
        (params.max_iterations !== undefined && existing.max_iterations !== updated.max_iterations) ||
        (params.tools_readonly !== undefined && existing.tools_readonly !== updated.tools_readonly) ||
        (params.timezone !== undefined && existing.timezone !== updated.timezone) ||
        (params.extra !== undefined && canonicalizeJson(existing.extra ?? {}) !== canonicalizeJson(updated.extra ?? {}))
          ? ['behavior' as const]
          : []
      ),
    ]
    if (params.instance_id === 'crabot-agent' && this.mutationRunner && domains.length > 0) {
      await this.mutationRunner(domains, async () => this.previewSemanticSnapshot(
        () => this.configs.set(params.instance_id, updated),
        () => this.configs.set(params.instance_id, existing),
      ), apply)
    } else {
      await apply()
    }
    this.onConfigChangedCallback?.()
    return updated
  }

  /** 注入配置变更回调，由 index.ts 设置 */
  setOnConfigChanged(fn: () => void): void {
    this.onConfigChangedCallback = fn
  }

  setMutationRunner(runner: ConfigMutationRunner): void {
    this.mutationRunner = runner
  }

  setSemanticSnapshotProvider(provider: () => unknown): void {
    this.semanticSnapshotProvider = provider
  }

  private async previewSemanticSnapshot(temporarilyApply: () => void, rollback: () => void): Promise<unknown> {
    temporarilyApply()
    try { return this.semanticSnapshotProvider?.() } finally { rollback() }
  }

  getSemanticCoreConfig(): AgentInstanceConfig | null {
    return this.configs.get('crabot-agent') ?? null
  }


  getUsedModels(): Array<{ provider_id: string; model_id: string }> {
    const result: Array<{ provider_id: string; model_id: string }> = []
    for (const config of this.configs.values()) {
      for (const ref of Object.values(config.model_config ?? {})) {
        result.push({ provider_id: ref.provider_id, model_id: ref.model_id })
      }
    }
    return result
  }

  getReferencesForProvider(providerId: string): string[] {
    const refs: string[] = []
    for (const [instanceId, config] of this.configs.entries()) {
      for (const [roleKey, ref] of Object.entries(config.model_config ?? {})) {
        if (ref.provider_id === providerId) {
          refs.push(`Agent "${CORE_AGENT_INSTANCE.name}" 的 ${roleKey} 角色`)
        }
      }
    }
    return refs
  }

  // ============================================================================
  // 数据持久化
  // ============================================================================

  private async loadData(): Promise<void> {
    await this.loadConfigs()
  }


  private async loadConfigs(): Promise<void> {
    try {
      const files = await fs.readdir(this.configsDir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const filePath = path.join(this.configsDir, file)
        const data = await fs.readFile(filePath, 'utf-8')
        const config = JSON.parse(data) as AgentInstanceConfig & { model_config?: Record<string, Record<string, unknown>> }

        // Snapshot migration is deliberately deferred: coordinator must first validate
        // the exact persisted semantic state, then own the single durable rewrite.
        if (config.model_config) {
          let hasSnapshot = false
          for (const val of Object.values(config.model_config)) {
            if (val && typeof val === 'object' && 'endpoint' in val) {
              hasSnapshot = true
              break
            }
          }
          if (hasSnapshot) {
            this.pendingSnapshotConfigMigrations.add(config.instance_id)
            console.log(`[AgentManager] Loaded legacy snapshot config ${file}; migration deferred until coordinator is ready`)
          }
        }

        // P6-D：只有 exact core 配置进入运行时；legacy instance config 属于 archive（§3.18）。
        if (config.instance_id !== 'crabot-agent') continue
        this.configs.set(config.instance_id, config as AgentInstanceConfig)
      }
      console.log(`[AgentManager] Loaded ${this.configs.size} configs`)
    } catch {
      console.log('[AgentManager] No existing configs data')
    }
  }

  /** 仅保证 exact core 配置容器存在（空 model config 是合法未配置状态，§3.18）。 */
  private async ensureCoreConfig(): Promise<void> {
    if (!this.configs.has('crabot-agent')) {
      const config = { ...DEFAULT_AGENT_CONFIG }
      const apply = async () => {
        this.configs.set('crabot-agent', config)
        await this.saveConfig('crabot-agent')
      }
      if (this.mutationRunner) {
        await this.mutationRunner(['models', 'behavior'], async () => this.previewSemanticSnapshot(
          () => this.configs.set('crabot-agent', config),
          () => this.configs.delete('crabot-agent'),
        ), apply)
      } else {
        await apply()
      }
    }
  }

  /** 启动时遍历所有实例 model_config，迁移旧 keys 与load-only snapshot到新 ModelRole */
  private async migrateAllModelConfigs(): Promise<void> {
    for (const [instanceId, config] of this.configs.entries()) {
      const oldMc = config.model_config ?? {}
      const referenceMc: Record<string, ModelSlotRef> = {}
      for (const [key, value] of Object.entries(oldMc as Record<string, ModelSlotRef & { endpoint?: unknown }>)) {
        if (value && typeof value === 'object' && 'endpoint' in value) {
          if (typeof value.provider_id === 'string' && typeof value.model_id === 'string') {
            referenceMc[key] = { provider_id: value.provider_id, model_id: value.model_id }
          }
        } else if (value && typeof value.provider_id === 'string' && typeof value.model_id === 'string') {
          referenceMc[key] = { provider_id: value.provider_id, model_id: value.model_id }
        }
      }
      const beforeKeys = Object.keys(oldMc).sort().join(',')
      const migrated = migrateModelConfig(referenceMc)
      const afterKeys = Object.keys(migrated).sort().join(',')
      const snapshotMigration = this.pendingSnapshotConfigMigrations.has(instanceId)
      if (beforeKeys !== afterKeys || snapshotMigration) {
        console.log(
          `[AgentManager] 实例 ${instanceId} model_config 迁移: [${beforeKeys}] → [${afterKeys}]`
        )
        const updatedConfig = { ...config, model_config: migrated }
        const apply = async () => {
          this.configs.set(instanceId, updatedConfig)
          await this.saveConfig(instanceId)
        }
        if (instanceId === 'crabot-agent' && this.mutationRunner) {
          await this.mutationRunner(['models'], async () => this.previewSemanticSnapshot(
            () => this.configs.set(instanceId, updatedConfig),
            () => this.configs.set(instanceId, config),
          ), apply)
        } else {
          await apply()
        }
        this.pendingSnapshotConfigMigrations.delete(instanceId)
      }
    }
  }

  // ============================================================================
  // 原子写入
  // ============================================================================

  /**
   * 原子写入文件：先写临时文件，再 rename（避免进程被杀时文件损坏）
   */
  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    await durableAtomicWriteFile(filePath, content)
  }

  private async saveConfig(instanceId: string): Promise<void> {
    const config = this.configs.get(instanceId)
    if (!config) return
    await fs.mkdir(this.configsDir, { recursive: true })
    const filePath = path.join(this.configsDir, `${instanceId}.json`)
    await this.atomicWriteFile(filePath, JSON.stringify(config, null, 2))
  }
}

// ============================================================================
// model_config migration
// ============================================================================

/** 旧 model_config slot key → 新 ModelRole 的迁移映射 */
const LEGACY_ROLE_MIGRATION: Record<string, ModelRole> = {
  default: 'powerful',
  worker: 'powerful',
  smart: 'powerful',
  triage: 'cost_effective',
  digest: 'cost_effective',
  fast: 'cost_effective',
  vision_expert: 'vision',
  // coding_expert 不迁移：阶段 2 由 code_planner / code_writer 替代，
  // 各自走 powerful / cost_effective role；现有 coding_expert 配置丢弃即可。
}

const KNOWN_NEW_KEYS: ReadonlySet<string> = new Set(['powerful', 'cost_effective', 'vision', 'manager'])

/**
 * 迁移 model_config 旧 keys 到新 ModelRole。
 * - 已是新 key（powerful/cost_effective/vision）直接保留
 * - 旧 key 通过 LEGACY_ROLE_MIGRATION 映射；多个旧 key 映射到同一新 key 时不覆盖（保留先遇到的）
 * - 不识别的 key 丢弃并 console.warn
 */
export function migrateModelConfig(
  oldConfig: Record<string, ModelSlotRef>
): Record<string, ModelSlotRef> {
  const next: Record<string, ModelSlotRef> = {}
  for (const [oldKey, ref] of Object.entries(oldConfig)) {
    if (KNOWN_NEW_KEYS.has(oldKey)) {
      if (!next[oldKey]) next[oldKey] = ref
      continue
    }
    const mapped = LEGACY_ROLE_MIGRATION[oldKey]
    if (mapped) {
      if (!next[mapped]) {
        next[mapped] = ref  // 不覆盖
      }
    } else {
      console.warn(`[agent-manager] migration: 丢弃未知 model_config slot key "${oldKey}"`)
    }
  }
  return next
}
