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

// ---------------------------------------------------------------------------
// 展示 helper（status 文案/配色、时长格式化）——供 TaskBgShells / LogModal 共用，
// 避免散落在多处导致改一处文案要改好几份（原本各抄一份自 EntityRow）。
// ---------------------------------------------------------------------------

export function bgStatusLabel(status: string): string {
  switch (status) {
    case 'running': return '运行中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'killed': return '已停止'
    case 'stalled': return '停滞'
    default: return status
  }
}

export function bgStatusColor(status: string): string {
  switch (status) {
    case 'running': return '#10b981'
    case 'completed': return '#6b7280'
    case 'failed': return '#ef4444'
    case 'killed': return '#f59e0b'
    case 'stalled': return '#f97316'
    default: return '#6b7280'
  }
}

/** 后台实体已运行时长（spawned_at → ended_at|now）。 */
export function bgFormatRuntime(entity: Pick<BgEntity, 'spawned_at' | 'ended_at'>): string {
  const startMs = new Date(entity.spawned_at).getTime()
  const endMs = entity.ended_at ? new Date(entity.ended_at).getTime() : Date.now()
  const diff = endMs - startMs
  if (diff < 0) return '-'
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ${Math.round((diff % 60_000) / 1000)}s`
  return `${Math.floor(diff / 3600_000)}h ${Math.floor((diff % 3600_000) / 60_000)}m`
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
