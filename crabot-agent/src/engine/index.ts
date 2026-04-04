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
  ToolPermissionLevel,
  PermissionMode,
  ToolPermissionConfig,
  PermissionDecision,
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
export type { LLMAdapter, LLMAdapterConfig, LLMStreamParams, LLMFormat, CreateAdapterConfig, LLMCallResponse } from './llm-adapter'
export { AnthropicAdapter, normalizeMessagesForAnthropic, OpenAIAdapter, normalizeMessagesForOpenAI, toOpenAITool, readSSELines, createAdapter, callNonStreaming } from './llm-adapter'

// --- Tool Framework ---
export { defineTool, findTool, partitionToolCalls } from './tool-framework'

// --- Tool Orchestration ---
export { executeToolBatches } from './tool-orchestration'

// --- Permission Checker ---
export { checkToolPermission } from './permission-checker'

// --- Stream Processor ---
export { StreamProcessor } from './stream-processor'

// --- Context Manager ---
export { ContextManager } from './context-manager'

// --- Sub-Agent ---
export { forkEngine, createSubAgentTool } from './sub-agent'
export type { ForkEngineParams, ForkEngineResult, SubAgentToolConfig } from './sub-agent'

// --- Built-in Tools ---
export { getAllBuiltinTools, getConfiguredBuiltinTools } from './tools/index'
