import { api } from './api'

export type MemoryType = 'fact' | 'lesson' | 'concept'
export type MemoryStatus = 'inbox' | 'confirmed' | 'trash'
export type MemoryMaturity =
  | 'observed' | 'confirmed' | 'stale'
  | 'case' | 'rule' | 'retired'
  | 'draft' | 'established'

export type EvolutionMode = 'balanced' | 'innovate' | 'harden' | 'repair-only'

export interface ImportanceFactors {
  proximity: number
  surprisal: number
  entity_priority: number
  unambiguity: number
}

export interface SourceRef {
  type: 'conversation' | 'reflection' | 'manual' | 'system'
  task_id?: string
  session_id?: string
  channel_id?: string
  trace_id?: string
}

export interface EntityRef { type: string; id: string; name: string }

export interface LessonMeta {
  scenario?: string
  outcome?: 'success' | 'failure'
  source_cases?: string[]
  use_count?: number
  last_validated_at?: string
}

export interface ObservationMeta {
  promoted_at?: string
  observation_window_days?: number
  validation_outcome?: 'pass' | 'fail' | 'pending'
  last_seen_at?: string
  stale_check_count?: number
}

export interface MemoryFrontmatter {
  id: string
  type: MemoryType
  maturity: MemoryMaturity
  brief: string
  author: string
  source_ref: SourceRef
  source_trust: number
  content_confidence: number
  importance_factors: ImportanceFactors
  entities: EntityRef[]
  tags: string[]
  event_time: string
  ingestion_time: string
  invalidated_by?: string
  lesson_meta?: LessonMeta
  observation?: ObservationMeta
  version: number
  prev_version_ids?: string[]
}

export interface MemoryEntryV2 {
  id: string
  type: MemoryType
  status: MemoryStatus
  brief: string
  body?: string
  frontmatter?: MemoryFrontmatter
}

export interface ListEntriesParams {
  type?: MemoryType
  status?: MemoryStatus
  author?: string
  tags?: string[]
  limit?: number
  offset?: number
  sort?: string
}

export interface CreateEntryParams {
  type: MemoryType
  brief: string
  content: string
  source_ref: SourceRef
  source_trust: number
  content_confidence: number
  importance_factors: ImportanceFactors
  entities: EntityRef[]
  tags: string[]
  event_time: string
}

export interface ObservationPendingItem {
  id: string
  type: MemoryType
  brief: string
  promoted_at: string
  observation_window_days: number
  validation_outcome: 'pending'
  last_seen_at?: string
  /** 引用此记忆的任务被用户表态 pass 的累计计数（含 strong_pass 加权 2） */
  observation_pass_count?: number
  /** 引用此记忆的任务被用户表态 fail 的累计计数（含 strong_fail 加权 2） */
  observation_fail_count?: number
}

function buildQuery(params: Record<string, string | number | string[] | undefined>): string {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === '') return
    if (Array.isArray(v)) {
      const joined = v.map(s => s.trim()).filter(Boolean).join(',')
      if (joined) search.set(k, joined)
      return
    }
    search.set(k, String(v))
  })
  const q = search.toString()
  return q ? `?${q}` : ''
}

export const memoryV2Service = {
  async listEntries(params: ListEntriesParams = {}): Promise<{ items: MemoryEntryV2[]; total?: number }> {
    return api.get(`/memory/v2/entries${buildQuery({ ...params })}`)
  },

  async getEntry(id: string, opts: { include?: 'brief' | 'full' } = {}): Promise<MemoryEntryV2> {
    return api.get(`/memory/v2/entries/${encodeURIComponent(id)}${buildQuery({ include: opts.include })}`)
  },

  async getEntryVersion(id: string, version: number): Promise<{
    id: string
    version: number
    body: string
    frontmatter: MemoryFrontmatter
  } | { error: string }> {
    return api.get(
      `/memory/v2/entries/${encodeURIComponent(id)}/versions/${encodeURIComponent(String(version))}`,
    )
  },

  async createEntry(payload: CreateEntryParams): Promise<{ id: string; status: string }> {
    return api.post('/memory/v2/entries', payload)
  },

  async patchEntry(id: string, patch: Partial<MemoryFrontmatter> & { body?: string }): Promise<{ id: string; version: number; status: string }> {
    return api.patch(`/memory/v2/entries/${encodeURIComponent(id)}`, { patch })
  },

  async deleteEntry(id: string): Promise<void> {
    await api.delete(`/memory/v2/entries/${encodeURIComponent(id)}`)
  },

  async restoreEntry(id: string): Promise<{ id: string; status: string }> {
    return api.post(`/memory/v2/entries/${encodeURIComponent(id)}/restore`, {})
  },

  async getEvolutionMode(): Promise<{ mode: EvolutionMode; last_changed_at: string; reason: string }> {
    return api.get('/memory/v2/evolution-mode')
  },

  async setEvolutionMode(mode: EvolutionMode, reason: string): Promise<{ status: string }> {
    return api.put('/memory/v2/evolution-mode', { mode, reason })
  },

  async getObservationPending(): Promise<{ items: ObservationPendingItem[] }> {
    return api.get('/memory/v2/observation-pending')
  },

  async markObservationPass(id: string): Promise<{ id: string; status: string }> {
    return api.post(`/memory/v2/entries/${encodeURIComponent(id)}/mark-observation-pass`, {})
  },

  async extendObservationWindow(id: string, days?: number): Promise<{ id: string; new_window_days: number }> {
    const payload: { days?: number } = {}
    if (days !== undefined) payload.days = days
    return api.post(`/memory/v2/entries/${encodeURIComponent(id)}/extend-observation`, payload)
  },

  async keywordSearch(params: { query: string; type?: MemoryType; status?: MemoryStatus | 'all'; limit?: number }): Promise<{ items: MemoryEntryV2[] }> {
    return api.post('/memory/v2/entries/search-keyword', params)
  },

  async runMaintenance(
    scope: 'observation_check' | 'stale_aging' | 'trash_cleanup' | 'all' = 'all',
  ): Promise<{ ran: string[]; report: Record<string, unknown> }> {
    return api.post('/memory/v2/maintenance/run', { scope })
  },
}
