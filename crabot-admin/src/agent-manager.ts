/**
 * Agent 管理器
 *
 * 负责 Agent 实现（Implementation）、实例（Instance）和配置（Config）的管理
 */

import fs from 'fs/promises'
import path from 'path'
import { canonicalizeJson, generateTimestamp, type RpcClient } from 'crabot-shared'
import { durableAtomicWriteFile } from './durable-file.js'
import type {
  AgentImplementation,
  AgentInstance,
  AgentInstanceConfig,
  CreateAgentInstanceParams,
  UpdateAgentInstanceParams,
  UpdateAgentConfigParams,
  ListAgentImplementationsParams,
  ListAgentInstancesParams,
  ModelSlotRef,
  ModelRole,
} from './types.js'

import type { ConfigDomain, CoreAgentConfigMutationContext } from './core-agent-config-revision-store.js'

export type ConfigMutationRunner = (
  domains: ConfigDomain[],
  prepareAfterSnapshot: () => Promise<unknown>,
  applySourceMutation: (context: CoreAgentConfigMutationContext) => Promise<void>,
) => Promise<void>


export const DEFAULT_IMPLEMENTATION: AgentImplementation = {
  id: 'default',
  name: 'Crabot Default Agent',
  type: 'builtin',
  implementation_type: 'config_only',
  engine: 'claude-agent-sdk',
  supported_roles: ['front', 'worker'],
  model_format: 'anthropic',
  model_roles: [
    {
      key: 'powerful',
      description: '强力模型，用于主 worker / 复杂推理 / planning',
      required: true,
      recommended_capabilities: ['tool_use', 'long_context'],
      used_by: ['front', 'worker'],
      fallback: 'global_default',
    },
    {
      key: 'cost_effective',
      description: '性价比模型，用于简单执行 / 摘要 / 低复杂度调用',
      required: false,
      recommended_capabilities: ['fast'],
      used_by: ['front', 'worker'],
      fallback: 'global_default',
    },
    {
      key: 'vision',
      description: '视觉模型，用于截图分析 / UI 识别 / 图片内容理解',
      required: false,
      recommended_capabilities: ['vision'],
      used_by: ['worker'],
      fallback: 'none',
    },
    {
      // protocol-agent-v3.md §11：manager loop 的对话与工具调用决策用模型。
      // fallback 特意选 'none'（而不是 'global_default'）：未配置时不由 Admin 自动填全局默认，
      // 而是把"未配置"这个事实原样透传给 agent 侧——agent 按 model_config.manager ?? model_config.powerful
      // 解析（见 crabot-agent/src/manager/model-slot.ts），这样当用户已显式给 powerful 配了非默认
      // provider/model 时，manager 会跟着用 powerful 的实际值，而不是被 Admin 全局默认覆盖掉。
      key: 'manager',
      description: 'Manager loop 用模型，负责对话与决策；未配置时回退到 powerful',
      required: false,
      recommended_capabilities: ['tool_use', 'long_context'],
      used_by: ['front'],
      fallback: 'none',
    },
  ],
  extra_schema: [
    {
      key: 'progress_report_master_private',
      title: 'Master 私聊汇报',
      description: 'Master 私聊场景下的进度汇报行为',
      type: 'select',
      default: 'digest',
      options: [
        { value: 'silent', label: '静默' },
        { value: 'text_forward', label: '文本转发' },
        { value: 'digest', label: '定期摘要' },
      ],
    },
    {
      key: 'progress_report_other_private',
      title: '其他私聊汇报',
      description: '非 Master 的普通好友私聊场景下的进度汇报行为',
      type: 'select',
      default: 'silent',
      options: [
        { value: 'silent', label: '静默' },
        { value: 'text_forward', label: '文本转发' },
        { value: 'digest', label: '定期摘要' },
      ],
    },
    {
      key: 'progress_report_group',
      title: '群聊汇报',
      description: '群聊场景下的进度汇报行为',
      type: 'select',
      default: 'silent',
      options: [
        { value: 'silent', label: '静默' },
        { value: 'text_forward', label: '文本转发' },
        { value: 'digest', label: '定期摘要' },
      ],
    },
    {
      key: 'progress_digest_interval_seconds',
      title: '摘要间隔（秒）',
      description: '定期摘要模式下的汇报间隔',
      type: 'number',
      default: 1800,
      visible_when: {
        any_of: [
          'progress_report_master_private',
          'progress_report_other_private',
          'progress_report_group',
        ],
        equals: 'digest',
      },
    },
    {
      key: 'progress_digest_mode',
      title: '摘要模式',
      description: 'llm: 用 LLM 生成摘要；extract: 直接提取关键句',
      type: 'select',
      default: 'llm',
      options: [
        { value: 'llm', label: 'LLM 摘要' },
        { value: 'extract', label: '提取关键句' },
      ],
      visible_when: {
        any_of: [
          'progress_report_master_private',
          'progress_report_other_private',
          'progress_report_group',
        ],
        equals: 'digest',
      },
    },
    {
      key: 'group_attention_min_ms',
      title: '群聊最小巡检间隔（ms）',
      description: 'Agent 刚回复后的最小巡检间隔',
      type: 'number',
      default: 120000,
    },
    {
      key: 'group_attention_max_ms',
      title: '群聊最大巡检间隔（ms）',
      description: '群聊巡检间隔的上限',
      type: 'number',
      default: 1800000,
    },
    {
      key: 'goal_mode_enabled',
      title: '目标模式',
      description: '启用后 Worker 可设定任务目标承诺，完成时触发独立审计校验；关闭后直接完成任务无需审计',
      type: 'boolean',
      default: true,
    },
  ],
  version: '0.1.0',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

const DEFAULT_AGENT_INSTANCE: AgentInstance = {
  id: 'crabot-agent',
  implementation_id: 'default',
  name: 'Crabot Agent',
  specialization: 'Unified agent with front and worker capabilities',
  max_concurrent_tasks: 5,
  auto_start: true,
  start_priority: 20,
  module_registered: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

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
  private implementations: Map<string, AgentImplementation> = new Map()
  private instances: Map<string, AgentInstance> = new Map()
  private configs: Map<string, AgentInstanceConfig> = new Map()
  /** Loaded snapshot configs that must only be persisted after coordinator recovery. */
  private readonly pendingSnapshotConfigMigrations = new Set<string>()

  private readonly dataDir: string
  private readonly implementationsFilePath: string
  private readonly instancesFilePath: string
  private readonly configsDir: string
  private onConfigChangedCallback: (() => void) | null = null
  private mutationRunner: ConfigMutationRunner | null = null
  private semanticSnapshotProvider: (() => unknown) | null = null
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.implementationsFilePath = path.join(dataDir, 'agent-implementations.json')
    this.instancesFilePath = path.join(dataDir, 'agent-instances.json')
    this.configsDir = path.join(dataDir, 'agent-configs')
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await fs.mkdir(this.configsDir, { recursive: true })
    await this.loadData()
  }

  /**
   * Startup load is deliberately write-free. Admin must attach its coordinator after
   * all persisted source managers are loaded, then call this method for any migration.
   */
  async initializeStandaloneDefaults(): Promise<void> {
    if (this.mutationRunner) throw new Error('Standalone defaults are not allowed with a coordinator')
    await this.ensureDefaults()
  }

  async initializeCoreDefaultsAndMigrations(): Promise<void> {
    await this.ensureDefaults()
    await this.migrateAllModelConfigs()
  }

  // ============================================================================
  // Implementation CRUD
  // ============================================================================

  listImplementations(params?: ListAgentImplementationsParams): {
    items: AgentImplementation[]
    pagination: { page: number; page_size: number; total_items: number; total_pages: number }
  } {
    let items = Array.from(this.implementations.values())

    if (params?.type) {
      items = items.filter((i) => i.type === params.type)
    }
    if (params?.engine) {
      items = items.filter((i) => i.engine === params.engine)
    }

    const page = params?.page ?? 1
    const pageSize = params?.page_size ?? 20
    const total = items.length
    const totalPages = Math.ceil(total / pageSize)
    const offset = (page - 1) * pageSize

    return {
      items: items.slice(offset, offset + pageSize),
      pagination: { page, page_size: pageSize, total_items: total, total_pages: totalPages },
    }
  }

  getImplementation(id: string): AgentImplementation | undefined {
    return this.implementations.get(id)
  }

  async addImplementation(impl: AgentImplementation): Promise<AgentImplementation> {
    this.implementations.set(impl.id, impl)
    await this.saveImplementations()
    return impl
  }

  async removeImplementation(id: string): Promise<void> {
    if (id === 'default') {
      throw new Error('Cannot remove builtin default implementation')
    }

    const hasInstances = Array.from(this.instances.values()).some(
      (inst) => inst.implementation_id === id
    )
    if (hasInstances) {
      throw new Error('Cannot remove implementation with existing instances')
    }

    this.implementations.delete(id)
    await this.saveImplementations()
  }

  // ============================================================================
  // Instance CRUD
  // ============================================================================

  listInstances(params?: ListAgentInstancesParams): {
    items: AgentInstance[]
    pagination: { page: number; page_size: number; total_items: number; total_pages: number }
  } {
    let items = Array.from(this.instances.values())

    if (params?.implementation_id) {
      items = items.filter((i) => i.implementation_id === params.implementation_id)
    }
    if (params?.auto_start !== undefined) {
      items = items.filter((i) => i.auto_start === params.auto_start)
    }

    const page = params?.page ?? 1
    const pageSize = params?.page_size ?? 20
    const total = items.length
    const totalPages = Math.ceil(total / pageSize)
    const offset = (page - 1) * pageSize

    return {
      items: items.slice(offset, offset + pageSize),
      pagination: { page, page_size: pageSize, total_items: total, total_pages: totalPages },
    }
  }

  getInstance(id: string): AgentInstance | undefined {
    return this.instances.get(id)
  }

  /**
   * Test/import compatibility seam. Production entrypoints never pass true; live dynamic Agent
   * creation remains rejected before any write. P6-D removes this legacy record constructor.
   */
  async createInstance(
    params: CreateAgentInstanceParams,
    allowLegacyArchiveWrite = false
  ): Promise<AgentInstance> {
    if (!allowLegacyArchiveWrite) {
      throw Object.assign(new Error('Dynamic Agent instances are retired; only builtin crabot-agent is supported'), {
        code: 'ADMIN_HOTPLUG_NOT_ALLOWED',
      })
    }
    const impl = this.implementations.get(params.implementation_id)
    if (!impl) {
      throw new Error(`Implementation not found: ${params.implementation_id}`)
    }

    const now = generateTimestamp()
    const instance: AgentInstance = {
      id: params.name.toLowerCase().replace(/\s+/g, '-'),
      implementation_id: params.implementation_id,
      name: params.name,
      specialization: params.specialization,
      max_concurrent_tasks: params.max_concurrent_tasks ?? 5,
      auto_start: params.auto_start ?? true,
      start_priority: params.start_priority ?? 20,
      module_registered: false,
      created_at: now,
      updated_at: now,
    }

    if (this.instances.has(instance.id)) {
      throw new Error(`Instance already exists: ${instance.id}`)
    }

    this.instances.set(instance.id, instance)
    await this.saveInstances()

    // 创建默认配置
    const defaultConfig: AgentInstanceConfig = {
      instance_id: instance.id,
      system_prompt: '',
      model_config: {},
      max_iterations: 10,
      tools_readonly: false,
    }
    this.configs.set(instance.id, defaultConfig)
    await this.saveConfig(instance.id)

    return instance
  }

  async updateInstance(params: UpdateAgentInstanceParams): Promise<AgentInstance> {
    const existing = this.instances.get(params.instance_id)
    if (!existing) {
      throw new Error(`Instance not found: ${params.instance_id}`)
    }

    const updated: AgentInstance = {
      ...existing,
      ...(params.name !== undefined && { name: params.name }),
      ...(params.specialization !== undefined && { specialization: params.specialization }),
      ...(params.max_concurrent_tasks !== undefined && { max_concurrent_tasks: params.max_concurrent_tasks }),
      ...(params.auto_start !== undefined && { auto_start: params.auto_start }),
      ...(params.start_priority !== undefined && { start_priority: params.start_priority }),
      updated_at: generateTimestamp(),
    }

    this.instances.set(params.instance_id, updated)
    await this.saveInstances()
    return updated
  }

  async deleteInstance(id: string, rpcClient?: RpcClient): Promise<void> {
    const instance = this.instances.get(id)
    if (!instance) {
      throw new Error(`Instance not found: ${id}`)
    }

    const impl = this.implementations.get(instance.implementation_id)

    // 如果是已安装的实现且已注册，先停止并注销模块
    if (impl?.type === 'installed' && instance.module_registered && rpcClient) {
      try {
        await rpcClient.stopModule(id, 'admin')
        await rpcClient.unregisterModuleDefinition(id, 'admin')
        console.log(`[AgentManager] Module stopped and unregistered: ${id}`)
      } catch (error) {
        console.warn(`[AgentManager] Failed to cleanup module ${id}:`, error)
      }
    }

    this.instances.delete(id)
    this.configs.delete(id)
    await this.saveInstances()

    // 删除配置文件
    const configPath = path.join(this.configsDir, `${id}.json`)
    try {
      await fs.unlink(configPath)
    } catch {
      // 配置文件可能不存在
    }
  }

  private async deleteConfig(instanceId: string): Promise<void> {
    const configPath = path.join(this.configsDir, `${instanceId}.json`)
    try {
      await fs.unlink(configPath)
    } catch {
      // 配置文件可能不存在
    }
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
          const instance = this.instances.get(instanceId)
          const name = instance?.name || instanceId
          refs.push(`Agent "${name}" 的 ${roleKey} 角色`)
        }
      }
    }
    return refs
  }

  /** 获取所有自动启动的实例（按 start_priority 排序） */
  getAutoStartInstances(): AgentInstance[] {
    return Array.from(this.instances.values())
      .filter((i) => i.auto_start)
      .sort((a, b) => a.start_priority - b.start_priority)
  }

  // ============================================================================
  // 数据持久化
  // ============================================================================

  private async loadData(): Promise<void> {
    await this.loadImplementations()
    await this.loadInstances()
    await this.loadConfigs()
  }

  private async loadImplementations(): Promise<void> {
    try {
      const data = await fs.readFile(this.implementationsFilePath, 'utf-8')
      const items = JSON.parse(data) as AgentImplementation[]
      for (const item of items) {
        this.implementations.set(item.id, item)
      }
      console.log(`[AgentManager] Loaded ${this.implementations.size} implementations`)
    } catch {
      console.log('[AgentManager] No existing implementations data')
    }
  }

  private async loadInstances(): Promise<void> {
    try {
      const data = await fs.readFile(this.instancesFilePath, 'utf-8')
      const items = JSON.parse(data) as AgentInstance[]
      for (const item of items) {
        this.instances.set(item.id, item)
      }
      console.log(`[AgentManager] Loaded ${this.instances.size} instances`)
    } catch {
      console.log('[AgentManager] No existing instances data')
    }
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

        this.configs.set(config.instance_id, config as AgentInstanceConfig)
      }
      console.log(`[AgentManager] Loaded ${this.configs.size} configs`)
    } catch {
      console.log('[AgentManager] No existing configs data')
    }
  }

  private async ensureDefaults(): Promise<void> {
    // 确保默认实现存在，且内置实现的 model_roles 始终与代码同步
    const existingImpl = this.implementations.get('default')
    if (!existingImpl) {
      this.implementations.set('default', DEFAULT_IMPLEMENTATION)
      await this.saveImplementations()
    } else if (existingImpl.type === 'builtin') {
      // 内置实现的 model_roles/supported_roles/model_format 由代码定义，启动时强制同步
      const updated = {
        ...existingImpl,
        model_roles: DEFAULT_IMPLEMENTATION.model_roles,
        extra_schema: DEFAULT_IMPLEMENTATION.extra_schema,
        supported_roles: DEFAULT_IMPLEMENTATION.supported_roles,
        model_format: DEFAULT_IMPLEMENTATION.model_format,
        updated_at: new Date().toISOString(),
      }
      this.implementations.set('default', updated)
      await this.saveImplementations()
    }

    // 确保 crabot-agent 实例存在
    if (!this.instances.has('crabot-agent')) {
      this.instances.set('crabot-agent', DEFAULT_AGENT_INSTANCE)
      await this.saveInstances()
    }

    // 确保 crabot-agent 配置存在
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

  private async saveImplementations(): Promise<void> {
    const items = Array.from(this.implementations.values())
    await this.atomicWriteFile(this.implementationsFilePath, JSON.stringify(items, null, 2))
  }

  private async saveInstances(): Promise<void> {
    const items = Array.from(this.instances.values())
    await this.atomicWriteFile(this.instancesFilePath, JSON.stringify(items, null, 2))
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
