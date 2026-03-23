/**
 * 预置厂商定义
 *
 * 提供常见 LLM/Embedding 厂商的预配置信息
 */

import type { PresetVendor } from './types.js'

export const PRESET_VENDORS: readonly PresetVendor[] = [
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
    models_api: '/models',
    docs_url: 'https://help.aliyun.com/zh/model-studio/',
    api_key_help_url: 'https://bailian.console.aliyun.com/?apiKey=1',
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
] as const

export function findPresetVendor(vendorId: string): PresetVendor | undefined {
  return PRESET_VENDORS.find((v) => v.id === vendorId)
}
