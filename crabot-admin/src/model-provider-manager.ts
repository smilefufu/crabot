/**
 * 模型供应商管理器
 *
 * 负责模型供应商的配置、验证、存储和分发
 * 通过修改 LiteLLM config.yaml 来管理模型，保存后重启 LiteLLM
 */

import fs from 'fs/promises'
import path from 'path'
import http from 'http'
import https from 'https'
import { spawn } from 'child_process'
import { generateId, generateTimestamp } from './core/base-protocol.js'
import type {
  ModelProvider,
  ModelInfo,
  PresetVendor,
  GlobalModelConfig,
  ModuleModelConfig,
  LLMConnectionInfo,
  EmbeddingConnectionInfo,
  ValidationResult,
  CreateModelProviderParams,
  UpdateModelProviderParams,
  ImportFromVendorParams,
  ImportFromVendorResult,
  ResolveModelConfigParams,
  ApiFormat,
  ModelType,
} from './types.js'
import { findPresetVendor } from './preset-vendors.js'

/**
 * LiteLLM config.yaml 模型配置
 */
interface LiteLLMModelConfig {
  model_name: string
  litellm_params: {
    model: string
    api_base?: string
    api_key: string
  }
}

/**
 * LiteLLM config.yaml 结构
 */
interface LiteLLMConfig {
  model_list: LiteLLMModelConfig[]
  litellm_settings: {
    drop_params: boolean
    set_verbose: boolean
  }
  general_settings: {
    master_key: string
  }
}

export class ModelProviderManager {
  private providers: Map<string, ModelProvider> = new Map()
  private globalConfig: GlobalModelConfig = {}
  private moduleConfigs: Map<string, ModuleModelConfig> = new Map()
  private litellmRestartPending: boolean = false
  private usedModelsProvider: (() => Array<{ provider_id: string; model_id: string }>) | null = null
  /** 提供所有模块 env 配置中引用的 LiteLLM 模型名（用于按需加载） */
  private moduleEnvModelsProvider: (() => string[]) | null = null
  private lastLiteLLMYaml: string = ''

  private readonly dataDir: string
  private readonly providersFilePath: string
  private readonly globalConfigFilePath: string
  private readonly moduleConfigsDir: string
  private readonly litellmConfigPath: string
  private readonly litellmBaseUrl: string
  private readonly litellmMasterKey: string

  constructor(
    dataDir: string,
    litellmConfigPath: string,
    litellmBaseUrl: string = 'http://localhost:4000',
    litellmMasterKey: string = 'sk-litellm-test-key-12345'
  ) {
    this.dataDir = dataDir
    this.providersFilePath = path.join(dataDir, 'model_providers.json')
    this.globalConfigFilePath = path.join(dataDir, 'global_model_config.json')
    this.moduleConfigsDir = path.join(dataDir, 'module_model_configs')
    this.litellmConfigPath = litellmConfigPath
    this.litellmBaseUrl = litellmBaseUrl
    this.litellmMasterKey = litellmMasterKey
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await fs.mkdir(this.moduleConfigsDir, { recursive: true })
    await this.loadData()
  }

  // ============================================================================
  // Provider CRUD
  // ============================================================================

  async createProvider(params: CreateModelProviderParams): Promise<ModelProvider> {
    const now = generateTimestamp()
    const provider: ModelProvider = {
      id: generateId(),
      name: params.name,
      type: params.type,
      format: params.format,
      endpoint: params.endpoint,
      api_key: params.api_key,
      preset_vendor: params.preset_vendor,
      models: params.models,
      status: 'active',
      created_at: now,
      updated_at: now,
    }

    this.providers.set(provider.id, provider)
    await this.saveProviders()
    await this.syncToLiteLLMConfig()

    console.log(`[ModelProviderManager] Created provider ${provider.id} (${provider.name})`)
    return provider
  }

  getProvider(id: string): ModelProvider | undefined {
    return this.providers.get(id)
  }

  listProviders(): ModelProvider[] {
    return Array.from(this.providers.values())
  }

  async updateProvider(id: string, params: UpdateModelProviderParams): Promise<ModelProvider> {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error('Provider not found')
    }

    // 更新本地数据
    if (params.name !== undefined) provider.name = params.name
    if (params.endpoint !== undefined) provider.endpoint = params.endpoint
    if (params.api_key !== undefined) provider.api_key = params.api_key
    if (params.models !== undefined) provider.models = params.models
    if (params.status !== undefined) provider.status = params.status

    provider.updated_at = generateTimestamp()

    this.providers.set(id, provider)
    await this.saveProviders()
    await this.syncToLiteLLMConfig()

    console.log(`[ModelProviderManager] Updated provider ${id}`)
    return provider
  }

  async deleteProvider(id: string): Promise<void> {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error('Provider not found')
    }

    this.providers.delete(id)
    await this.saveProviders()
    await this.syncToLiteLLMConfig()

    console.log(`[ModelProviderManager] Deleted provider ${id}`)
  }

  // ============================================================================
  // On-demand sync API
  // ============================================================================

  setUsedModelsProvider(fn: () => Array<{ provider_id: string; model_id: string }>): void {
    this.usedModelsProvider = fn
  }

  /** 注入回调：提供各模块 env 配置中引用的 LiteLLM 模型名列表 */
  setModuleEnvModelsProvider(fn: () => string[]): void {
    this.moduleEnvModelsProvider = fn
  }

  requestSync(): void {
    this.syncToLiteLLMConfig().catch((err) => {
      console.error('[ModelProviderManager] Background sync failed:', err)
    })
  }

  private computeNeededModelKeys(): Set<string> {
    const keys = new Set<string>()
    const add = (pid?: string, mid?: string) => {
      if (pid && mid) keys.add(`${pid}::${mid}`)
    }

    // GlobalModelConfig
    add(this.globalConfig.default_llm_provider_id, this.globalConfig.default_llm_model_id)
    add(this.globalConfig.default_embedding_provider_id, this.globalConfig.default_embedding_model_id)

    // ModuleModelConfig
    for (const mc of this.moduleConfigs.values()) {
      add(mc.llm_provider_id, mc.llm_model_id)
      add(mc.embedding_provider_id, mc.embedding_model_id)
    }

    // AgentInstanceConfig（通过注入的回调获取）
    if (this.usedModelsProvider) {
      for (const { provider_id, model_id } of this.usedModelsProvider()) {
        add(provider_id, model_id)
      }
    }

    // 模块 env 配置中的 LiteLLM 模型名（如 Memory 模块的 CRABOT_LLM_MODEL）
    // 需要反向解析为 provider_id::model_id
    if (this.moduleEnvModelsProvider) {
      for (const litellmName of this.moduleEnvModelsProvider()) {
        for (const [provId, provider] of this.providers) {
          for (const model of provider.models) {
            if (this.generateLiteLLMModelName(provId, model.model_id) === litellmName) {
              add(provId, model.model_id)
            }
          }
        }
      }
    }

    return keys
  }

  // ============================================================================
  // LiteLLM Config Sync
  // ============================================================================

  /**
   * 同步 providers 到 LiteLLM config.yaml
   */
  private async syncToLiteLLMConfig(): Promise<void> {
    const modelList: LiteLLMModelConfig[] = []

    // 计算需要的模型集合
    const neededKeys = this.computeNeededModelKeys()

    for (const provider of this.providers.values()) {
      // 只同步 active 状态的 provider
      if (provider.status !== 'active') continue

      // 为每个模型创建配置
      for (const model of provider.models) {
        const key = `${provider.id}::${model.model_id}`
        if (!neededKeys.has(key)) continue  // 只处理被引用的模型

        const modelName = this.generateLiteLLMModelName(provider.id, model.model_id)
        const litellmModelId = this.buildLiteLLMModelId(provider, model.model_id)

        // 对于 Ollama，api_base 不应该包含 /v1
        let apiBase = provider.endpoint
        if (provider.preset_vendor === 'ollama' && apiBase.endsWith('/v1')) {
          apiBase = apiBase.slice(0, -3) // 移除末尾的 /v1
        }

        modelList.push({
          model_name: modelName,
          litellm_params: {
            model: litellmModelId,
            api_base: apiBase,
            api_key: provider.api_key,
          },
        })
      }
    }

    const config: LiteLLMConfig = {
      model_list: modelList,
      litellm_settings: {
        drop_params: true,
        set_verbose: false,
      },
      general_settings: {
        master_key: `os.environ/LITELLM_MASTER_KEY`,
      },
    }

    // no-op 优化：YAML 未变则跳过写文件和重启
    const yamlContent = this.toYaml(config)
    if (yamlContent === this.lastLiteLLMYaml) {
      console.log(`[ModelProviderManager] LiteLLM config unchanged, skipping restart`)
      return
    }
    this.lastLiteLLMYaml = yamlContent

    // 写入 config.yaml
    await fs.writeFile(this.litellmConfigPath, yamlContent, 'utf-8')

    console.log(`[ModelProviderManager] Synced ${modelList.length} needed models to LiteLLM config`)

    // 后台重启 LiteLLM，不阻塞调用方
    this.scheduleRestartLiteLLM()
  }

  /**
   * 调度后台重启（防止并发重复重启）
   */
  private scheduleRestartLiteLLM(): void {
    if (this.litellmRestartPending) {
      console.log('[ModelProviderManager] LiteLLM restart already pending, skipping')
      return
    }
    this.litellmRestartPending = true
    // 异步执行，不 await，不阻塞调用链
    this.restartLiteLLM()
      .catch((err) => {
        console.error('[ModelProviderManager] LiteLLM restart failed:', err)
      })
      .finally(() => {
        this.litellmRestartPending = false
      })
  }

  private generateLiteLLMModelName(providerId: string, modelId: string): string {
    // 格式: provider-{id前8位}-{model_id}
    // 例如: provider-bdbf737d-qwen3.5:cloud
    const shortId = providerId.slice(0, 8)
    // 清理 model_id 中的特殊字符
    const cleanModelId = modelId.replace(/[:/]/g, '-').replace(/[^a-zA-Z0-9-_]/g, '')
    return `provider-${shortId}-${cleanModelId}`
  }

  private buildLiteLLMModelId(provider: ModelProvider, modelId: string): string {
    // LiteLLM 格式:
    // - Ollama: ollama/{model_id}
    // - 其他: {format}/{model_id}
    if (provider.preset_vendor === 'ollama') {
      return `ollama/${modelId}`
    }
    return `${provider.format}/${modelId}`
  }

  /**
   * 简单的 YAML 序列化（不依赖第三方库）
   */
  private toYaml(config: LiteLLMConfig): string {
    const lines: string[] = ['# LiteLLM Proxy 配置', '# 由 crabot-admin 自动生成', '']

    // model_list
    lines.push('model_list:')
    for (const model of config.model_list) {
      lines.push(`  - model_name: "${model.model_name}"`)
      lines.push('    litellm_params:')
      lines.push(`      model: "${model.litellm_params.model}"`)
      if (model.litellm_params.api_base) {
        lines.push(`      api_base: "${model.litellm_params.api_base}"`)
      }
      lines.push(`      api_key: "${model.litellm_params.api_key}"`)
    }

    // litellm_settings
    lines.push('')
    lines.push('litellm_settings:')
    lines.push('  drop_params: true')
    lines.push('  set_verbose: false')

    // 不配置 general_settings.master_key
    // LiteLLM 无数据库时，设置 master_key 会导致所有 API 调用报 "No connected db" 错误
    // LiteLLM 仅在本地运行，作为内部代理不需要认证

    return lines.join('\n')
  }

  /**
   * 重启 LiteLLM
   */
  private async restartLiteLLM(): Promise<void> {
    console.log('[ModelProviderManager] Restarting LiteLLM...')

    // 查找并杀死现有 LiteLLM 进程
    try {
      await new Promise<void>((resolve) => {
        const killProcess = spawn('pkill', ['-f', 'litellm'])
        killProcess.on('close', () => {
          setTimeout(resolve, 1000) // 等待进程完全退出
        })
      })
    } catch {
      // 忽略错误
    }

    // 启动新的 LiteLLM 进程
    const configDir = path.dirname(this.litellmConfigPath)

    // 使用 spawn 在后台启动
    const litellmProcess = spawn('litellm', ['--config', this.litellmConfigPath, '--port', '4000'], {
      cwd: configDir,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        // 清除代理设置，避免 LiteLLM 通过不可用的代理访问外部 API
        all_proxy: '',
        ALL_PROXY: '',
        http_proxy: '',
        HTTP_PROXY: '',
        https_proxy: '',
        HTTPS_PROXY: '',
        no_proxy: '',
        NO_PROXY: '',
      },
    })

    litellmProcess.unref()

    // 等待 LiteLLM 启动
    await this.waitForLiteLLM()

    console.log('[ModelProviderManager] LiteLLM restarted')
  }

  /**
   * 等待 LiteLLM 启动
   */
  private async waitForLiteLLM(maxAttempts: number = 120): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await this.httpRequest(`${this.litellmBaseUrl}/health`, {
          method: 'GET',
        })
        if (response) {
          return
        }
      } catch {
        // 忽略错误，继续等待
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error('LiteLLM failed to start within timeout')
  }

  // ============================================================================
  // Validation
  // ============================================================================

  async validateProvider(id: string): Promise<ValidationResult> {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error('Provider not found')
    }

    try {
      // 验证至少一个模型
      if (provider.models.length === 0) {
        return { success: false, error: 'No models configured' }
      }

      // 测试第一个模型的连接
      const model = provider.models[0]
      if (model.type === 'embedding') {
        const result = await this.detectEmbeddingDimension(
          provider.endpoint,
          provider.api_key,
          model.model_id,
          provider.format
        )
        if (!result.success) {
          return result
        }
        // 更新维度
        model.dimension = result.dimension
      } else {
        const result = await this.testLLMConnection(
          provider.endpoint,
          provider.api_key,
          model.model_id,
          provider.format
        )
        if (!result.success) {
          return result
        }
      }

      // 更新验证状态
      provider.status = 'active'
      provider.last_validated_at = generateTimestamp()
      provider.validation_error = undefined
      await this.saveProviders()

      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      provider.status = 'error'
      provider.validation_error = errorMessage
      await this.saveProviders()

      return { success: false, error: errorMessage }
    }
  }

  private async detectEmbeddingDimension(
    endpoint: string,
    apiKey: string,
    modelId: string,
    format: ApiFormat
  ): Promise<ValidationResult> {
    try {
      if (format === 'openai') {
        const response = await this.httpRequest(`${endpoint}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelId,
            input: 'dimension probe',
          }),
        })

        const data = JSON.parse(response)
        if (data.data?.[0]?.embedding) {
          return { success: true, dimension: data.data[0].embedding.length }
        }
        return { success: false, error: 'Invalid response format' }
      } else if (format === 'gemini') {
        const response = await this.httpRequest(
          `${endpoint}/models/${modelId}:embedContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: { parts: [{ text: 'dimension probe' }] },
            }),
          }
        )

        const data = JSON.parse(response)
        if (data.embedding?.values) {
          return { success: true, dimension: data.embedding.values.length }
        }
        return { success: false, error: 'Invalid response format' }
      }

      return { success: false, error: `Unsupported format: ${format}` }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async testLLMConnection(
    endpoint: string,
    apiKey: string,
    modelId: string,
    format: ApiFormat
  ): Promise<ValidationResult> {
    try {
      if (format === 'openai') {
        const response = await this.httpRequest(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'test' }],
            max_tokens: 5,
          }),
        })

        const data = JSON.parse(response)
        if (data.choices?.[0]?.message) {
          return { success: true }
        }
        return { success: false, error: 'Invalid response format' }
      } else if (format === 'anthropic') {
        const response = await this.httpRequest(`${endpoint}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'test' }],
            max_tokens: 5,
          }),
        })

        const data = JSON.parse(response)
        if (data.content) {
          return { success: true }
        }
        return { success: false, error: 'Invalid response format' }
      } else if (format === 'gemini') {
        const response = await this.httpRequest(
          `${endpoint}/models/${modelId}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: 'test' }] }],
            }),
          }
        )

        const data = JSON.parse(response)
        if (data.candidates) {
          return { success: true }
        }
        return { success: false, error: 'Invalid response format' }
      }

      return { success: false, error: `Unsupported format: ${format}` }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // ============================================================================
  // Vendor Import
  // ============================================================================

  async importFromVendor(params: ImportFromVendorParams): Promise<ImportFromVendorResult> {
    const vendor = findPresetVendor(params.vendor_id)
    if (!vendor) {
      throw new Error(`Unknown vendor: ${params.vendor_id}`)
    }

    // 允许用户覆盖 endpoint（用于非本地部署，如远程 Ollama）
    const endpoint = params.endpoint?.trim() || vendor.endpoint

    // 获取模型列表
    const models = await this.fetchVendorModels({ ...vendor, endpoint }, params.api_key)

    // 创建 provider
    const provider = await this.createProvider({
      name: vendor.name,
      type: 'preset',
      format: vendor.format,
      endpoint,
      api_key: params.api_key,
      preset_vendor: vendor.id,
      models,
    })

    return { provider, models }
  }

  private async fetchVendorModels(vendor: PresetVendor, apiKey: string): Promise<ModelInfo[]> {
    if (!vendor.models_api) {
      return []
    }

    try {
      const response = await this.httpRequest(`${vendor.endpoint}${vendor.models_api}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      })

      const data = JSON.parse(response)
      const models: ModelInfo[] = []

      // OpenAI 格式的模型列表
      if (data.data && Array.isArray(data.data)) {
        for (const item of data.data) {
          const modelId = item.id || item.model
          if (!modelId) continue

          // 判断模型类型
          const isEmbedding = modelId.includes('embedding') || modelId.includes('embed')
          const type: ModelType = isEmbedding ? 'embedding' : 'llm'

          models.push({
            model_id: modelId,
            display_name: item.name || modelId,
            type,
            supports_vision: item.capabilities?.vision || false,
            // OpenRouter 用 context_length，OpenAI 用 context_window
            context_window: item.context_window ?? item.context_length,
          })
        }
      }

      return models
    } catch (error) {
      console.error(`Failed to fetch models from ${vendor.name}:`, error)
      return []
    }
  }

  // ============================================================================
  // Config Resolution
  // ============================================================================

  async resolveModelConfig(params: ResolveModelConfigParams): Promise<LLMConnectionInfo | EmbeddingConnectionInfo> {
    // 1. 查找模块专属配置
    const moduleConfig = this.moduleConfigs.get(params.module_id)
    if (moduleConfig) {
      const providerId =
        params.role === 'llm'
          ? moduleConfig.llm_provider_id
          : moduleConfig.embedding_provider_id
      const modelId =
        params.role === 'llm' ? moduleConfig.llm_model_id : moduleConfig.embedding_model_id

      if (providerId && modelId) {
        return this.buildConnectionInfo(providerId, modelId)
      }
    }

    // 2. 使用全局默认配置
    const providerId =
      params.role === 'llm'
        ? this.globalConfig.default_llm_provider_id
        : this.globalConfig.default_embedding_provider_id
    const modelId =
      params.role === 'llm'
        ? this.globalConfig.default_llm_model_id
        : this.globalConfig.default_embedding_model_id

    if (!providerId || !modelId) {
      throw new Error(`No ${params.role} configuration found for module ${params.module_id}`)
    }

    return this.buildConnectionInfo(providerId, modelId)
  }

  buildConnectionInfo(providerId: string, modelId: string): LLMConnectionInfo | EmbeddingConnectionInfo {
    const provider = this.providers.get(providerId)
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`)
    }

    const model = provider.models.find((m) => m.model_id === modelId)
    if (!model) {
      throw new Error(`Model not found: ${modelId} in provider ${providerId}`)
    }

    // 使用 LiteLLM endpoint
    // Anthropic SDK 会在 baseURL 后追加 /v1/messages，所以不应包含 /v1
    const endpoint = this.litellmBaseUrl
    const apiKey = this.litellmMasterKey
    const litellmModelName = this.generateLiteLLMModelName(providerId, modelId)

    const base = {
      endpoint,
      apikey: apiKey,
      model_id: litellmModelName,
      // Agent 使用 Anthropic SDK，LiteLLM 提供格式转换
      format: 'anthropic' as const,
    }

    if (model.dimension !== undefined) {
      return { ...base, dimension: model.dimension } as EmbeddingConnectionInfo
    }

    return {
      ...base,
      // 透传模型的最大输出 token 数（在 Admin → 模型供应商 → 编辑模型 中配置）
      ...(model.max_tokens !== undefined && { max_tokens: model.max_tokens }),
    } as LLMConnectionInfo
  }

  // ============================================================================
  // Global Config
  // ============================================================================

  getGlobalConfig(): GlobalModelConfig {
    return { ...this.globalConfig }
  }

  async updateGlobalConfig(config: Partial<GlobalModelConfig>): Promise<GlobalModelConfig> {
    this.globalConfig = { ...this.globalConfig, ...config }
    await this.saveGlobalConfig()
    this.requestSync()
    return this.globalConfig
  }

  // ============================================================================
  // Module Config
  // ============================================================================

  getModuleConfig(moduleId: string): ModuleModelConfig | undefined {
    return this.moduleConfigs.get(moduleId)
  }

  listModuleConfigs(): ModuleModelConfig[] {
    return Array.from(this.moduleConfigs.values())
  }

  async updateModuleConfig(
    moduleId: string,
    config: Partial<Omit<ModuleModelConfig, 'module_id'>>
  ): Promise<ModuleModelConfig> {
    const existing = this.moduleConfigs.get(moduleId) || { module_id: moduleId }
    const updated = { ...existing, ...config }
    this.moduleConfigs.set(moduleId, updated)
    await this.saveModuleConfig(moduleId)
    this.requestSync()
    return updated
  }

  async deleteModuleConfig(moduleId: string): Promise<void> {
    this.moduleConfigs.delete(moduleId)
    const filePath = path.join(this.moduleConfigsDir, `${moduleId}.json`)
    try {
      await fs.unlink(filePath)
    } catch {
      // Ignore if file doesn't exist
    }
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  private async loadData(): Promise<void> {
    // Load providers
    try {
      const data = await fs.readFile(this.providersFilePath, 'utf-8')
      const providers = JSON.parse(data) as ModelProvider[]
      for (const provider of providers) {
        this.providers.set(provider.id, provider)
      }
      console.log(`[ModelProviderManager] Loaded ${this.providers.size} providers`)
    } catch {
      console.log('[ModelProviderManager] No existing providers data')
    }

    // Load global config（只取已知字段，防止历史脏数据污染内存和后续写入）
    try {
      const data = await fs.readFile(this.globalConfigFilePath, 'utf-8')
      const raw = JSON.parse(data)
      this.globalConfig = {
        default_llm_provider_id: raw.default_llm_provider_id,
        default_llm_model_id: raw.default_llm_model_id,
        default_embedding_provider_id: raw.default_embedding_provider_id,
        default_embedding_model_id: raw.default_embedding_model_id,
      }
      console.log('[ModelProviderManager] Loaded global config')
    } catch {
      console.log('[ModelProviderManager] No existing global config')
    }

    // Load module configs
    try {
      const files = await fs.readdir(this.moduleConfigsDir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const filePath = path.join(this.moduleConfigsDir, file)
        const data = await fs.readFile(filePath, 'utf-8')
        const config = JSON.parse(data) as ModuleModelConfig
        this.moduleConfigs.set(config.module_id, config)
      }
      console.log(`[ModelProviderManager] Loaded ${this.moduleConfigs.size} module configs`)
    } catch {
      console.log('[ModelProviderManager] No existing module configs')
    }

    // 加载已有 LiteLLM YAML 用于 no-op 比对
    try {
      this.lastLiteLLMYaml = await fs.readFile(this.litellmConfigPath, 'utf-8')
    } catch {
      this.lastLiteLLMYaml = ''
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

  private async saveProviders(): Promise<void> {
    const providers = Array.from(this.providers.values())
    await this.atomicWriteFile(this.providersFilePath, JSON.stringify(providers, null, 2))
  }

  private async saveGlobalConfig(): Promise<void> {
    await this.atomicWriteFile(this.globalConfigFilePath, JSON.stringify(this.globalConfig, null, 2))
  }

  private async saveModuleConfig(moduleId: string): Promise<void> {
    const config = this.moduleConfigs.get(moduleId)
    if (!config) return

    const filePath = path.join(this.moduleConfigsDir, `${moduleId}.json`)
    await this.atomicWriteFile(filePath, JSON.stringify(config, null, 2))
  }

  // ============================================================================
  // HTTP Helper
  // ============================================================================

  private httpRequest(
    url: string,
    options: {
      method: string
      headers?: Record<string, string>
      body?: string
    }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url)
      const client = urlObj.protocol === 'https:' ? https : http

      const req = client.request(
        url,
        {
          method: options.method,
          headers: options.headers,
        },
        (res: http.IncomingMessage) => {
          let data = ''
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString()
          })
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data)
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`))
            }
          })
        }
      )

      req.on('error', reject)

      if (options.body) {
        req.write(options.body)
      }

      req.end()
    })
  }
}