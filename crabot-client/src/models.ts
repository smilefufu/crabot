import { z } from 'zod'
import type { HttpClient, RequestOptions } from './http.js'

// Read projections of protocol-admin §3.19. Credentials and persistence-only
// provider fields are deliberately absent from model selection state.
const Ref = z.object({ provider_id: z.string(), model_id: z.string() })
const Config = z.object({ default_llm_provider_id: z.string().optional(), default_llm_model_id: z.string().optional() })
const GlobalResult = z.object({ config: Config })
const ProviderChoices = z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), status: z.enum(['active', 'inactive', 'error']),
  models: z.array(z.object({ model_id: z.string(), display_name: z.string(), type: z.enum(['llm', 'image']) })) })) })
const AgentConfig = z.object({ config: z.object({ models: z.object({ manager: Ref.optional() }) }).nullable() })
export type ModelChoiceProvider = z.infer<typeof ProviderChoices>['items'][number]

export class ModelClient {
  constructor(private readonly http: HttpClient) {}
  globalConfig(options?: RequestOptions) { return this.http.request('/model-config/global', GlobalResult, { ...options, method: 'GET' }) }
  choices(options?: RequestOptions) { return this.http.request('/model-providers', ProviderChoices, { ...options, method: 'GET' }) }
  managerConfig(options?: RequestOptions) { return this.http.request('/model-config/agents/crabot-agent', AgentConfig, { ...options, method: 'GET' }) }
  selectDefault(ref: z.infer<typeof Ref>, options?: RequestOptions) {
    const value = Ref.parse(ref)
    const headers = new Headers(options?.headers); headers.set('Content-Type', 'application/json')
    const result = GlobalResult.refine(result => result.config.default_llm_provider_id === value.provider_id && result.config.default_llm_model_id === value.model_id)
    return this.http.request('/model-config/global', result, { ...options, method: 'PATCH', body: JSON.stringify({
      default_llm_provider_id: value.provider_id, default_llm_model_id: value.model_id,
    }), headers })
  }
  async hasManagerModel(options?: RequestOptions): Promise<boolean> {
    const [global, providers] = await Promise.all([this.globalConfig(options), this.choices(options)])
    const valid = (ref: z.infer<typeof Ref> | undefined) => !!ref && providers.items.some(provider => provider.id === ref.provider_id
      && provider.status === 'active' && provider.models.some(model => model.type === 'llm' && model.model_id === ref.model_id))
    if (global.config.default_llm_provider_id && global.config.default_llm_model_id
      && valid({ provider_id: global.config.default_llm_provider_id, model_id: global.config.default_llm_model_id })) return true
    return valid((await this.managerConfig(options)).config?.models.manager)
  }
}
