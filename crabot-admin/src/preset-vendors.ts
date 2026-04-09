/**
 * 预置厂商定义
 *
 * 提供常见 LLM/Embedding 厂商的预配置信息
 */

import type { ModelInfo, PresetVendor } from './types.js'

/**
 * 阿里云百炼（DashScope）静态模型列表
 * DashScope OpenAI 兼容模式不支持 GET /v1/models，需要维护静态列表
 * 参考: https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope
 */
const DASHSCOPE_MODELS: ModelInfo[] = [
  // ---- LLM: 千问商业版 ----
  { model_id: 'qwen-max', display_name: 'Qwen Max', type: 'llm', supports_vision: false, context_window: 32768 },
  { model_id: 'qwen-max-latest', display_name: 'Qwen Max Latest', type: 'llm', supports_vision: false, context_window: 32768 },
  { model_id: 'qwen-plus', display_name: 'Qwen Plus', type: 'llm', supports_vision: false, context_window: 131072 },
  { model_id: 'qwen-plus-latest', display_name: 'Qwen Plus Latest', type: 'llm', supports_vision: false, context_window: 131072 },
  { model_id: 'qwen-turbo', display_name: 'Qwen Turbo', type: 'llm', supports_vision: false, context_window: 131072 },
  { model_id: 'qwen-turbo-latest', display_name: 'Qwen Turbo Latest', type: 'llm', supports_vision: false, context_window: 131072 },
  { model_id: 'qwen-long', display_name: 'Qwen Long', type: 'llm', supports_vision: false, context_window: 10000000 },
  // ---- LLM: 千问3系列 ----
  { model_id: 'qwen3-max', display_name: 'Qwen3 Max', type: 'llm', supports_vision: false, context_window: 32768 },
  { model_id: 'qwen3-max-latest', display_name: 'Qwen3 Max Latest', type: 'llm', supports_vision: false, context_window: 32768 },
  { model_id: 'qwen3-plus', display_name: 'Qwen3 Plus', type: 'llm', supports_vision: false, context_window: 131072 },
  { model_id: 'qwen3-plus-latest', display_name: 'Qwen3 Plus Latest', type: 'llm', supports_vision: false, context_window: 131072 },
  // ---- LLM: 千问3.5系列 ----
  { model_id: 'qwen3.5-plus', display_name: 'Qwen3.5 Plus', type: 'llm', supports_vision: false, context_window: 131072 },
  { model_id: 'qwen3.5-plus-latest', display_name: 'Qwen3.5 Plus Latest', type: 'llm', supports_vision: false, context_window: 131072 },
  { model_id: 'qwen3.5-flash', display_name: 'Qwen3.5 Flash', type: 'llm', supports_vision: false, context_window: 131072 },
  { model_id: 'qwen3.5-flash-latest', display_name: 'Qwen3.5 Flash Latest', type: 'llm', supports_vision: false, context_window: 131072 },
  // ---- LLM: Coder 系列 ----
  { model_id: 'qwen3-coder-plus', display_name: 'Qwen3 Coder Plus', type: 'llm', supports_vision: false, context_window: 131072 },
  { model_id: 'qwen3-coder-plus-latest', display_name: 'Qwen3 Coder Plus Latest', type: 'llm', supports_vision: false, context_window: 131072 },
  // ---- LLM: 推理模型 ----
  { model_id: 'qwq-plus', display_name: 'QwQ Plus', type: 'llm', supports_vision: false, context_window: 131072 },
  { model_id: 'qwq-plus-latest', display_name: 'QwQ Plus Latest', type: 'llm', supports_vision: false, context_window: 131072 },
  // ---- LLM: 视觉模型 ----
  { model_id: 'qwen-vl-max', display_name: 'Qwen VL Max', type: 'llm', supports_vision: true, context_window: 32768 },
  { model_id: 'qwen-vl-max-latest', display_name: 'Qwen VL Max Latest', type: 'llm', supports_vision: true, context_window: 32768 },
  { model_id: 'qwen-vl-plus', display_name: 'Qwen VL Plus', type: 'llm', supports_vision: true, context_window: 131072 },
  { model_id: 'qwen-vl-plus-latest', display_name: 'Qwen VL Plus Latest', type: 'llm', supports_vision: true, context_window: 131072 },
  // ---- Embedding ----
  { model_id: 'text-embedding-v3', display_name: 'Text Embedding v3', type: 'embedding' },
  { model_id: 'text-embedding-v2', display_name: 'Text Embedding v2', type: 'embedding' },
  { model_id: 'text-embedding-v1', display_name: 'Text Embedding v1', type: 'embedding' },
]

/**
 * 百炼 Coding Plan 静态模型列表
 * 百炼 Coding Plan 提供 Anthropic 兼容接口，不支持 GET /models
 */
/**
 * ChatGPT 订阅模型列表
 * 通过 OAuth 认证后可用的模型（ChatGPT Plus/Pro/Enterprise）
 */
const CHATGPT_SUBSCRIPTION_MODELS: ModelInfo[] = [
  { model_id: 'gpt-4o', display_name: 'GPT-4o', type: 'llm', supports_vision: true, context_window: 128000 },
  { model_id: 'gpt-4o-mini', display_name: 'GPT-4o Mini', type: 'llm', supports_vision: true, context_window: 128000 },
  { model_id: 'o3', display_name: 'o3', type: 'llm', supports_vision: false, context_window: 200000 },
  { model_id: 'o3-mini', display_name: 'o3 Mini', type: 'llm', supports_vision: false, context_window: 200000 },
  { model_id: 'o4-mini', display_name: 'o4 Mini', type: 'llm', supports_vision: true, context_window: 200000 },
  { model_id: 'codex-mini', display_name: 'Codex Mini', type: 'llm', supports_vision: false, context_window: 200000 },
]

const DASHSCOPE_CODING_MODELS: ModelInfo[] = [
  { model_id: 'qwen3.5-plus', display_name: 'Qwen3.5 Plus', type: 'llm', supports_vision: true, context_window: 131072 },
  { model_id: 'kimi-k2.5', display_name: 'Kimi K2.5', type: 'llm', supports_vision: true, context_window: 131072 },
  { model_id: 'glm-5', display_name: 'GLM-5', type: 'llm', supports_vision: false, context_window: 131072 },
  { model_id: 'MiniMax-M2.5', display_name: 'MiniMax M2.5', type: 'llm', supports_vision: false, context_window: 131072 },
]

export const PRESET_VENDORS: readonly PresetVendor[] = [
  {
    id: 'chatgpt-subscription',
    name: 'ChatGPT 订阅',
    format: 'openai-responses',
    endpoint: 'https://chatgpt.com/backend-api/codex',
    docs_url: 'https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan',
    default_models: CHATGPT_SUBSCRIPTION_MODELS,
    auth_type: 'oauth',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    format: 'openai',
    endpoint: 'http://localhost:11434/v1',
    models_api: '/models',
    docs_url: 'https://ollama.ai/docs',
    allows_custom_endpoint: true,
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    format: 'openai',
    endpoint: 'https://api.siliconflow.cn/v1',
    models_api: '/models',
    docs_url: 'https://siliconflow.cn/docs',
    api_key_help_url: 'https://siliconflow.cn/account/ak',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    format: 'openai',
    endpoint: 'https://api.openai.com/v1',
    models_api: '/models',
    docs_url: 'https://platform.openai.com/docs',
    api_key_help_url: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'dashscope',
    name: '阿里云百炼',
    format: 'openai',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // DashScope OpenAI 兼容模式不支持 GET /models 端点，使用静态模型列表
    docs_url: 'https://help.aliyun.com/zh/model-studio/',
    api_key_help_url: 'https://bailian.console.aliyun.com/?apiKey=1',
    default_models: DASHSCOPE_MODELS,
  },
  {
    id: 'dashscope-coding',
    name: '百炼 Coding Plan',
    format: 'anthropic',
    endpoint: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    docs_url: 'https://help.aliyun.com/zh/model-studio/',
    api_key_help_url: 'https://bailian.console.aliyun.com/?apiKey=1',
    default_models: DASHSCOPE_CODING_MODELS,
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    format: 'openai',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    models_api: '/models',
    docs_url: 'https://open.bigmodel.cn/dev/howuse/introduction',
    api_key_help_url: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    format: 'openai',
    endpoint: 'https://openrouter.ai/api/v1',
    models_api: '/models',
    docs_url: 'https://openrouter.ai/docs',
    api_key_help_url: 'https://openrouter.ai/keys',
  },
]

export function findPresetVendor(vendorId: string): PresetVendor | undefined {
  return PRESET_VENDORS.find((v) => v.id === vendorId)
}
