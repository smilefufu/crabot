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

function buildQuery(params: Record<string, string | number | string[] | undefined>): string {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === '') {
      return
    }
    if (Array.isArray(value)) {
      value
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => search.append(key, item))
      return
    }
    search.set(key, String(value))
  })
  const query = search.toString()
  return query ? `?${query}` : ''
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
    friendId?: string
    accessibleScopes?: string[]
  }): Promise<{ results: ShortTermMemoryEntry[] }> {
    const q = buildQuery({
      q: params.q,
      limit: params.limit,
      module_id: params.moduleId,
      friend_id: params.friendId,
      accessible_scope: params.accessibleScopes,
    })
    return api.get<{ results: ShortTermMemoryEntry[] }>(`/memory/short-term${q}`)
  },

  async searchLongTerm(params: {
    q?: string
    limit?: number
    moduleId?: string
    friendId?: string
    accessibleScopes?: string[]
  }): Promise<{ results: Array<{ memory: LongTermMemoryEntry; relevance: number }> }> {
    const q = buildQuery({
      q: params.q,
      limit: params.limit,
      module_id: params.moduleId,
      friend_id: params.friendId,
      accessible_scope: params.accessibleScopes,
    })
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

// ============================================================================
// 场景画像（SceneProfile）— 对齐 protocol-memory.md v0.2.0
// ============================================================================

export type SceneIdentity =
  | { type: 'friend'; friend_id: string }
  | { type: 'group_session'; channel_id: string; session_id: string }
  | { type: 'global' }

export interface SceneProfile {
  scene: SceneIdentity
  label: string
  abstract: string
  overview: string
  content: string
  source_memory_ids?: string[] | null
  created_at: string
  updated_at: string
  last_declared_at?: string | null
}

export function sceneToKey(scene: SceneIdentity): string {
  if (scene.type === 'global') return 'global'
  if (scene.type === 'friend') return `friend:${scene.friend_id}`
  return `group:${scene.channel_id}:${scene.session_id}`
}

export function parseSceneKey(key: string): SceneIdentity {
  const decoded = decodeURIComponent(key)
  if (decoded === 'global') {
    return { type: 'global' }
  }
  if (decoded.startsWith('friend:')) {
    const friendId = decoded.slice('friend:'.length)
    if (!friendId) {
      throw new Error(`Invalid friend scene key: ${decoded}`)
    }
    return { type: 'friend', friend_id: friendId }
  }
  if (decoded.startsWith('group:')) {
    const rest = decoded.slice('group:'.length)
    const idx = rest.indexOf(':')
    if (idx <= 0 || idx === rest.length - 1) {
      throw new Error(`Invalid group scene key: ${decoded}`)
    }
    return {
      type: 'group_session',
      channel_id: rest.slice(0, idx),
      session_id: rest.slice(idx + 1),
    }
  }
  throw new Error(`Unknown scene key: ${decoded}`)
}

export function defaultSceneProfileLabel(scene: SceneIdentity): string {
  if (scene.type === 'global') return 'global'
  if (scene.type === 'friend') return `friend:${scene.friend_id}`
  return `group:${scene.channel_id}:${scene.session_id}`
}

export const sceneProfileService = {
  async list(params: {
    sceneType?: 'friend' | 'group_session' | 'global'
    limit?: number
    offset?: number
    moduleId?: string
  } = {}): Promise<{ profiles: SceneProfile[] }> {
    const q = buildQuery({
      scene_type: params.sceneType,
      limit: params.limit,
      offset: params.offset,
      module_id: params.moduleId,
    })
    return api.get<{ profiles: SceneProfile[] }>(`/scene-profiles${q}`)
  },

  async get(
    key: string,
    params: { onlyPublic?: boolean; moduleId?: string } = {},
  ): Promise<{ profile: SceneProfile | null }> {
    const q = buildQuery({
      only_public: params.onlyPublic ? 'true' : undefined,
      module_id: params.moduleId,
    })
    return api.get<{ profile: SceneProfile | null }>(
      `/scene-profiles/${encodeURIComponent(key)}${q}`,
    )
  },

  async patch(
    key: string,
    body: {
      label?: string
      abstract?: string
      overview?: string
      content?: string
      source_memory_ids?: string[]
    },
    moduleId?: string,
  ): Promise<{ profile: SceneProfile }> {
    const q = buildQuery({ module_id: moduleId })
    return api.patch<{ profile: SceneProfile }>(
      `/scene-profiles/${encodeURIComponent(key)}${q}`,
      body,
    )
  },

  async delete(
    key: string,
    moduleId?: string,
  ): Promise<{ deleted: boolean }> {
    const q = buildQuery({ module_id: moduleId })
    return api.delete<{ deleted: boolean }>(
      `/scene-profiles/${encodeURIComponent(key)}${q}`,
    )
  },
}
