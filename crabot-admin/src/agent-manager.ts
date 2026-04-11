/**
 * Agent 管理器
 *
 * 负责 Agent 实现（Implementation）、实例（Instance）和配置（Config）的管理
 */

import fs from 'fs/promises'
import path from 'path'
import { generateTimestamp, type RpcClient } from 'crabot-shared'
import type { RuntimeManager } from './runtime-manager.js'
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
} from './types.js'

// ============================================================================
// 默认实现定义
// ============================================================================

const DEFAULT_IMPLEMENTATION: AgentImplementation = {
  id: 'default',
  name: 'Crabot Default Agent',
  type: 'builtin',
  implementation_type: 'config_only',
  engine: 'claude-agent-sdk',
  supported_roles: ['front', 'worker'],
  model_format: 'anthropic',
  model_roles: [
    {
      key: 'triage',
      description: '分诊模型，用于 Front Agent 消息意图判断和快速决策',
      required: false,
      recommended_capabilities: ['tool_use', 'fast'],
      used_by: ['front'],
      fallback: 'global_default',
    },
    {
      key: 'worker',
      description: '执行模型，用于 Worker Agent 执行实际任务',
      required: false,
      recommended_capabilities: ['tool_use', 'long_context'],
      used_by: ['worker'],
      fallback: 'global_default',
    },
    {
      key: 'digest',
      description: '摘要模型，用于生成进度汇报摘要（推荐小型快速模型）',
      required: false,
      recommended_capabilities: ['fast'],
      used_by: ['worker'],
      fallback: 'global_default',
    },
    {
      key: 'vision_expert',
      description: '视觉专家 Sub-agent，用于截图分析、UI 识别、浏览器页面理解',
      required: false,
      recommended_capabilities: ['vision'],
      used_by: ['worker'],
      fallback: 'none',
    },
    {
      key: 'coding_expert',
      description: '编码专家 Sub-agent，用于代码编写、代码分析、bug 修复',
      required: false,
      recommended_capabilities: ['coding', 'tool_use'],
      used_by: ['worker'],
      fallback: 'none',
    },
  ],
  extra_schema: [
    {
      key: 'progress_digest_enabled',
      title: '启用进度摘要',
      description: 'Worker 执行任务时定时向用户发送进度汇报',
      type: 'boolean',
      default: true,
    },
    {
      key: 'progress_digest_interval_seconds',
      title: '私聊摘要间隔（秒）',
      description: '私聊场景下的进度汇报间隔',
      type: 'number',
      default: 120,
    },
    {
      key: 'progress_digest_group_interval_seconds',
      title: '群聊摘要间隔（秒）',
      description: '群聊场景下的进度汇报间隔',
      type: 'number',
      default: 180,
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
    },
    {
      key: 'group_attention_min_ms',
      title: '群聊最小巡检间隔（ms）',
      description: 'Agent 刚回复后的最小巡检间隔',
      type: 'number',
      default: 5000,
    },
    {
      key: 'group_attention_max_ms',
      title: '群聊最大巡检间隔（ms）',
      description: '群聊巡检间隔的上限',
      type: 'number',
      default: 300000,
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

  private readonly dataDir: string
  private readonly implementationsFilePath: string
  private readonly instancesFilePath: string
  private readonly configsDir: string
  private onConfigChangedCallback: (() => void) | null = null

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
    await this.ensureDefaults()
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

  async createInstance(
    params: CreateAgentInstanceParams,
    rpcClient?: RpcClient,
    runtimeManager?: RuntimeManager
  ): Promise<AgentInstance> {
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
      supported_task_types: params.supported_task_types,
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

    // 如果是已安装的实现，注册并启动模块
    if (impl.type === 'installed' && impl.installed_path && rpcClient && runtimeManager) {
      try {
        // 构造启动命令
        const startCmd = runtimeManager.createStartCommand(
          {
            module_id: instance.id,
            module_type: 'agent',
            protocol_version: '1.0.0',
            name: instance.name,
            version: impl.version ?? '0.1.0',
            runtime: { type: 'nodejs' }, // 从 impl 获取
            entry: 'dist/main.js',        // 从 impl 获取
            env: {},
          },
          impl.installed_path
        )

        // 创建 ModuleDefinition
        const moduleDefinition = {
          module_id: instance.id,
          module_type: 'agent',
          entry: `${startCmd.command} ${startCmd.args.join(' ')}`,
          cwd: startCmd.cwd,
          env: {
            ...startCmd.env,
            CRABOT_MM_ENDPOINT: process.env.CRABOT_MM_ENDPOINT || 'http://localhost:19000',
            CRABOT_AGENT_CONFIG_PATH: path.join(
              this.dataDir,
              'agent-configs',
              `${instance.id}.json`
            ),
          },
          auto_start: instance.auto_start,
          start_priority: instance.start_priority,
        }

        // 向 Module Manager 注册
        await rpcClient.registerModuleDefinition(moduleDefinition, 'admin')

        // 更新实例状态
        instance.module_registered = true
        this.instances.set(instance.id, instance)
        await this.saveInstances()

        // 如果 auto_start，立即启动
        if (instance.auto_start) {
          await rpcClient.startModule(instance.id, 'admin')
        }

        console.log(`[AgentManager] Module registered and started: ${instance.id}`)
      } catch (error) {
        console.error(`[AgentManager] Failed to register/start module:`, error)
        // 回滚：删除实例记录
        this.instances.delete(instance.id)
        this.configs.delete(instance.id)
        await this.saveInstances()
        await this.deleteConfig(instance.id)
        throw error
      }
    }

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
      ...(params.supported_task_types !== undefined && { supported_task_types: params.supported_task_types }),
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
    const config = this.configs.get(instanceId)
    if (!config) return undefined

    // 迁移旧 slot key: fast → triage, smart → worker, 删除 default
    const mc = config.model_config
    if (mc && (mc['fast'] || mc['smart'] || mc['default'])) {
      const { fast, smart, default: _default, ...rest } = mc
      const newMc = {
        ...rest,
        ...(fast && !mc['triage'] ? { triage: fast } : {}),
        ...(smart && !mc['worker'] ? { worker: smart } : {}),
      }
      const migrated = { ...config, model_config: newMc }
      this.configs.set(instanceId, migrated)
      this.saveConfig(instanceId).catch(() => {})
      return migrated
    }

    return config
  }

  async updateConfig(params: UpdateAgentConfigParams): Promise<AgentInstanceConfig> {
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
      ...(params.extra !== undefined && { extra: params.extra }),
    }

    this.configs.set(params.instance_id, updated)
    await this.saveConfig(params.instance_id)
    this.onConfigChangedCallback?.()
    return updated
  }

  /** 注入配置变更回调，由 index.ts 设置 */
  setOnConfigChanged(fn: () => void): void {
    this.onConfigChangedCallback = fn
  }

  /** 获取所有 AgentInstanceConfig 中引用的 (provider_id, model_id) 对 */
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

        // 自动迁移：快照格式 → 引用格式
        if (config.model_config) {
          let migrated = false
          const migratedModelConfig: Record<string, ModelSlotRef> = {}
          for (const [key, val] of Object.entries(config.model_config)) {
            if (val && typeof val === 'object' && 'endpoint' in val) {
              // 旧快照格式（有 endpoint 字段）
              if (val.provider_id && typeof val.provider_id === 'string' && typeof val.model_id === 'string') {
                // 有 provider_id：可提取引用
                migratedModelConfig[key] = { provider_id: val.provider_id as string, model_id: val.model_id as string }
              }
              // 无 provider_id（旧格式遗留数据）：丢弃，fallback 到全局默认
              migrated = true
            } else if (val && typeof val === 'object' && 'provider_id' in val && 'model_id' in val && !('endpoint' in val)) {
              // 已是引用格式
              migratedModelConfig[key] = { provider_id: val.provider_id as string, model_id: val.model_id as string }
            }
          }
          ;(config as { model_config: Record<string, ModelSlotRef> }).model_config = migratedModelConfig
          if (migrated) {
            await this.atomicWriteFile(filePath, JSON.stringify(config, null, 2))
            console.log(`[AgentManager] Migrated config ${file} from snapshot to ref format`)
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
      this.configs.set('crabot-agent', config)
      await this.saveConfig('crabot-agent')
    }
  }

  // ============================================================================
  // 原子写入
  // ============================================================================

  /**
   * 原子写入文件：先写临时文件，再 rename（避免进程被杀时文件损坏）
   */
  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.tmp`
    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, filePath)
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
    const filePath = path.join(this.configsDir, `${instanceId}.json`)
    await this.atomicWriteFile(filePath, JSON.stringify(config, null, 2))
  }
}
