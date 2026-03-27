/**
 * LLM Client - @anthropic-ai/sdk wrapper pointing at LiteLLM
 *
 * Used by Front Handler v2 for direct API calls (no CLI subprocess).
 */

import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool, ContentBlock } from '@anthropic-ai/sdk/resources/messages'

export interface LLMClientConfig {
  endpoint: string   // LiteLLM base URL (without /v1)
  apikey: string
  model: string
  maxTokens?: number
}

export interface LLMCallResult {
  content: ContentBlock[]
  stopReason: string | null
  model: string
  inputTokens: number
  outputTokens: number
}

export class LLMClient {
  private client: Anthropic
  private model: string
  private maxTokens: number

  constructor(config: LLMClientConfig) {
    this.client = new Anthropic({
      baseURL: config.endpoint,
      apiKey: config.apikey || 'dummy-key',
    })
    this.model = config.model
    this.maxTokens = config.maxTokens ?? 16384
  }

  async callMessages(params: {
    system: string
    messages: MessageParam[]
    tools?: Tool[]
  }): Promise<LLMCallResult> {
    const response = await this.client.messages.create({
      model: this.model,
      system: params.system,
      messages: params.messages,
      max_tokens: this.maxTokens,
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    })

    return {
      content: response.content,
      stopReason: response.stop_reason,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }
  }

  updateConfig(config: Partial<LLMClientConfig>): void {
    if (config.endpoint || config.apikey) {
      this.client = new Anthropic({
        baseURL: config.endpoint ?? this.client.baseURL,
        apiKey: config.apikey ?? this.client.apiKey,
      })
    }
    if (config.model !== undefined) this.model = config.model
    if (config.maxTokens !== undefined) this.maxTokens = config.maxTokens
  }
}
