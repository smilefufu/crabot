import { api } from './api'
import type { Schedule, ScheduleTrigger, ScheduleTaskTemplate } from '../types'

export interface ScheduleListResult {
  items: Schedule[]
  pagination: {
    page: number
    page_size: number
    total_items: number
    total_pages: number
  }
}

export interface CreateScheduleData {
  name: string
  description?: string
  enabled?: boolean
  trigger: ScheduleTrigger
  task_template: ScheduleTaskTemplate
  target_session?: Schedule['target_session']
}

export const scheduleService = {
  async list(params?: {
    page?: number
    page_size?: number
    enabled?: boolean
    trigger_type?: string
    search?: string
  }): Promise<ScheduleListResult> {
    const query = new URLSearchParams()
    if (params?.page) query.set('page', String(params.page))
    if (params?.page_size) query.set('page_size', String(params.page_size))
    if (params?.enabled !== undefined) query.set('enabled', String(params.enabled))
    if (params?.trigger_type) query.set('trigger_type', params.trigger_type)
    if (params?.search) query.set('search', params.search)
    const qs = query.toString()
    return api.get<ScheduleListResult>(`/schedules${qs ? `?${qs}` : ''}`)
  },

  async get(id: string): Promise<{ schedule: Schedule }> {
    return api.get<{ schedule: Schedule }>(`/schedules/${encodeURIComponent(id)}`)
  },

  async create(data: CreateScheduleData): Promise<{ schedule: Schedule }> {
    return api.post<{ schedule: Schedule }>('/schedules', data)
  },

  async update(
    id: string,
    data: Partial<Pick<Schedule, 'name' | 'description' | 'enabled' | 'trigger' | 'task_template'>> & {
      /** 显式 null 表示清除 target_session（与 admin RPC 语义一致） */
      target_session?: Schedule['target_session'] | null
    }
  ): Promise<{ schedule: Schedule }> {
    return api.patch<{ schedule: Schedule }>(`/schedules/${encodeURIComponent(id)}`, data)
  },

  async delete(id: string): Promise<void> {
    await api.delete(`/schedules/${encodeURIComponent(id)}`)
  },

  /** P7/J：受理即返回，触发的那一刻还不存在 task，故不再回 task_id。 */
  async triggerNow(id: string): Promise<{ accepted: true; schedule: Schedule }> {
    return api.post<{ accepted: true; schedule: Schedule }>(
      `/schedules/${encodeURIComponent(id)}/trigger`
    )
  },
}
