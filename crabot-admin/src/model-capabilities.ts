import type { ModelInfo } from './types.js'

// Exact standard-API models, checked against the linked official pages on 2026-11-02.
// Subscription, Coding Plan, gateways and local deployments can have different limits.
const catalog: Record<string, Record<string, { supports_vision: boolean; context_window: number }>> = {
  // https://developers.openai.com/api/docs/models/{gpt-4o,gpt-5.2,gpt-5.4}
  'api.openai.com': {
    'gpt-4o': { supports_vision: true, context_window: 128000 },
    'gpt-5.2': { supports_vision: true, context_window: 400000 },
    'gpt-5.2-2025-12-11': { supports_vision: true, context_window: 400000 },
    'gpt-5.4': { supports_vision: true, context_window: 1050000 },
    'gpt-5.4-2026-03-05': { supports_vision: true, context_window: 1050000 },
  },
  // https://forum.moonshot.ai/t/kimi-k3-is-here-our-most-capable-model/480
  'api.moonshot.ai': { 'kimi-k3': { supports_vision: true, context_window: 1000000 } },
  'api.moonshot.cn': { 'kimi-k3': { supports_vision: true, context_window: 1000000 } },
  // https://docs.bigmodel.cn/cn/guide/models/{text/glm-5.2,vlm/glm-4.6v}
  'open.bigmodel.cn': {
    'glm-5.2': { supports_vision: false, context_window: 1000000 },
    'glm-4.6v': { supports_vision: true, context_window: 128000 },
  },
}

export function fillModelCapabilities<T extends ModelInfo>(model: T, connection: { endpoint: string; format: string }): T {
  if (model.type !== 'llm') return model
  let url: URL
  try { url = new URL(connection.endpoint) } catch { return model }
  if (url.protocol !== 'https:') return model
  if (url.hostname === 'open.bigmodel.cn' && !url.pathname.startsWith('/api/paas/v4')) return model
  const known = catalog[url.hostname]?.[model.model_id]
  if (!known) return model
  return { ...known, ...model,
    supports_vision: model.supports_vision ?? known.supports_vision,
    context_window: model.context_window ?? known.context_window,
  }
}

/** Saved values remain authoritative: older records do not distinguish automatic and manual sources. */
export function preserveModelSettings(fresh: ModelInfo[], previous: ModelInfo[]): ModelInfo[] {
  return fresh.map(model => {
    const saved = previous.find(item => item.model_id === model.model_id)
    return { ...model,
      ...(saved?.supports_vision !== undefined ? { supports_vision: saved.supports_vision } : {}),
      ...(saved?.context_window !== undefined ? { context_window: saved.context_window } : {}),
      ...(saved?.max_tokens !== undefined ? { max_tokens: saved.max_tokens } : {}),
    }
  })
}
