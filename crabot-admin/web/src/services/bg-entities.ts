/**
 * Bg-entity web service — typed helpers for /api/bg-entities.
 * Plan 3 Task 4.
 */

import { api } from './api'

export interface BgEntity {
  entity_id: string
  type: 'shell' | 'agent'
  status: 'running' | 'completed' | 'failed' | 'killed' | 'stalled'
  command?: string
  task_description?: string
  spawned_at: string
  ended_at: string | null
  exit_code: number | null
  spawned_by_task_id: string
}

export interface BgEntityLogResult {
  content: string
  new_offset: number
  status: string
  type: string
}

export const bgEntitiesService = {
  async list(): Promise<{ entities: BgEntity[] }> {
    return api.get<{ entities: BgEntity[] }>('/bg-entities')
  },

  async getLog(id: string, fromOffset = 0): Promise<BgEntityLogResult> {
    return api.get<BgEntityLogResult>(
      `/bg-entities/${encodeURIComponent(id)}/log?from_offset=${fromOffset}`,
    )
  },

  async kill(id: string): Promise<{ ok: boolean; message?: string }> {
    return api.delete<{ ok: boolean; message?: string }>(
      `/bg-entities/${encodeURIComponent(id)}`,
    )
  },
}
