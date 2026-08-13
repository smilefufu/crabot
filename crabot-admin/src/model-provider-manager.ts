/**
 * 模型供应商管理器
 *
 * 负责模型供应商的配置、验证、存储和分发
 * Agent/Memory 直连 Provider，不经过中间代理
 */

import fs from 'fs/promises'
import path from 'path'
import { generateId, generateTimestamp } from 'crabot-shared'
import { durableAtomicWriteFile } from './durable-file.js'
import type {
  ModelProvider,
  ModelInfo,
  PresetVendor,
  GlobalModelConfig,
  ModuleModelConfig,
  LLMConnectionInfo,
  CreateModelProviderParams,
  UpdateModelProviderParams,
  ImportFromVendorParams,
  ImportFromVendorResult,
  ResolveModelConfigParams,
  OAuthCredential,
  ModelType,
  ProxyConfig,
} from './types.js'
import type { OnConflict } from './backup/import/import-types.js'
import { findPresetVendor } from './vendor-registry.js'
import type { ConfigDomain, CoreAgentConfigMutationContext } from './core-agent-config-revision-store.js'

export type ProviderConfigMutationRunner = (
  domains: ConfigDomain[],
  prepareAfterSnapshot: () => Promise<unknown>,
  applySourceMutation: (context: CoreAgentConfigMutationContext) => Promise<void>,
  allowRuntimeNoop?: boolean,
) => Promise<void>

/**
 * 错误体截断长度。中转/Provider 的 4xx body 经常 >200 字符，截太短看不到根因。
 * 1000 够覆盖典型 JSON 错误（message + type + param），同时避免日志爆量。
 */
const ERROR_BODY_TRUNCATE = 1000

function truncate(text: string): string {
  if (text.length <= ERROR_BODY_TRUNCATE) return text
  return `${text.slice(0, ERROR_BODY_TRUNCATE)}…(truncated, ${text.length} chars total)`
}

/**
 * 测速时 max_tokens 的兜底值，必须和 agent adapter 的 defaultAnthropicMaxTokens 同步
 * （anthropic-adapter.ts）。Anthropic SDK 强制要求 max_tokens；中转对该值的支持上限
 * 是常见失败点（mirror 默认 4096/8192），所以测速要按生产默认值打，不能用 1 蒙混。
 */
function defaultAnthropicMaxTokens(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('claude-3')) return 8192
  return 32768
}

type ProbeRequest =
  | { ok: true; url: string; headers: Record<string, string>; body: string }
  | { ok: false; error: string }

/**
 * 构造测速请求：payload 形态对齐生产 adapter，但用 stream:true 拉首字节。
 *
 * 为什么用 stream:true 而不是和生产 complete() 一样的 stream:false：
 *   生产 anthropic/openai adapter 走非流式 complete()，但"测速"关心的是 TTFT
 *   ——等完整生成（大 max_tokens 可能几十秒）UX 太差，也让 latency_ms 名实不符。
 *   stream:true 下 mirror 对 tools / system / 大 max_tokens / payload 体积的
 *   兼容性问题仍然会暴露（中转对这些字段的校验/拒绝发生在 SSE 解析前），所以测速
 *   能覆盖 99% 的中转坑；剩 1% 是"non-stream 路径独有的中转 bug"——这种 agent
 *   一旦发起 complete() 就会立刻炸出来，能感知到，无需测速兜底。
 *
 * 各 format payload 形态对齐：
 *   - anthropic: crabot-agent/src/engine/anthropic-adapter.ts streamOnce()
 *   - openai:    crabot-agent/src/engine/openai-adapter.ts streamOnce()
 *   - openai-responses: crabot-agent/src/engine/openai-responses-adapter.ts streamOnce()
 *
 * 关键差异点（相对旧测速）：
 *   1) 带 system / instructions 字段
 *   2) 带 tools 字段（noop 工具，暴露中转对 tools 的兼容性）
 *   3) max_tokens 用模型实际配置或 adapter 默认值（不是 1）
 */
function buildChatProbeRequest(
  provider: ModelProvider,
  model: ModelInfo,
  authToken: string
): ProbeRequest {
  const modelId = model.model_id

  if (provider.format === 'anthropic') {
    return {
      ok: true,
      url: `${provider.endpoint}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': authToken,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: model.max_tokens ?? defaultAnthropicMaxTokens(modelId),
        system: 'You are a connectivity probe. Reply with the single word ok.',
        messages: [{ role: 'user', content: 'ping' }],
        tools: [
          {
            name: 'noop',
            description: 'Connectivity probe tool — do not call.',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        stream: true,
      }),
    }
  }

  if (provider.format === 'openai' || provider.format === 'gemini') {
    // gemini 实际走 OpenAI 兼容端点（见 llm-adapter.ts 的 createAdapter）
    return {
      ok: true,
      url: `${provider.endpoint}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        model: modelId,
        ...(model.max_tokens !== undefined ? { max_tokens: model.max_tokens } : {}),
        messages: [
          { role: 'system', content: 'You are a connectivity probe. Reply with the single word ok.' },
          { role: 'user', content: 'ping' },
        ],
        stream: true,
        stream_options: { include_usage: true },
        tools: [
          {
            type: 'function',
            function: {
              name: 'noop',
              description: 'Connectivity probe tool — do not call.',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      }),
    }
  }

  if (provider.format === 'openai-responses') {
    const isCodexBackend = provider.endpoint.includes('chatgpt.com/backend-api')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    }
    if (isCodexBackend && provider.oauth_credential?.account_id) {
      headers['ChatGPT-Account-Id'] = provider.oauth_credential.account_id
    }
    const body: Record<string, unknown> = {
      model: modelId,
      instructions: 'You are a connectivity probe. Reply with the single word ok.',
      input: [{ type: 'message', role: 'user', content: 'ping' }],
      tools: [],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      stream: true,
    }
    if (isCodexBackend) {
      body.reasoning = { effort: 'medium', summary: 'auto' }
      body.include = ['reasoning.encrypted_content']
    } else if (model.max_tokens !== undefined) {
      body.max_output_tokens = model.max_tokens
    }
    return {
      ok: true,
      url: `${provider.endpoint}/responses`,
      headers,
      body: JSON.stringify(body),
    }
  }

  return { ok: false, error: `Unsupported format: ${(provider as { format: string }).format}` }
}

/**
 * vendor.vision_id_prefixes 后处理：响应不暴露 vision 字段，但 vendor 声明了
 * 某些命名族（如 claude- / gpt-）必然支持视觉时，把 supports_vision 强制置 true。
 * 已经被解析为 true 的模型保留 true，不下调（避免抹掉真实信号）。
 *
 * 注意保持 immutability（项目编码约定），返回新对象数组。
 */
function applyVendorVisionHints(
  models: ModelInfo[],
  visionPrefixes: readonly string[] | undefined
): ModelInfo[] {
  if (!visionPrefixes || visionPrefixes.length === 0) return models
  return models.map(m => {
    if (m.supports_vision) return m
    const hit = visionPrefixes.some(prefix => m.model_id.startsWith(prefix))
    return hit ? { ...m, supports_vision: true } : m
  })
}

/**
 * Codex `/models` 响应里只有 `visibility === 'list'` 的 SKU 会出现在 UI；
 * `hide` 用于内部模型（如 codex-auto-review），不应暴露给用户。
 */
function parseCodexModels(raw: unknown[]): ModelInfo[] {
  const models: ModelInfo[] = []
  for (const entry of raw) {
    const item = entry as Record<string, unknown>
    const slug = typeof item.slug === 'string' ? item.slug : ''
    if (!slug) continue
    if (item.visibility !== 'list') continue
    if (item.supported_in_api === false) continue

    const modalities = Array.isArray(item.input_modalities) ? (item.input_modalities as unknown[]) : []
    const supportsVision = modalities.includes('image')

    models.push({
      model_id: slug,
      display_name: (typeof item.display_name === 'string' && item.display_name) || slug,
      type: 'llm',
      supports_vision: supportsVision,
      context_window: typeof item.context_window === 'number' ? item.context_window : undefined,
    })
  }
  return models
}

const IMAGE_MODEL_HINTS = ['gpt-image', 'dall-e', 'image']
const NON_CHAT_MODEL_HINTS = ['embedding', 'embed', 'whisper', 'tts', 'moderation']

/** 非 chat 且非生图的模型（embedding/asr/tts/moderation），发现时直接排除 */
export function isNonChatModel(modelId: string): boolean {
  return NON_CHAT_MODEL_HINTS.some((h) => modelId.includes(h))
}

/** 按模型名判定 llm / image（v1 命名前缀/子串，宽进） */
export function classifyModelType(modelId: string): ModelType {
  return IMAGE_MODEL_HINTS.some((h) => modelId.includes(h)) ? 'image' : 'llm'
}

/** 把 resolveImageConfig 的结果映射成 ResolvedAgentConfig 的 image 字段 */
export function imageResultToConfigFields(
  res: { available: true; config: LLMConnectionInfo } | { available: false; reason: string },
): { image_config?: LLMConnectionInfo; image_capability: { available: boolean; reason?: string } } {
  if (res.available) {
    return { image_config: res.config, image_capability: { available: true } }
  }
  return { image_capability: { available: false, reason: res.reason } }
}

/**
 * OpenAI 兼容 `/models` 响应解析：{data: [{id, ...}]}
 */
export function parseOpenAIModels(raw: unknown[]): ModelInfo[] {
  const models: ModelInfo[] = []
  for (const entry of raw) {
    const item = entry as Record<string, unknown>
    const modelId =
      (typeof item.id === 'string' && item.id) ||
      (typeof item.model === 'string' && item.model) ||
      (typeof item.slug === 'string' && item.slug) ||
      ''
    if (!modelId) continue

    // embedding / asr / tts / moderation 等非 chat 非生图模型直接跳过（走 chat completions 会 4xx）。
    // 生图模型（gpt-image / dall-e）不再跳过，归类 type:'image' 供图像 slot 引用。
    if (isNonChatModel(modelId)) {
      continue
    }

    const type: ModelType = classifyModelType(modelId)

    const capabilities = item.capabilities as { vision?: boolean } | undefined
    const modalities = Array.isArray(item.input) ? (item.input as unknown[]) : []
    // 仅 llm 认视觉；image 模型的 input=image 是"生图输入"不是"看图"，不置 supports_vision。
    // supports_image_in：kimi coding 端点 /v1/models 的字段（非 OpenAI 标准），同为布尔。
    const supportsVision =
      type === 'llm' &&
      (capabilities?.vision === true || modalities.includes('image') || item.supports_image_in === true)

    models.push({
      model_id: modelId,
      display_name:
        (typeof item.display_name === 'string' && item.display_name) ||
        (typeof item.name === 'string' && item.name) ||
        modelId,
      type,
      supports_vision: supportsVision,
      context_window:
        (typeof item.context_window === 'number' ? item.context_window : undefined) ??
        (typeof item.context_length === 'number' ? item.context_length : undefined) ??
        (typeof item.context_tokens === 'number' ? item.context_tokens : undefined),
    })
  }
  return models
}

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
  private mutationRunner: ProviderConfigMutationRunner | null = null
  private semanticSnapshotProvider: (() => unknown) | null = null
  private mutationTail: Promise<void> = Promise.resolve()

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

  setMutationRunner(runner: ProviderConfigMutationRunner): void {
    this.mutationRunner = runner
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  private async mutateRuntimeConfig(
    domains: ConfigDomain[],
    preview: () => Promise<unknown>,
    apply: () => Promise<void>,
    allowRuntimeNoop = false,
  ): Promise<void> {
    if (this.mutationRunner) return this.mutationRunner(domains, preview, apply, allowRuntimeNoop)
    return apply()
  }

  setSemanticSnapshotProvider(provider: () => unknown): void {
    this.semanticSnapshotProvider = provider
  }

  private async previewSemanticSnapshot(temporarilyApply: () => void, rollback: () => void): Promise<unknown> {
    temporarilyApply()
    try { return this.semanticSnapshotProvider?.() } finally { rollback() }
  }


  async createProvider(params: CreateModelProviderParams): Promise<ModelProvider> {
    return this.serial(() => this.createProviderUnlocked(params))
  }

  private async createProviderUnlocked(params: CreateModelProviderParams): Promise<ModelProvider> {
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

    await this.mutateRuntimeConfig(['models'], async () => this.previewSemanticSnapshot(
      () => this.providers.set(provider.id, provider),
      () => this.providers.delete(provider.id),
    ), async () => {
      this.providers.set(provider.id, provider)
      await this.saveProviders()
    })
    return provider
  }

  getProvider(id: string): ModelProvider | undefined {
    return this.providers.get(id)
  }

  listProviders(): ModelProvider[] {
    return Array.from(this.providers.values())
  }

  async updateProvider(id: string, params: UpdateModelProviderParams): Promise<ModelProvider> {
    return this.serial(() => this.updateProviderUnlocked(id, params))
  }

  private async updateProviderUnlocked(id: string, params: UpdateModelProviderParams): Promise<ModelProvider> {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error('Provider not found')
    }

    // 显式字段白名单：REST body 无运行时校验，不得全量 spread（防止改写
    // format/id/type/oauth_credential 等敏感字段）。
    const updated: ModelProvider = {
      ...provider,
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.endpoint !== undefined ? { endpoint: params.endpoint } : {}),
      ...(params.api_key !== undefined ? { api_key: params.api_key } : {}),
      ...(params.models !== undefined ? { models: params.models } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
      updated_at: generateTimestamp(),
    }
    await this.mutateRuntimeConfig(['models'], async () => this.previewSemanticSnapshot(
      () => this.providers.set(id, updated),
      () => this.providers.set(id, provider),
    ), async () => {
      this.providers.set(id, updated)
      await this.saveProviders()
    }, true)

    console.log(`[ModelProviderManager] Updated provider ${id}`)
    return updated
  }

  async deleteProvider(id: string): Promise<void> {
    return this.serial(() => this.deleteProviderUnlocked(id))
  }

  private async deleteProviderUnlocked(id: string): Promise<void> {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error('Provider not found')
    }

    await this.mutateRuntimeConfig(['models'], async () => this.previewSemanticSnapshot(
      () => this.providers.delete(id),
      () => this.providers.set(id, provider),
    ), async () => {
      this.providers.delete(id)
      await this.saveProviders()
    })
  }

  async upsertById(provider: ModelProvider, onConflict: OnConflict): Promise<'imported' | 'overwritten' | 'skipped'> {
    return this.serial(() => this.upsertByIdUnlocked(provider, onConflict))
  }

  private async upsertByIdUnlocked(provider: ModelProvider, onConflict: OnConflict): Promise<'imported' | 'overwritten' | 'skipped'> {
    const exists = this.providers.has(provider.id)
    if (exists && onConflict === 'skip') return 'skipped'
    const previous = this.providers.get(provider.id)
    await this.mutateRuntimeConfig(['models'], async () => this.previewSemanticSnapshot(
      () => this.providers.set(provider.id, provider),
      () => { if (previous) this.providers.set(provider.id, previous); else this.providers.delete(provider.id) },
    ), async () => {
      this.providers.set(provider.id, provider)
      await this.saveProviders()
    }, exists)
    return exists ? 'overwritten' : 'imported'
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
    await this.mutateRuntimeConfig(['models'], async () => this.previewSemanticSnapshot(
      () => this.providers.set(providerId, updated),
      () => this.providers.set(providerId, provider),
    ), async () => {
      this.providers.set(providerId, updated)
      await this.saveProviders()
    })
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
    // credential 不在语义投影里：对已登出/从未登录的 provider 登出是 noop，
    // 必须容忍（保持幂等），否则抛 'did not change semantic snapshot'。
    await this.mutateRuntimeConfig(['models'], async () => this.previewSemanticSnapshot(
      () => this.providers.set(providerId, updated),
      () => this.providers.set(providerId, provider),
    ), async () => {
      this.providers.set(providerId, updated)
      await this.saveProviders()
    }, true)
  }

  getOAuthCredential(providerId: string): OAuthCredential | undefined {
    return this.providers.get(providerId)?.oauth_credential
  }

  // ============================================================================
  // Validation
  // ============================================================================

  async testProviderModel(id: string, modelId?: string): Promise<{ success: boolean; latency_ms: number; error?: string }> {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error('Provider not found')
    }

    if (modelId) {
      const model = provider.models.find(m => m.model_id === modelId)
      if (!model) {
        throw new Error(`Model "${modelId}" not found in provider "${provider.name}"`)
      }
      return this.probeChatRoundtrip(provider, model)
    }

    return this.measureEndpointLatency(provider)
  }

  /**
   * 草稿 provider 实战验证：构造一个临时 provider 对象（不入库 Map / 不写盘），
   * 跑 base_url 探测 + 至少一个 LLM 模型的实战往返。
   * 用于 Admin Create 表单"保存前先验证"。
   */
  async validateDraftProvider(
    draft: CreateModelProviderParams
  ): Promise<{ success: boolean; latency_ms: number; error?: string; failed_stage?: 'endpoint' | 'model' }> {
    const now = generateTimestamp()
    const tempProvider: ModelProvider = {
      id: '__draft__',
      name: draft.name,
      type: draft.type,
      format: draft.format,
      endpoint: draft.endpoint,
      api_key: draft.api_key,
      preset_vendor: draft.preset_vendor,
      ...(draft.auth_type && { auth_type: draft.auth_type }),
      models: draft.models,
      status: 'inactive',
      created_at: now,
      updated_at: now,
    }

    // 1) base_url 探测：endpoint 写错 / 鉴权挂掉早死，省得跑第二步浪费时间。
    // 用本地版避免污染：draft 没入 Map，不应写 provider.status / saveProviders。
    const endpointResult = await this.probeEndpointConnectivity(tempProvider)
    if (!endpointResult.success) {
      return { ...endpointResult, failed_stage: 'endpoint' }
    }

    // 2) 实战往返：至少一个 LLM 模型必须通。embedding 类型已不在 v3，过滤兜底。
    const llmModel = draft.models.find(m => m.type === 'llm')
    if (!llmModel) {
      // 没填模型不强制（用户可能想先建框架后续 refreshModels），endpoint 通了就放行
      return { success: true, latency_ms: endpointResult.latency_ms }
    }
    const modelResult = await this.probeChatRoundtrip(tempProvider, llmModel)
    if (!modelResult.success) {
      return { ...modelResult, failed_stage: 'model' }
    }
    return modelResult
  }

  /**
   * base_url 测速。成功/失败都落到 provider.status —— 列表端点不通 = 整个 provider 不可用，
   * 这个判断对所有模型一致，可作为列表卡片的状态信号。
   *
   * 草稿 provider（未入库）请用 probeEndpointConnectivity，不写盘。
   */
  private async measureEndpointLatency(provider: ModelProvider): Promise<{ success: boolean; latency_ms: number; error?: string }> {
    const result = await this.probeEndpointConnectivity(provider)
    const previous = { ...provider }
    const updated = { ...provider,
      status: result.success ? 'active' as const : 'error' as const,
      last_validated_at: result.success ? generateTimestamp() : provider.last_validated_at,
      validation_error: result.success ? undefined : result.error,
    }
    // status 不变时语义快照不变（重复测试/对已 error 的 provider 再测）：
    // 允许 runtime noop，连通性结果与 last_validated_at 照常落盘。
    await this.mutateRuntimeConfig(['models'], async () => this.previewSemanticSnapshot(
      () => this.providers.set(provider.id, updated),
      () => this.providers.set(provider.id, previous),
    ), async () => {
      this.providers.set(provider.id, updated)
      await this.saveProviders()
    }, true)
    return result
  }

  /**
   * 纯 base_url 探测（不写 provider.status）。给草稿验证和持久化测速共用。
   */
  private async probeEndpointConnectivity(
    provider: ModelProvider
  ): Promise<{ success: boolean; latency_ms: number; error?: string }> {
    const authToken = await this.resolveAuthToken(provider)
    if (typeof authToken !== 'string') {
      return authToken
    }

    let url: string
    let headers: Record<string, string>
    try {
      const built = await this.buildEndpointProbe(provider, authToken)
      url = built.url
      headers = built.headers
    } catch (error) {
      return { success: false, latency_ms: 0, error: error instanceof Error ? error.message : String(error) }
    }

    const startTime = Date.now()
    try {
      const response = await fetch(url, { method: 'GET', headers })
      const latency_ms = Date.now() - startTime
      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        return {
          success: false,
          latency_ms,
          error: `HTTP ${response.status}${errBody ? `: ${truncate(errBody)}` : ''}`,
        }
      }
      return { success: true, latency_ms }
    } catch (error) {
      return {
        success: false,
        latency_ms: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 实战测速（chat-roundtrip）：TTFT 指标，但 payload 形态对齐生产 adapter。
   *   - stream:true（拉首字节即返回；详细缘由见 buildChatProbeRequest 文档）
   *   - 带 system / instructions
   *   - 带 tools 字段（一个 noop 工具，也能暴露"中转不支持 tools"的失败）
   *   - max_tokens 用模型实际配置或 adapter 默认（不是 1）
   *
   * 不写 provider.status —— 单个模型 4xx 不应把整个 provider 标红。
   */
  private async probeChatRoundtrip(
    provider: ModelProvider,
    model: ModelInfo
  ): Promise<{ success: boolean; latency_ms: number; error?: string }> {
    const authToken = await this.resolveAuthToken(provider)
    if (typeof authToken !== 'string') {
      return authToken
    }

    const probe = buildChatProbeRequest(provider, model, authToken)
    if (!probe.ok) {
      return { success: false, latency_ms: 0, error: probe.error }
    }

    const startTime = Date.now()
    try {
      const response = await fetch(probe.url, {
        method: 'POST',
        headers: probe.headers,
        body: probe.body,
      })

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        return {
          success: false,
          latency_ms: Date.now() - startTime,
          error: `HTTP ${response.status}${errBody ? `: ${truncate(errBody)}` : ''}`,
        }
      }

      if (!response.body) {
        return { success: false, latency_ms: Date.now() - startTime, error: 'No response body' }
      }

      // 读到首个非空字节即视为首字到达（TTFT），立刻 cancel 关连接、不再等完整生成。
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            return { success: false, latency_ms: Date.now() - startTime, error: 'Stream ended without any data' }
          }
          if (value && value.length > 0) {
            return { success: true, latency_ms: Date.now() - startTime }
          }
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
    } catch (error) {
      return {
        success: false,
        latency_ms: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 测速前置鉴权检查。OAuth 未登录时直接短路（让用户去登录），
   * 否则交给 ensureFreshAuthToken（不会抛，刷新失败会 fallback 到旧 token）。
   */
  private async resolveAuthToken(
    provider: ModelProvider
  ): Promise<string | { success: false; latency_ms: 0; error: string }> {
    if (provider.auth_type === 'oauth' && !provider.oauth_credential) {
      return { success: false, latency_ms: 0, error: 'OAuth 未登录，请先完成 ChatGPT 登录' }
    }
    return this.ensureFreshAuthToken(provider)
  }

  /**
   * 距离过期不足 60s 时触发 OAuth 刷新（in-flight 去重）。
   * 刷新失败 fallback 到旧 token，让上游 401 自然暴露问题，避免测速链路把磁盘故障吞成"鉴权失败"。
   */
  private async ensureFreshAuthToken(provider: ModelProvider): Promise<string> {
    if (provider.auth_type !== 'oauth' || !provider.oauth_credential) {
      return provider.api_key
    }

    const credential = provider.oauth_credential
    if (Date.now() <= credential.expires_at - 60_000) {
      return credential.access_token
    }

    try {
      let refreshPromise = this.refreshInFlight.get(provider.id)
      if (!refreshPromise) {
        refreshPromise = (async () => {
          const { refreshOAuthToken } = await import('./oauth/openai-codex-oauth.js')
          return refreshOAuthToken(credential.refresh_token)
        })()
        this.refreshInFlight.set(provider.id, refreshPromise)
        refreshPromise.finally(() => this.refreshInFlight.delete(provider.id))
      }
      const refreshed = await refreshPromise
      await this.setOAuthCredential(provider.id, {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: refreshed.expires_at,
        account_id: refreshed.account_id,
        email: refreshed.email,
      })
      return refreshed.access_token
    } catch (err) {
      console.error(`[ModelProviderManager] OAuth token refresh failed for ${provider.id}:`, err)
      return credential.access_token
    }
  }

  private async buildEndpointProbe(
    provider: ModelProvider,
    authToken: string
  ): Promise<{ url: string; headers: Record<string, string> }> {
    if (provider.format === 'openai') {
      return {
        url: `${provider.endpoint}/models`,
        headers: { Authorization: `Bearer ${authToken}` },
      }
    }
    if (provider.format === 'openai-responses') {
      const { resolveCodexClientVersion } = await import('./oauth/codex-client-version.js')
      const clientVersion = await resolveCodexClientVersion()
      return {
        url: `${provider.endpoint}/models?client_version=${encodeURIComponent(clientVersion)}`,
        headers: { Authorization: `Bearer ${authToken}` },
      }
    }
    if (provider.format === 'anthropic') {
      return {
        url: `${provider.endpoint}/v1/models`,
        headers: { 'x-api-key': authToken, 'anthropic-version': '2023-06-01' },
      }
    }
    if (provider.format === 'gemini') {
      return {
        url: `${provider.endpoint}/models?key=${authToken}`,
        headers: {},
      }
    }
    throw new Error(`Unsupported format: ${provider.format}`)
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

    const authToken = await this.ensureFreshAuthToken(provider)

    const freshModels = await this.fetchVendorModels(
      { ...vendor, endpoint: provider.endpoint },
      authToken
    )

    const oldIds = new Set(provider.models.map(m => m.model_id))
    const newIds = new Set(freshModels.map(m => m.model_id))

    const added = freshModels.filter(m => !oldIds.has(m.model_id)).map(m => m.model_id)
    const removed = provider.models.filter(m => !newIds.has(m.model_id)).map(m => m.model_id)

    const mergedModels = freshModels

    const updated = { ...provider, models: mergedModels, updated_at: generateTimestamp() }
    // 厂商模型列表与本地一致时语义快照不变：允许 runtime noop，否则最常见的
    // refresh 结果会抛错并跳过 autoConfigureImageSlot。
    await this.mutateRuntimeConfig(['models'], async () => this.previewSemanticSnapshot(
      () => this.providers.set(id, updated),
      () => this.providers.set(id, provider),
    ), async () => {
      this.providers.set(id, updated)
      await this.saveProviders()
    }, true)

    await this.autoConfigureImageSlot(id)

    return { models: mergedModels, added, removed }
  }

  getProviderReferences(id: string): { references: string[] } {
    const refs: string[] = []

    if (this.globalConfig.default_llm_provider_id === id) {
      refs.push('全局默认 LLM 模型')
    }

    for (const [moduleId, config] of this.moduleConfigs.entries()) {
      if (config.llm_provider_id === id) {
        refs.push(`模块 "${moduleId}" 的 LLM 配置`)
      }
    }

    if (this.agentConfigRefsProvider) {
      refs.push(...this.agentConfigRefsProvider(id))
    }

    return { references: refs }
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

    await this.autoConfigureImageSlot(provider.id)

    return { provider, models }
  }

  private async fetchVendorModels(vendor: PresetVendor, apiKey: string): Promise<ModelInfo[]> {
    if (!vendor.models_api) {
      return vendor.default_models ? [...vendor.default_models] : []
    }

    // 无凭证时用静态列表兜底（OAuth provider 首次导入前没有 token）
    if (!apiKey) {
      return vendor.default_models ? [...vendor.default_models] : []
    }

    try {
      const url = await this.buildVendorModelsUrl(vendor)
      const response = await this.httpRequest(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      })

      const data = JSON.parse(response)

      // Codex 订阅后端：{models: [{slug, visibility, input_modalities, ...}]}
      // OpenAI 标准：{data: [{id, ...}]}
      const parsed = vendor.format === 'openai-responses' && Array.isArray(data.models)
        ? parseCodexModels(data.models as unknown[])
        : parseOpenAIModels(Array.isArray(data.data) ? (data.data as unknown[]) : [])

      // 拉不到任何模型时，退回默认列表，避免清空导致用户无法选择
      if (parsed.length === 0 && vendor.default_models) {
        return [...vendor.default_models]
      }

      return applyVendorVisionHints(parsed, vendor.vision_id_prefixes)
    } catch (error) {
      console.error(`Failed to fetch models from ${vendor.name}:`, error)
      return vendor.default_models ? [...vendor.default_models] : []
    }
  }

  /**
   * 为需要 `/models` 的厂商构造带 query 的 URL。
   * 目前仅 Codex 订阅需要 `client_version` 参数，其它厂商走原样 endpoint。
   */
  private async buildVendorModelsUrl(vendor: PresetVendor): Promise<string> {
    const base = `${vendor.endpoint}${vendor.models_api}`
    if (vendor.format !== 'openai-responses') {
      return base
    }
    const { resolveCodexClientVersion } = await import('./oauth/codex-client-version.js')
    const clientVersion = await resolveCodexClientVersion()
    const separator = base.includes('?') ? '&' : '?'
    return `${base}${separator}client_version=${encodeURIComponent(clientVersion)}`
  }

  // ============================================================================
  // Config Resolution
  // ============================================================================

  async resolveModelConfig(params: ResolveModelConfigParams): Promise<LLMConnectionInfo> {
    // v3: role 仅 'llm'。embedding 路径已移除。
    // 1. 查找模块专属配置
    const moduleConfig = this.moduleConfigs.get(params.module_id)
    if (moduleConfig) {
      const providerId = moduleConfig.llm_provider_id
      const modelId = moduleConfig.llm_model_id

      if (providerId && modelId) {
        return this.buildConnectionInfo(providerId, modelId)
      }
    }

    // 2. 使用全局默认配置
    const providerId = this.globalConfig.default_llm_provider_id
    const modelId = this.globalConfig.default_llm_model_id

    if (!providerId || !modelId) {
      throw new Error(`No ${params.role} configuration found for module ${params.module_id}`)
    }

    return this.buildConnectionInfo(providerId, modelId)
  }

  async buildConnectionInfo(providerId: string, modelId: string): Promise<LLMConnectionInfo> {
    const provider = this.providers.get(providerId)
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`)
    }

    const model = provider.models.find((m) => m.model_id === modelId)
    if (!model) {
      throw new Error(`Model not found: ${modelId} in provider ${providerId}`)
    }

    const apikey = await this.ensureFreshAuthToken(provider)

    // 直连 Provider：返回 provider 原始连接信息
    // endpoint 存储完整 base URL（含版本前缀，如 OpenAI 的 /v1、智谱的 /api/paas/v4、
    // DeepSeek 则无版本前缀），adapter 只在其后拼具体 path（如 /chat/completions）
    const base = {
      endpoint: provider.endpoint,
      apikey,
      model_id: model.model_id,
      format: provider.format,
      provider_id: providerId,
      ...(provider.oauth_credential?.account_id
        ? { account_id: provider.oauth_credential.account_id }
        : {}),
    }

    return {
      ...base,
      ...(model.max_tokens !== undefined && { max_tokens: model.max_tokens }),
      ...(model.supports_vision && { supports_vision: true }),
      ...(model.context_window !== undefined && { context_window: model.context_window }),
    } as LLMConnectionInfo
  }

  // ============================================================================
  // Global Config
  // ============================================================================

  getGlobalConfig(): GlobalModelConfig {
    return { ...this.globalConfig }
  }

  /**
   * 解析全局图像 slot 为连接信息。存引用不存快照——运行时实时解析。
   * OAuth provider 不能调 images API，判为不可用。
   */
  async resolveImageConfig(): Promise<
    { available: true; config: LLMConnectionInfo } | { available: false; reason: string }
  > {
    const providerId = this.globalConfig.default_image_provider_id
    const modelId = this.globalConfig.default_image_model_id
    if (!providerId || !modelId) return { available: false, reason: 'not_configured' }
    const provider = this.providers.get(providerId)
    if (!provider) return { available: false, reason: 'provider_not_found' }
    if (provider.auth_type === 'oauth') {
      return { available: false, reason: 'oauth_provider_cannot_generate_images' }
    }
    try {
      const config = await this.buildConnectionInfo(providerId, modelId)
      return { available: true, config }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 供应商发现图像模型后自动配置全局图像 slot。
   * 仅在未被用户手动设过、且当前 slot 为空或指向已消失的模型时填充。
   * @returns 是否发生了配置写入
   */
  async autoConfigureImageSlot(providerId: string): Promise<boolean> {
    if (this.globalConfig.image_slot_user_set) return false

    const curP = this.globalConfig.default_image_provider_id
    const curM = this.globalConfig.default_image_model_id
    if (curP && curM) {
      const cur = this.providers.get(curP)
      const stillValid = cur?.models.some((m) => m.model_id === curM && m.type === 'image')
      if (stillValid) return false
    }

    const provider = this.providers.get(providerId)
    const imageModel = provider?.models.find((m) => m.type === 'image')
    if (!imageModel) return false

    await this.updateGlobalConfig({
      default_image_provider_id: providerId,
      default_image_model_id: imageModel.model_id,
    })
    return true
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
    await this.serial(async () => {
      this.globalConfig = { ...this.globalConfig, proxy }
      await this.saveGlobalConfig()
    })
  }

  async updateGlobalConfig(config: Partial<GlobalModelConfig>): Promise<GlobalModelConfig> {
    return this.serial(async () => {
      const updated = { ...this.globalConfig, ...config }
      const publicBaseUrlChanged = Object.prototype.hasOwnProperty.call(config, 'public_base_url') &&
      config.public_base_url !== this.globalConfig.public_base_url
    const llmChanged = (
      Object.prototype.hasOwnProperty.call(config, 'default_llm_provider_id') && config.default_llm_provider_id !== this.globalConfig.default_llm_provider_id
    ) || (
      Object.prototype.hasOwnProperty.call(config, 'default_llm_model_id') && config.default_llm_model_id !== this.globalConfig.default_llm_model_id
    )
    const imageChanged = (
      Object.prototype.hasOwnProperty.call(config, 'default_image_provider_id') && config.default_image_provider_id !== this.globalConfig.default_image_provider_id
    ) || (
      Object.prototype.hasOwnProperty.call(config, 'default_image_model_id') && config.default_image_model_id !== this.globalConfig.default_image_model_id
    ) || (
      Object.prototype.hasOwnProperty.call(config, 'image_slot_user_set') && config.image_slot_user_set !== this.globalConfig.image_slot_user_set
    )
    const domains: ConfigDomain[] = [
      ...(llmChanged ? ['models' as const] : []),
      ...(imageChanged ? ['image' as const] : []),
      ...(publicBaseUrlChanged ? ['behavior' as const] : []),
    ]
    if (domains.length === 0) {
      this.globalConfig = updated
      await this.saveGlobalConfig()
      return updated
    }
    const previous = this.globalConfig
    await this.mutateRuntimeConfig(domains, async () => this.previewSemanticSnapshot(
      () => { this.globalConfig = updated },
      () => { this.globalConfig = previous },
    ), async () => {
      this.globalConfig = updated
      await this.saveGlobalConfig()
    })
      return updated
    })
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
      // v3 起 default_embedding_* 字段已移除，老 raw 数据里如有这些字段直接忽略。
      // spec 2026-06-09 §4.4: trace_retention_count → task_retention_count migration
      // 旧字段 trace_retention_count 已删；按"每 task 平均 3 条 trace"折算到新单位
      let taskRetentionCount = raw.task_retention_count ?? null
      if (taskRetentionCount == null && raw.trace_retention_count != null && raw.trace_retention_count > 0) {
        taskRetentionCount = Math.max(1, Math.round(raw.trace_retention_count / 3))
        console.log(
          `[ModelProviderManager] Migrated trace_retention_count=${raw.trace_retention_count} → ` +
          `task_retention_count=${taskRetentionCount} (assuming 3 traces/task on average)`,
        )
      }

      this.globalConfig = {
        default_llm_provider_id: raw.default_llm_provider_id,
        default_llm_model_id: raw.default_llm_model_id,
        default_image_provider_id: raw.default_image_provider_id,
        default_image_model_id: raw.default_image_model_id,
        image_slot_user_set: raw.image_slot_user_set,
        proxy: raw.proxy,
        public_base_url: raw.public_base_url,
        trace_retention_days: raw.trace_retention_days ?? null,
        task_retention_count: taskRetentionCount,
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
    await durableAtomicWriteFile(filePath, content)
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