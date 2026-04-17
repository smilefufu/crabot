/**
 * LLM Adapter — Factory 和 Re-exports
 *
 * 各 adapter 实现在独立文件中：
 * - anthropic-adapter.ts
 * - openai-adapter.ts
 * - openai-responses-adapter.ts
 *
 * 共享类型和工具函数在 llm-adapter-types.ts
 */

import { AnthropicAdapter } from './anthropic-adapter.js'
import { OpenAIAdapter } from './openai-adapter.js'
import { OpenAIResponsesAdapter } from './openai-responses-adapter.js'
import type { LLMAdapter } from './llm-adapter-types.js'

// Re-export types and helpers
export type {
  LLMAdapter,
  LLMAdapterConfig,
  LLMStreamParams,
  LLMCallResponse,
} from './llm-adapter-types.js'

export {
  callNonStreaming,
  isToolResultMessage,
  extractText,
  buildImageUrl,
  readSSEEvents,
  readSSELines,
} from './llm-adapter-types.js'

// Re-export adapter classes and their normalization functions
export { AnthropicAdapter, normalizeMessagesForAnthropic } from './anthropic-adapter.js'
export { OpenAIAdapter, normalizeMessagesForOpenAI, toOpenAITool } from './openai-adapter.js'
export { OpenAIResponsesAdapter, normalizeMessagesForResponses } from './openai-responses-adapter.js'

// --- Adapter Factory ---

export type LLMFormat = 'anthropic' | 'openai' | 'gemini' | 'openai-responses'

export interface CreateAdapterConfig {
  readonly endpoint: string
  readonly apikey: string
  readonly format: LLMFormat
  readonly accountId?: string
}

export function createAdapter(config: CreateAdapterConfig): LLMAdapter {
  switch (config.format) {
    case 'anthropic':
      return new AnthropicAdapter({ endpoint: config.endpoint, apikey: config.apikey })
    case 'openai':
      return new OpenAIAdapter({ endpoint: config.endpoint, apikey: config.apikey })
    case 'gemini':
      return new OpenAIAdapter({ endpoint: config.endpoint, apikey: config.apikey })
    case 'openai-responses':
      return new OpenAIResponsesAdapter({
        endpoint: config.endpoint,
        apikey: config.apikey,
        ...(config.accountId ? { accountId: config.accountId } : {}),
      })
    default: {
      const exhaustiveCheck: never = config.format
      throw new Error(`Unsupported LLM format: ${exhaustiveCheck}`)
    }
  }
}
