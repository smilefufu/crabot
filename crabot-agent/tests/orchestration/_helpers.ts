import { vi } from 'vitest'
import type { OrchestrationConfig } from '../../src/types.js'

export function createMockRpcClient() {
  return {
    call: vi.fn(),
    resolve: vi.fn(),
    publishEvent: vi.fn().mockResolvedValue(0),
    registerModuleDefinition: vi.fn().mockResolvedValue({}),
    startModule: vi.fn().mockResolvedValue({}),
  }
}

export const defaultOrchestrationConfig: OrchestrationConfig = {
  admin_config_path: '',
  front_context_recent_messages_limit: 20,
  front_context_memory_limit: 10,
  worker_recent_messages_limit: 50,
  worker_short_term_memory_limit: 20,
  worker_long_term_memory_limit: 20,
  front_agent_timeout: 30,
  session_state_ttl: 300,
  worker_config_refresh_interval: 60,
  front_agent_queue_max_length: 10,
  front_agent_queue_timeout: 60,
}
