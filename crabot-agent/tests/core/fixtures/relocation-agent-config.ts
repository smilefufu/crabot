import type { UnifiedAgentConfig } from '../../../src/types.js'

export const relocationAgentConfig: UnifiedAgentConfig = {
  module_id: 'crabot-agent', module_type: 'agent', version: '0.2.0', protocol_version: '3.4.0', port: 19999,
  orchestration: { front_context_recent_messages_window_hours: 1, front_context_recent_messages_max_cap: 1, front_context_short_term_memory_window_hours: 1, front_context_short_term_memory_max_cap: 1, worker_recent_messages_window_hours: 1, worker_recent_messages_max_cap: 1, worker_short_term_memory_window_hours: 1, worker_short_term_memory_max_cap: 1, worker_long_term_memory_limit: 1, front_agent_timeout: 1, session_state_ttl: 1, worker_config_refresh_interval: 1, front_agent_queue_max_length: 1, front_agent_queue_timeout: 1 },
  agent_config: { instance_id: 'crabot-agent', roles: [], system_prompt: 'fixture', model_config: { powerful: { endpoint: 'https://fixture.invalid', apikey: 'fixture', model_id: 'fixture', format: 'openai', provider_id: 'fixture' } } },
}

