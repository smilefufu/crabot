/**
 * Session 服务
 */

import { api } from './api'
import type { ToolAccessConfig, CliAccessConfig, StoragePermission } from '../types'

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

export interface GroupSessionPermissionConfig {
  tool_access?: Partial<ToolAccessConfig>
  cli_access?: Partial<CliAccessConfig>
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

  async getGroupConfig(channelId: string, sessionId: string): Promise<{ config: GroupSessionPermissionConfig | null }> {
    return api.get(`/group-sessions/${encodeURIComponent(channelId)}/${encodeURIComponent(sessionId)}/config`)
  },

  async updateGroupConfig(channelId: string, sessionId: string, config: Omit<GroupSessionPermissionConfig, 'updated_at'>): Promise<{ config: GroupSessionPermissionConfig }> {
    return api.put(`/group-sessions/${encodeURIComponent(channelId)}/${encodeURIComponent(sessionId)}/config`, { config })
  },

  async deleteGroupConfig(channelId: string, sessionId: string): Promise<{ deleted: true }> {
    return api.delete(`/group-sessions/${encodeURIComponent(channelId)}/${encodeURIComponent(sessionId)}/config`)
  },
}
