/**
 * PermissionTemplate 服务
 */

import { api } from './api'
import type { PermissionTemplate, ToolAccessConfig, StoragePermission, PaginatedResponse } from '../types'

export const permissionTemplateService = {
  async list(params?: {
    system_only?: boolean
    page?: number
    page_size?: number
  }): Promise<PaginatedResponse<PermissionTemplate>> {
    const query = new URLSearchParams()
    if (params?.system_only) query.set('system_only', 'true')
    if (params?.page) query.set('page', String(params.page))
    if (params?.page_size) query.set('page_size', String(params.page_size))
    const qs = query.toString()
    return api.get<PaginatedResponse<PermissionTemplate>>(`/permission-templates${qs ? `?${qs}` : ''}`)
  },

  async get(id: string): Promise<{ template: PermissionTemplate }> {
    return api.get<{ template: PermissionTemplate }>(`/permission-templates/${id}`)
  },

  async create(data: {
    name: string
    description?: string
    tool_access: ToolAccessConfig
    storage?: StoragePermission | null
    memory_scopes?: string[]
  }): Promise<{ template: PermissionTemplate }> {
    return api.post<{ template: PermissionTemplate }>('/permission-templates', data)
  },

  async update(id: string, data: {
    name?: string
    description?: string
    tool_access?: ToolAccessConfig
    storage?: StoragePermission | null
    memory_scopes?: string[]
  }): Promise<{ template: PermissionTemplate }> {
    return api.patch<{ template: PermissionTemplate }>(`/permission-templates/${id}`, data)
  },

  async delete(id: string): Promise<{ deleted: true }> {
    return api.delete<{ deleted: true }>(`/permission-templates/${id}`)
  },
}
