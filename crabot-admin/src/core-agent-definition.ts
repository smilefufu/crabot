import { DEFAULT_IMPLEMENTATION } from './agent-manager.js'
import type { AgentImplementation } from './types.js'

/** Static core Agent contract. Legacy implementation records are not authoritative. */
export const CORE_AGENT_DEFINITION: AgentImplementation = Object.freeze({
  ...DEFAULT_IMPLEMENTATION,
  id: 'crabot-agent',
  name: DEFAULT_IMPLEMENTATION.name,
  model_roles: DEFAULT_IMPLEMENTATION.model_roles,
  extra_schema: DEFAULT_IMPLEMENTATION.extra_schema,
})
