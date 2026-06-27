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
  front_context_recent_messages_window_hours: 6,
  front_context_recent_messages_max_cap: 50,
  front_context_short_term_memory_window_hours: 12,
  front_context_short_term_memory_max_cap: 30,
  worker_recent_messages_window_hours: 4,
  worker_recent_messages_max_cap: 50,
  worker_short_term_memory_window_hours: 12,
  worker_short_term_memory_max_cap: 30,
  worker_long_term_memory_limit: 20,
  front_agent_timeout: 30,
  session_state_ttl: 300,
  worker_config_refresh_interval: 60,
  front_agent_queue_max_length: 10,
  front_agent_queue_timeout: 60,
}
