/**
 * Memory 服务
 */

import { api } from './api'

export interface MemoryModule {
  module_id: string
  port: number
  name: string
}

export interface MemorySourceInfo {
  type: 'conversation' | 'reflection' | 'manual' | 'system'
  task_id?: string
  channel_id?: string
  session_id?: string
  original_time?: string
}

export interface ShortTermMemoryEntry {
  id: string
  content: string
  keywords: string[]
  event_time: string
  persons: string[]
  entities: string[]
  topic?: string
  source: MemorySourceInfo
  refs?: Record<string, string>
  compressed: boolean
  visibility: 'private' | 'internal' | 'public'
  scopes: string[]
  created_at: string
}

export interface EntityRef {
  type: string
  id: string
  name: string
}

export interface LongTermMemoryEntry {
  id: string
  abstract: string
  overview: string
  content: string
  entities: EntityRef[]
  importance: number
  keywords: string[]
  tags: string[]
  source: MemorySourceInfo
  metadata?: Record<string, unknown>
  read_count: number
  version: number
  visibility: 'private' | 'internal' | 'public'
  scopes: string[]
  created_at: string
  updated_at: string
}

export interface MemoryStats {
  short_term: {
    entry_count: number
    compressed_count: number
    total_tokens: number
    latest_entry_at: string | null
    earliest_entry_at: string | null
  }
  long_term: {
    entry_count: number
    total_tokens: number
    latest_entry_at: string | null
    earliest_entry_at: string | null
  }
}

type MemoryEntry =
  | { type: 'short'; memory: ShortTermMemoryEntry }
  | { type: 'long'; memory: LongTermMemoryEntry }

function buildQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
}

export const memoryService = {
  async listModules(): Promise<{ items: MemoryModule[] }> {
    return api.get<{ items: MemoryModule[] }>('/memory/modules')
  },

  async getStats(moduleId?: string): Promise<MemoryStats> {
    const q = buildQuery({ module_id: moduleId })
    return api.get<MemoryStats>(`/memory/stats${q}`)
  },

  async searchShortTerm(params: {
    q?: string
    limit?: number
    moduleId?: string
  }): Promise<{ results: ShortTermMemoryEntry[] }> {
    const q = buildQuery({ q: params.q, limit: params.limit, module_id: params.moduleId })
    return api.get<{ results: ShortTermMemoryEntry[] }>(`/memory/short-term${q}`)
  },

  async searchLongTerm(params: {
    q?: string
    limit?: number
    moduleId?: string
  }): Promise<{ results: Array<{ memory: LongTermMemoryEntry; relevance: number }> }> {
    const q = buildQuery({ q: params.q, limit: params.limit, module_id: params.moduleId })
    return api.get<{ results: Array<{ memory: LongTermMemoryEntry; relevance: number }> }>(`/memory/long-term${q}`)
  },

  async getMemory(id: string, moduleId?: string): Promise<MemoryEntry> {
    const q = buildQuery({ module_id: moduleId })
    return api.get<MemoryEntry>(`/memory/${id}${q}`)
  },

  async deleteMemory(id: string, moduleId?: string): Promise<{ deleted: boolean }> {
    const q = buildQuery({ module_id: moduleId })
    return api.delete<{ deleted: boolean }>(`/memory/${id}${q}`)
  },
}
