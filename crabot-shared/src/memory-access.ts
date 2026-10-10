/** protocol-memory §3.0: trusted host context; never a model argument. */
export interface MemoryAccessContext {
  actor_kind: 'conversation' | 'master_private' | 'admin' | 'builtin_reflection' | 'builtin_graph_rebuild' | 'mechanical'
  memory_enabled: boolean
  scene?: { type: 'friend'; friend_id: string } | { type: 'group_session'; channel_id: string; session_id: string }
}

export const MEMORY_DATA_RPC_METHODS = [
  'write_short_term', 'search_short_term', 'batch_write_short_term', 'write_long_term', 'search_long_term',
  'get_memory', 'delete_memory', 'update_memory', 'update_long_term', 'quick_capture', 'grep_memory',
  'list_recent', 'find_by_entity', 'find_by_tag', 'get_cases_about', 'list_entries', 'keyword_search',
  'get_entry_version', 'promote_inbox_entry', 'promote_to_rule', 'get_confirmed_snapshot', 'bump_lesson_use',
  'report_task_feedback', 'get_observation_pending', 'mark_observation_pass', 'extend_observation_window',
  'upsert_scene_profile', 'get_scene_profile', 'delete_scene_profile', 'list_scene_profiles', 'list_scene_profiles_by_memory',
  'get_stats', 'get_evolution_mode', 'set_evolution_mode', 'get_reflection_watermark', 'update_reflection_watermark',
  'get_memory_graph', 'run_maintenance', 'trigger_consolidation', 'export_memories', 'import_memories', 'import_long_term',
  'restore_memory', 'preview_historical_inbox', 'migrate_historical_inbox_batch',
] as const

export type MemoryDataRpcMethod = typeof MEMORY_DATA_RPC_METHODS[number]

const memoryMethods = new Set<string>(MEMORY_DATA_RPC_METHODS)

export function isMemoryDataRpcCall(method: string, params: unknown): boolean {
  return memoryMethods.has(method) && !!params && typeof params === 'object'
    && (params as { access_context?: unknown }).access_context !== undefined
}
