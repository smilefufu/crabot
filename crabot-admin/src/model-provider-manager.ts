/**
 * 模型供应商管理器
 *
 * 负责模型供应商的配置、验证、存储和分发
 * Agent/Memory 直连 Provider，不经过中间代理
 */

import fs from 'fs/promises'
import path from 'path'
import { generateId, generateTimestamp } from 'crabot-shared'
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
  OAuthCredential,
  ApiFormat,
  ModelType,
  ProxyConfig,
} from './types.js'
import { findPresetVendor } from './preset-vendors.js'

export class ModelProviderManager {
  private providers: Map<string, ModelProvider> = new Map()
  private globalConfig: GlobalModelConfig = {}
  private moduleConfigs: Map<string, ModuleModelConfig> = new Map()
  private agentConfigRefsProvider: ((providerId: string) => string[]) | null = null

  private readonly dataDir: string
  private readonly providersFilePath: string
  private readonly globalConfigFilePath: string
  private readonly moduleConfigsDir: string
  private refreshInFlight: Map<string, Promise<import('./oauth/openai-codex-oauth.js').OAuthLoginResult>> = new Map()

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.providersFilePath = path.join(dataDir, 'model_providers.json')
    this.globalConfigFilePath = path.join(dataDir, 'global_model_config.json')
    this.moduleConfigsDir = path.join(dataDir, 'module_model_configs')
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
      ...(params.auth_type && { auth_type: params.auth_type }),
      models: params.models,
      status: 'active',
      created_at: now,
      updated_at: now,
    }

    this.providers.set(provider.id, provider)
    await this.saveProviders()

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

    console.log(`[ModelProviderManager] Deleted provider ${id}`)
  }

  // ============================================================================
  // Provider references
  // ============================================================================

  setAgentConfigRefsProvider(fn: (providerId: string) => string[]): void {
    this.agentConfigRefsProvider = fn
  }

  // ============================================================================
  // OAuth Credential Management
  // ============================================================================

  async setOAuthCredential(providerId: string, credential: OAuthCredential): Promise<void> {
    const provider = this.providers.get(providerId)
    if (!provider) throw new Error(`Provider not found: ${providerId}`)

    const updated = {
      ...provider,
      auth_type: 'oauth' as const,
      oauth_credential: credential,
      updated_at: generateTimestamp(),
    }
    this.providers.set(providerId, updated)
    await this.saveProviders()
  }

  async clearOAuthCredential(providerId: string): Promise<void> {
    const provider = this.providers.get(providerId)
    if (!provider) throw new Error(`Provider not found: ${providerId}`)

    const updated = {
      ...provider,
      oauth_credential: undefined,
      api_key: '',
      updated_at: generateTimestamp(),
    }
    this.providers.set(providerId, updated)
    await this.saveProviders()
  }

  getOAuthCredential(providerId: string): OAuthCredential | undefined {
    return this.providers.get(providerId)?.oauth_credential
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

  async testProviderModel(id: string, modelId?: string): Promise<{ success: boolean; latency_ms: number; error?: string }> {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error('Provider not found')
    }

    let model: ModelInfo | undefined
    if (modelId) {
      model = provider.models.find(m => m.model_id === modelId)
      if (!model) {
        throw new Error(`Model "${modelId}" not found in provider "${provider.name}"`)
      }
    } else {
      model = provider.models[0]
      if (!model) {
        return { success: false, latency_ms: 0, error: 'No models configured' }
      }
    }

    // OAuth provider：检查 credential 是否存在且未过期
    if (provider.auth_type === 'oauth') {
      if (!provider.oauth_credential) {
        return { success: false, latency_ms: 0, error: 'OAuth 未登录，请先完成 ChatGPT 登录' }
      }
      if (Date.now() > provider.oauth_credential.expires_at) {
        return { success: false, latency_ms: 0, error: 'OAuth token 已过期，请重新登录' }
      }
      return { success: true, latency_ms: 0 }
    }

    const startTime = Date.now()
    try {
      let result: ValidationResult
      if (model.type === 'embedding') {
        result = await this.detectEmbeddingDimension(
          provider.endpoint, provider.api_key, model.model_id, provider.format
        )
        if (result.success && result.dimension) {
          model.dimension = result.dimension
        }
      } else {
        result = await this.testLLMConnection(
          provider.endpoint, provider.api_key, model.model_id, provider.format
        )
      }
      const latency_ms = Date.now() - startTime

      if (result.success && !modelId) {
        provider.status = 'active'
        provider.last_validated_at = generateTimestamp()
        provider.validation_error = undefined
        await this.saveProviders()
      }

      return { success: result.success, latency_ms, error: result.error }
    } catch (error) {
      const latency_ms = Date.now() - startTime
      const errorMessage = error instanceof Error ? error.message : String(error)

      if (!modelId) {
        provider.status = 'error'
        provider.validation_error = errorMessage
        await this.saveProviders()
      }

      return { success: false, latency_ms, error: errorMessage }
    }
  }

  async refreshModels(id: string): Promise<{ models: ModelInfo[]; added: string[]; removed: string[] }> {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error('Provider not found')
    }
    if (provider.type !== 'preset' || !provider.preset_vendor) {
      throw new Error('Only preset providers support model refresh')
    }

    const vendor = findPresetVendor(provider.preset_vendor)
    if (!vendor) {
      throw new Error(`Unknown vendor: ${provider.preset_vendor}`)
    }

    const freshModels = await this.fetchVendorModels(
      { ...vendor, endpoint: provider.endpoint },
      provider.api_key
    )

    const oldIds = new Set(provider.models.map(m => m.model_id))
    const newIds = new Set(freshModels.map(m => m.model_id))

    const added = freshModels.filter(m => !oldIds.has(m.model_id)).map(m => m.model_id)
    const removed = provider.models.filter(m => !newIds.has(m.model_id)).map(m => m.model_id)

    const mergedModels = freshModels.map(fresh => {
      const existing = provider.models.find(m => m.model_id === fresh.model_id)
      return existing ? { ...fresh, dimension: existing.dimension } : fresh
    })

    provider.models = mergedModels
    provider.updated_at = generateTimestamp()
    this.providers.set(id, provider)
    await this.saveProviders()

    return { models: mergedModels, added, removed }
  }

  getProviderReferences(id: string): { references: string[] } {
    const refs: string[] = []

    if (this.globalConfig.default_llm_provider_id === id) {
      refs.push('全局默认 LLM 模型')
    }
    if (this.globalConfig.default_embedding_provider_id === id) {
      refs.push('全局默认 Embedding 模型')
    }

    for (const [moduleId, config] of this.moduleConfigs.entries()) {
      if (config.llm_provider_id === id) {
        refs.push(`模块 "${moduleId}" 的 LLM 配置`)
      }
      if (config.embedding_provider_id === id) {
        refs.push(`模块 "${moduleId}" 的 Embedding 配置`)
      }
    }

    if (this.agentConfigRefsProvider) {
      refs.push(...this.agentConfigRefsProvider(id))
    }

    return { references: refs }
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
      } else if (format === 'openai-responses') {
        // OAuth providers: 跳过 LLM 连接测试（需要有效 OAuth token）
        return { success: true }
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
      auth_type: vendor.auth_type,
      models,
    })

    return { provider, models }
  }

  private async fetchVendorModels(vendor: PresetVendor, apiKey: string): Promise<ModelInfo[]> {
    if (!vendor.models_api) {
      return vendor.default_models ? [...vendor.default_models] : []
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

  async buildConnectionInfo(providerId: string, modelId: string): Promise<LLMConnectionInfo | EmbeddingConnectionInfo> {
    const provider = this.providers.get(providerId)
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`)
    }

    const model = provider.models.find((m) => m.model_id === modelId)
    if (!model) {
      throw new Error(`Model not found: ${modelId} in provider ${providerId}`)
    }

    // OAuth provider：使用 access_token，过期时自动刷新
    let apikey = provider.api_key
    if (provider.auth_type === 'oauth' && provider.oauth_credential) {
      if (Date.now() > provider.oauth_credential.expires_at - 60_000) {
        // Token 即将过期（<1分钟），去重刷新
        try {
          let refreshPromise = this.refreshInFlight.get(providerId)
          if (!refreshPromise) {
            refreshPromise = (async () => {
              const { refreshOAuthToken } = await import('./oauth/openai-codex-oauth.js')
              return refreshOAuthToken(provider.oauth_credential!.refresh_token)
            })()
            this.refreshInFlight.set(providerId, refreshPromise)
            refreshPromise.finally(() => this.refreshInFlight.delete(providerId))
          }
          const refreshed = await refreshPromise
          await this.setOAuthCredential(providerId, {
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token,
            expires_at: refreshed.expires_at,
            account_id: refreshed.account_id,
            email: refreshed.email,
          })
          apikey = refreshed.access_token
        } catch (err) {
          console.error(`[ModelProviderManager] OAuth token refresh failed for ${providerId}:`, err)
          apikey = provider.oauth_credential.access_token
        }
      } else {
        apikey = provider.oauth_credential.access_token
      }
    }

    // 直连 Provider：返回 provider 原始连接信息
    // endpoint 存储不含 /v1 的 base URL，各 adapter 自行拼接路径
    const base = {
      endpoint: provider.endpoint,
      apikey,
      model_id: model.model_id,
      format: provider.format,
      provider_id: providerId,
    }

    if (model.dimension !== undefined) {
      return { ...base, dimension: model.dimension } as EmbeddingConnectionInfo
    }

    return {
      ...base,
      ...(model.max_tokens !== undefined && { max_tokens: model.max_tokens }),
      ...(model.supports_vision && { supports_vision: true }),
    } as LLMConnectionInfo
  }

  // ============================================================================
  // Global Config
  // ============================================================================

  getGlobalConfig(): GlobalModelConfig {
    return { ...this.globalConfig }
  }

  /**
   * 获取代理配置
   */
  getProxyConfig(): ProxyConfig {
    return this.globalConfig.proxy ?? { mode: 'system' }
  }

  /**
   * 更新代理配置
   */
  async updateProxyConfig(proxy: ProxyConfig): Promise<void> {
    this.globalConfig = { ...this.globalConfig, proxy }
    await this.saveGlobalConfig()
  }

  async updateGlobalConfig(config: Partial<GlobalModelConfig>): Promise<GlobalModelConfig> {
    this.globalConfig = { ...this.globalConfig, ...config }
    await this.saveGlobalConfig()
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
        proxy: raw.proxy,
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

  private async httpRequest(
    url: string,
    options: {
      method: string
      headers?: Record<string, string>
      body?: string
    }
  ): Promise<string> {
    const response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
    })

    const data = await response.text()

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${data}`)
    }

    return data
  }
}