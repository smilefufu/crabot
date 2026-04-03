// --- Core Loop ---
export { runEngine } from './query-loop'
export type { RunEngineParams } from './query-loop'

// --- Types ---
export type {
  EngineOptions,
  EngineResult,
  EngineTurnEvent,
  ToolDefinition,
  ToolCallContext,
  ToolCallResult,
  EngineMessage,
  EngineUserMessage,
  EngineAssistantMessage,
  EngineToolResultMessage,
  ContentBlock,
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  StreamChunk,
} from './types'
export { createUserMessage, createAssistantMessage, createToolResultMessage } from './types'

// --- LLM Adapter ---
export type { LLMAdapter, LLMAdapterConfig, LLMStreamParams } from './llm-adapter'
export { AnthropicAdapter, normalizeMessagesForAnthropic, OpenAIAdapter, normalizeMessagesForOpenAI, toOpenAITool, readSSELines } from './llm-adapter'

// --- Tool Framework ---
export { defineTool, findTool, partitionToolCalls } from './tool-framework'

// --- Tool Orchestration ---
export { executeToolBatches } from './tool-orchestration'

// --- Stream Processor ---
export { StreamProcessor } from './stream-processor'

// --- Context Manager ---
export { ContextManager } from './context-manager'
