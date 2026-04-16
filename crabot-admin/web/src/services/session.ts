/**
 * Session 服务
 */

import { api } from './api'
import type { ToolAccessConfig, StoragePermission } from '../types'

export interface ChannelSession {
  id: string
  channel_id: string
  type: 'private' | 'group'
  platform_session_id: string
  title: string
  participants: Array<{
    friend_id?: string
    platform_user_id: string
    role: string
  }>
}

export interface SessionPermissionConfig {
  tool_access?: Partial<ToolAccessConfig>
  storage?: StoragePermission | null
  memory_scopes?: string[]
  template_id?: string
  updated_at: string
}

export const sessionService = {
  async listSessions(channelId: string, type?: string): Promise<{ items: ChannelSession[]; pagination: { total_items: number } }> {
    const query = new URLSearchParams()
    if (type) query.set('type', type)
    const qs = query.toString()
    return api.get(`/channels/${encodeURIComponent(channelId)}/sessions${qs ? `?${qs}` : ''}`)
  },

  async getConfig(sessionId: string): Promise<{ config: SessionPermissionConfig | null }> {
    return api.get(`/sessions/${encodeURIComponent(sessionId)}/config`)
  },

  async updateConfig(sessionId: string, config: Omit<SessionPermissionConfig, 'updated_at'>): Promise<{ config: SessionPermissionConfig }> {
    return api.put(`/sessions/${encodeURIComponent(sessionId)}/config`, { config })
  },

  async deleteConfig(sessionId: string): Promise<{ deleted: boolean }> {
    return api.delete(`/sessions/${encodeURIComponent(sessionId)}/config`)
  },
}
