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
]

/**
 * 百炼 Coding Plan 静态模型列表
 * 百炼 Coding Plan 提供 Anthropic 兼容接口，不支持 GET /models
 */
/**
 * ChatGPT 订阅模型列表（Codex 后端）
 *
 * 通过 OAuth 认证后可用的模型（ChatGPT Plus/Pro/Enterprise）
 * 请求走 Responses API：https://chatgpt.com/backend-api/codex/responses
 * 参考：openai/codex 源码及 openclaw 的 openai-codex-provider 实现
 */
// 仅包含 supported_in_api=true 的模型；spark 这类 client-only 模型不能走 Responses API
const CHATGPT_SUBSCRIPTION_MODELS: ModelInfo[] = [
  { model_id: 'gpt-5.4', display_name: 'GPT-5.4', type: 'llm', supports_vision: true, context_window: 272000 },
  { model_id: 'gpt-5.5', display_name: 'GPT-5.5', type: 'llm', supports_vision: true, context_window: 272000 },
  { model_id: 'gpt-5.4-mini', display_name: 'GPT-5.4 Mini', type: 'llm', supports_vision: true, context_window: 272000 },
  { model_id: 'gpt-5.3-codex', display_name: 'GPT-5.3 Codex', type: 'llm', supports_vision: true, context_window: 272000 },
  { model_id: 'gpt-5.2', display_name: 'GPT-5.2', type: 'llm', supports_vision: true, context_window: 272000 },
]

/**
 * 智谱国际版（Z.AI）静态模型列表
 * Z.AI 提供 Anthropic 兼容接口，不支持 GET /models
 * 参考: https://docs.z.ai/scenario-example/develop-tools/claude
 */
const ZAI_MODELS: ModelInfo[] = [
  { model_id: 'glm-5.1', display_name: 'GLM-5.1', type: 'llm', supports_vision: false },
  { model_id: 'glm-5', display_name: 'GLM-5', type: 'llm', supports_vision: false },
  { model_id: 'glm-5-turbo', display_name: 'GLM-5 Turbo', type: 'llm', supports_vision: false },
  { model_id: 'glm-5v-turbo', display_name: 'GLM-5V Turbo', type: 'llm', supports_vision: true },
  { model_id: 'glm-4.7', display_name: 'GLM-4.7', type: 'llm', supports_vision: false },
  { model_id: 'glm-4.7-flash', display_name: 'GLM-4.7 Flash', type: 'llm', supports_vision: false },
]

const DASHSCOPE_CODING_MODELS: ModelInfo[] = [
  { model_id: 'qwen3.6-plus', display_name: 'Qwen3.6 Plus', type: 'llm', supports_vision: true, context_window: 131072 },
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
    models_api: '/models',
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
    id: 'zhipu-international',
    name: '智谱国际版 (Z.AI)',
    format: 'anthropic',
    endpoint: 'https://api.z.ai/api/anthropic',
    docs_url: 'https://docs.z.ai/scenario-example/develop-tools/claude',
    api_key_help_url: 'https://z.ai/model-api',
    default_models: ZAI_MODELS,
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
