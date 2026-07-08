/**
 * Channel 管理器
 *
 * 负责 Channel 实现（Implementation）、实例（Instance）和配置（Config）的管理
 */

import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { generateTimestamp, type RpcClient } from 'crabot-shared'
import type {
  ChannelImplementation,
  ChannelInstance,
  ChannelConfig,
  CreateChannelInstanceParams,
  UpdateChannelInstanceParams,
  UpdateChannelConfigParams,
  ListChannelImplementationsParams,
  ListChannelInstancesParams,
  ChannelOnboardingMethod,
} from './types.js'
import type { OnConflict } from './backup/import/import-types.js'

// ============================================================================
// 内置模块声明（只声明路径，元数据从 crabot-module.yaml 动态加载）
// ============================================================================

/** 内置 Channel 模块的相对路径（相对于 crabot-admin 根目录） */
const BUILTIN_MODULE_PATHS: readonly string[] = [
  '../crabot-channel-wechat',
  '../crabot-channel-telegram',
  '../crabot-channel-feishu',
  '../crabot-channel-dingtalk',
]

/**
 * 从 crabot-module.yaml 加载模块元数据，构造 ChannelImplementation
 */
function loadBuiltinImplementation(modulePath: string): ChannelImplementation | null {
  const resolvedPath = path.resolve(__dirname, '..', modulePath)
  const yamlPath = path.join(resolvedPath, 'crabot-module.yaml')

  if (!fsSync.existsSync(yamlPath)) {
    console.warn(`[ChannelManager] crabot-module.yaml not found: ${yamlPath}`)
    return null
  }

  try {
    const content = fsSync.readFileSync(yamlPath, 'utf-8')
    const parsed = (yaml.load(content) as Record<string, unknown>) ?? {}

    const now = generateTimestamp()
    const onboardingMethods = Array.isArray(parsed.onboarding_methods)
      ? (parsed.onboarding_methods as ChannelOnboardingMethod[])
      : undefined
    return {
      id: parsed.module_id as string,
      name: parsed.name as string,
      type: 'builtin',
      platform: inferPlatformFromModuleId(parsed.module_id as string),
      module_path: modulePath,
      version: (parsed.version as string) ?? '0.1.0',
      config_schema: parsed.config_schema as Record<string, unknown> | undefined,
      onboarding_methods: onboardingMethods,
      created_at: now,
      updated_at: now,
    }
  } catch (error) {
    console.error(`[ChannelManager] Failed to load crabot-module.yaml from ${yamlPath}:`, error)
    return null
  }
}

/**
 * 从 module_id 推断平台（channel-wechat → wechat）
 */
function inferPlatformFromModuleId(moduleId: string): string {
  const match = moduleId.match(/^channel-(.+)$/)
  return match ? match[1] : 'unknown'
}

// ============================================================================
// ChannelManager
// ============================================================================

export class ChannelManager {
  private implementations: Map<string, ChannelImplementation> = new Map()
  private instances: Map<string, ChannelInstance> = new Map()

  private readonly dataDir: string
  private readonly implementationsFilePath: string
  private readonly instancesFilePath: string
  private readonly configsDir: string
  private readonly rpcClient: RpcClient

  constructor(dataDir: string, rpcClient: RpcClient) {
    this.dataDir = dataDir
    this.implementationsFilePath = path.join(dataDir, 'channel-implementations.json')
    this.instancesFilePath = path.join(dataDir, 'channel-instances.json')
    this.configsDir = path.join(dataDir, 'channel-configs')
    this.rpcClient = rpcClient
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

  listImplementations(params?: ListChannelImplementationsParams): {
    items: ChannelImplementation[]
    pagination: { page: number; page_size: number; total_items: number; total_pages: number }
  } {
    let items = Array.from(this.implementations.values())

    if (params?.type) {
      items = items.filter((i) => i.type === params.type)
    }
    if (params?.platform) {
      items = items.filter((i) => i.platform === params.platform)
    }

    const page = params?.page ?? 1
    const pageSize = params?.page_size ?? 50
    const totalItems = items.length
    const totalPages = Math.ceil(totalItems / pageSize)
    const start = (page - 1) * pageSize

    return {
      items: items.slice(start, start + pageSize),
      pagination: { page, page_size: pageSize, total_items: totalItems, total_pages: totalPages },
    }
  }

  getImplementation(id: string): ChannelImplementation | undefined {
    return this.implementations.get(id)
  }

  async addImplementation(impl: ChannelImplementation): Promise<void> {
    this.implementations.set(impl.id, impl)
    await this.saveImplementations()
  }

  async removeImplementation(id: string): Promise<void> {
    this.implementations.delete(id)
    await this.saveImplementations()
  }

  // ============================================================================
  // Instance CRUD
  // ============================================================================

  listInstances(params?: ListChannelInstancesParams): {
    items: ChannelInstance[]
    pagination: { page: number; page_size: number; total_items: number; total_pages: number }
  } {
    let items = Array.from(this.instances.values())

    if (params?.platform) {
      items = items.filter((i) => i.platform === params.platform)
    }

    const page = params?.page ?? 1
    const pageSize = params?.page_size ?? 50
    const totalItems = items.length
    const totalPages = Math.ceil(totalItems / pageSize)
    const start = (page - 1) * pageSize

    return {
      items: items.slice(start, start + pageSize),
      pagination: { page, page_size: pageSize, total_items: totalItems, total_pages: totalPages },
    }
  }

  getInstance(id: string): ChannelInstance | undefined {
    return this.instances.get(id)
  }

  async createInstance(params: CreateChannelInstanceParams): Promise<ChannelInstance> {
    const impl = this.implementations.get(params.implementation_id)
    if (!impl) {
      throw new Error(`Implementation not found: ${params.implementation_id}`)
    }

    // 实例名即 module_id，确保唯一性
    const instanceId = params.name
    if (this.instances.has(instanceId)) {
      throw new Error(`Instance name already exists: ${params.name}`)
    }

    const now = generateTimestamp()
    const platform = params.platform ?? impl.platform

    const instance: ChannelInstance = {
      id: instanceId,
      implementation_id: params.implementation_id,
      name: params.name,
      platform,
      auto_start: params.auto_start ?? false,
      start_priority: 30,
      module_registered: false,
      created_at: now,
      updated_at: now,
    }

    this.instances.set(instance.id, instance)
    await this.saveInstances()

    // 保存初始环境变量配置
    if (params.env && Object.keys(params.env).length > 0) {
      await this.saveLocalConfig(instance.id, params.env)
    }

    // builtin 实现：注册到 Module Manager
    if (impl.type === 'builtin' && impl.module_path) {
      try {
        await this.registerBuiltinModule(impl, instance)
        const registered: ChannelInstance = { ...instance, module_registered: true }
        this.instances.set(registered.id, registered)
        await this.saveInstances()

        console.log(`[ChannelManager] ${impl.id} instance registered: ${instance.id}`)

        // MM 的 register_module_definition 仅注册定义（status=stopped），
        // 运行时新建实例需要显式 startModule 才能拉起进程。
        await this.startInstanceIfAutoStart(registered)

        return registered
      } catch (error) {
        console.error(`[ChannelManager] Failed to register ${impl.id} module:`, error)
        // 注册失败时回滚实例记录
        this.instances.delete(instance.id)
        await this.saveInstances()
        throw error
      }
    }

    return instance
  }

  /**
   * 若实例配置了 auto_start，调用 MM startModule 拉起进程。
   *
   * 启动失败不抛错（实例已落盘 + 注册成功），仅记日志，与 reRegisterInstances 行为一致。
   * ALREADY_RUNNING 视为成功。
   */
  private async startInstanceIfAutoStart(instance: ChannelInstance): Promise<void> {
    if (!instance.auto_start) return
    try {
      await this.rpcClient.startModule(instance.id, 'admin')
      console.log(`[ChannelManager] Auto-started: ${instance.id}`)
    } catch (error: any) {
      if (error?.message?.includes('ALREADY_RUNNING')) {
        console.log(`[ChannelManager] Already running: ${instance.id}`)
        return
      }
      console.error(`[ChannelManager] Failed to auto-start ${instance.id}:`, error)
    }
  }

  /**
   * 注册 builtin 实现的模块到 Module Manager
   */
  private async registerBuiltinModule(impl: ChannelImplementation, instance: ChannelInstance): Promise<void> {
    const resolvedModulePath = path.resolve(__dirname, '..', impl.module_path!)
    const entry = `node ${resolvedModulePath}/dist/main.js`
    const env = await this.buildModuleEnv(instance)

    await this.rpcClient.registerModuleDefinition(
      {
        module_id: instance.id,
        module_type: 'channel',
        entry,
        cwd: resolvedModulePath,
        env,
        auto_start: instance.auto_start,
        start_priority: instance.start_priority,
      },
      'admin'
    )
  }

  /**
   * 构建模块启动时的环境变量
   *
   * channel-wechat: CRABOT_MODULE_ID + channel-configs/<id>.json 中的 WECHAT_* 变量
   */
  private async buildModuleEnv(instance: ChannelInstance): Promise<Record<string, string>> {
    const instanceDataDir = path.join(this.dataDir, 'channels', instance.id)
    const env: Record<string, string> = {
      CRABOT_MODULE_ID: instance.id,
      DATA_DIR: instanceDataDir,
    }

    // 从 channel-configs/<id>.json 加载额外环境变量
    const localConfig = await this.loadLocalConfig(instance.id)
    if (localConfig) {
      for (const [key, value] of Object.entries(localConfig)) {
        if (typeof value === 'string') {
          env[key] = value
        }
      }
    }

    return env
  }

  /**
   * 读取 channel-configs/<id>.json 中的本地配置（环境变量格式）
   *
   * 用于 channel-wechat 等需要在启动前配置环境变量的模块。
   * 文件格式：{ "WECHAT_CONNECTOR_URL": "http://...", "WECHAT_API_KEY": "wct_..." }
   */
  async loadLocalConfig(instanceId: string): Promise<Record<string, string> | null> {
    const configPath = path.join(this.configsDir, `${instanceId}.json`)
    try {
      const data = await fs.readFile(configPath, 'utf-8')
      return JSON.parse(data) as Record<string, string>
    } catch {
      return null
    }
  }

  /**
   * 保存本地配置（环境变量格式）到 channel-configs/<id>.json
   */
  async saveLocalConfig(instanceId: string, config: Record<string, string>): Promise<void> {
    const configPath = path.join(this.configsDir, `${instanceId}.json`)
    await this.atomicWriteFile(configPath, JSON.stringify(config, null, 2))
  }

  async updateInstance(params: UpdateChannelInstanceParams): Promise<ChannelInstance> {
    const existing = this.instances.get(params.instance_id)
    if (!existing) {
      throw new Error(`Instance not found: ${params.instance_id}`)
    }

    // name 即 module_id，不允许通过 updateInstance 修改
    const updated: ChannelInstance = {
      ...existing,
      ...(params.auto_start !== undefined && { auto_start: params.auto_start }),
      updated_at: generateTimestamp(),
    }

    this.instances.set(params.instance_id, updated)
    await this.saveInstances()

    return updated
  }

  async deleteInstance(id: string): Promise<void> {
    const instance = this.instances.get(id)
    if (!instance) {
      throw new Error(`Instance not found: ${id}`)
    }

    if (instance.module_registered) {
      try {
        await this.rpcClient.stopModule(id, 'admin')
        await this.rpcClient.unregisterModuleDefinition(id, 'admin')
      } catch (error) {
        console.error(`[ChannelManager] Failed to unregister module:`, error)
      }
    }

    this.instances.delete(id)
    await this.saveInstances()
    await this.deleteConfigFile(id)
  }

  // ============================================================================
  // Config CRUD（通过 RPC 透传到 Channel 模块，见 protocol-channel §6.1）
  // ============================================================================

  async getConfig(instanceId: string): Promise<{ config: ChannelConfig; schema?: any }> {
    const instance = this.instances.get(instanceId)
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`)
    }

    // 解析模块地址
    const modules = await this.rpcClient.resolve({ module_id: instanceId }, 'admin')
    if (modules.length === 0) {
      throw new Error(`Channel module not running: ${instanceId}`)
    }

    const result = await this.rpcClient.call<Record<string, never>, { config: ChannelConfig; schema?: any }>(
      modules[0].port,
      'get_config',
      {},
      'admin'
    )
    return result
  }

  async updateConfig(params: UpdateChannelConfigParams): Promise<{ config: ChannelConfig; requires_restart: boolean }> {
    const instance = this.instances.get(params.instance_id)
    if (!instance) {
      throw new Error(`Instance not found: ${params.instance_id}`)
    }

    const modules = await this.rpcClient.resolve({ module_id: params.instance_id }, 'admin')
    if (modules.length === 0) {
      throw new Error(`Channel module not running: ${params.instance_id}`)
    }

    const result = await this.rpcClient.call<{ config: Partial<ChannelConfig> }, { config: ChannelConfig; requires_restart: boolean }>(
      modules[0].port,
      'update_config',
      { config: params.config },
      'admin'
    )
    return result
  }

  // ============================================================================
  // Health（通过 RPC 透传到 Channel 模块，见 protocol-channel §7.1）
  // ============================================================================

  async getHealth(instanceId: string): Promise<{ status: string; details: Record<string, unknown> }> {
    const instance = this.instances.get(instanceId)
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`)
    }

    const modules = await this.rpcClient.resolve({ module_id: instanceId }, 'admin')
    if (modules.length === 0) {
      throw new Error(`Channel module not running: ${instanceId}`)
    }

    const result = await this.rpcClient.call<Record<string, never>, { status: string; details: Record<string, unknown> }>(
      modules[0].port,
      'health',
      {},
      'admin'
    )
    return result
  }

  // ============================================================================
  // 重新注册 & 自动启动
  // ============================================================================

  /**
   * Admin 启动时重新注册所有 builtin 实现的实例到 MM
   *
   * MM 不持久化 registerModuleDefinition 的结果，重启后动态注册丢失。
   * 此方法在 Admin onStart() 中调用，确保已有实例重新注册。
   * 对 auto_start: true 的实例额外调用 startModule。
   */
  async reRegisterInstances(): Promise<void> {
    // 收集所有 builtin 实现的实例
    const builtinImplIds = new Set(
      Array.from(this.implementations.values())
        .filter((i) => i.type === 'builtin' && i.module_path)
        .map((i) => i.id)
    )
    const instances = Array.from(this.instances.values())
      .filter((i) => builtinImplIds.has(i.implementation_id))

    if (instances.length === 0) {
      return
    }

    console.log(`[ChannelManager] Re-registering ${instances.length} builtin channel instances to MM`)

    for (const instance of instances) {
      const impl = this.implementations.get(instance.implementation_id)
      if (!impl?.module_path) continue

      try {
        await this.registerBuiltinModule(impl, instance)

        // 注册成功，更新标志
        if (!instance.module_registered) {
          const updated: ChannelInstance = { ...instance, module_registered: true }
          this.instances.set(updated.id, updated)
        }

        console.log(`[ChannelManager] Re-registered: ${instance.id} (${impl.id})`)
      } catch (error: any) {
        // DUPLICATE_ID 表示 MM 没重启，模块已存在，忽略
        if (error?.message?.includes('DUPLICATE_ID') || error?.code === 'DUPLICATE_ID') {
          console.log(`[ChannelManager] Already registered (DUPLICATE_ID): ${instance.id}`)
        } else {
          console.error(`[ChannelManager] Failed to re-register ${instance.id}:`, error)
        }
      }
    }

    await this.saveInstances()

    // 自动启动 auto_start 实例
    const autoStartInstances = instances
      .filter((i) => i.auto_start)
      .sort((a, b) => a.start_priority - b.start_priority)

    for (const instance of autoStartInstances) {
      await this.startInstanceIfAutoStart(instance)
    }
  }

  getAutoStartInstances(): ChannelInstance[] {
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
  }

  private async loadImplementations(): Promise<void> {
    try {
      const data = await fs.readFile(this.implementationsFilePath, 'utf-8')
      const items = JSON.parse(data) as ChannelImplementation[]
      for (const item of items) {
        this.implementations.set(item.id, item)
      }
      console.log(`[ChannelManager] Loaded ${this.implementations.size} implementations`)
    } catch {
      console.log('[ChannelManager] No existing implementations data')
    }
  }

  private async loadInstances(): Promise<void> {
    try {
      const data = await fs.readFile(this.instancesFilePath, 'utf-8')
      const items = JSON.parse(data) as ChannelInstance[]
      for (const item of items) {
        this.instances.set(item.id, item)
      }
      console.log(`[ChannelManager] Loaded ${this.instances.size} instances`)
    } catch {
      console.log('[ChannelManager] No existing instances data')
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

  private async deleteConfigFile(instanceId: string): Promise<void> {
    const configPath = path.join(this.configsDir, `${instanceId}.json`)
    try {
      await fs.unlink(configPath)
    } catch {
      // 文件不存在，忽略
    }
  }

  async upsertInstanceById(
    instance: ChannelInstance,
    config: Record<string, string> | null,
    onConflict: OnConflict,
  ): Promise<'imported' | 'overwritten' | 'skipped'> {
    const exists = this.instances.has(instance.id)
    if (exists && onConflict === 'skip') return 'skipped'
    this.instances.set(instance.id, instance)
    await this.saveInstances()
    if (config !== null) {
      await this.saveLocalConfig(instance.id, config)
    }
    return exists ? 'overwritten' : 'imported'
  }

  private async ensureDefaults(): Promise<void> {
    let changed = false
    for (const modulePath of BUILTIN_MODULE_PATHS) {
      const impl = loadBuiltinImplementation(modulePath)
      if (!impl) continue

      const existing = this.implementations.get(impl.id)
      if (!existing) {
        this.implementations.set(impl.id, impl)
        changed = true
        console.log(`[ChannelManager] Registered builtin: ${impl.id}`)
      } else if (!existing.config_schema && impl.config_schema) {
        // 已有记录但缺少 config_schema（旧数据），补充
        this.implementations.set(impl.id, { ...existing, config_schema: impl.config_schema })
        changed = true
        console.log(`[ChannelManager] Updated config_schema for: ${impl.id}`)
      }
    }
    if (changed) {
      await this.saveImplementations()
    }
  }
}
