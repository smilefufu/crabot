/**
 * Friend / PendingMessage 服务
 */

import { api } from './api'
import type {
  Friend,
  PaginatedResponse,
  ChannelIdentity,
  FriendPermission,
  StoragePermission,
  ToolAccessConfig,
} from '../types'

export interface FriendPermissionConfig {
  tool_access: ToolAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
  updated_at: string
}

export interface FriendPermissionResolved {
  tool_access: ToolAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
}

export interface FriendPermissionResponse {
  config: FriendPermissionConfig | null
  resolved: FriendPermissionResolved | null
}

export type FriendPermissionUpdateConfig = Omit<FriendPermissionConfig, 'updated_at'>

export const friendService = {
  async listFriends(params?: {
    permission?: FriendPermission
    search?: string
    page?: number
    page_size?: number
  }): Promise<PaginatedResponse<Friend>> {
    const query = new URLSearchParams()
    if (params?.permission) query.set('permission', params.permission)
    if (params?.search) query.set('search', params.search)
    if (params?.page) query.set('page', String(params.page))
    if (params?.page_size) query.set('page_size', String(params.page_size))
    const qs = query.toString()
    return api.get<PaginatedResponse<Friend>>(`/friends${qs ? `?${qs}` : ''}`)
  },
  async updateFriend(id: string, data: {
    display_name?: string
    permission?: FriendPermission
    permission_template_id?: string
  }): Promise<{ friend: Friend }> {
    return api.patch<{ friend: Friend }>(`/friends/${id}`, data)
  },

  async linkIdentity(friendId: string, identity: ChannelIdentity): Promise<{ friend: Friend }> {
    return api.post<{ friend: Friend }>(`/friends/${friendId}/identities`, {
      channel_identity: identity,
    })
  },

  async unlinkIdentity(friendId: string, channelId: string, platformUserId: string): Promise<{ friend: Friend }> {
    return api.delete<{ friend: Friend }>(
      `/friends/${friendId}/identities/${encodeURIComponent(channelId)}/${encodeURIComponent(platformUserId)}`
    )
  },

  async getPermissions(friendId: string): Promise<FriendPermissionResponse> {
    return api.get<FriendPermissionResponse>(`/friends/${encodeURIComponent(friendId)}/permissions`)
  },

  async updatePermissions(
    friendId: string,
    config: FriendPermissionUpdateConfig
  ): Promise<{ config: FriendPermissionConfig }> {
    return api.put<{ config: FriendPermissionConfig }>(
      `/friends/${encodeURIComponent(friendId)}/permissions`,
      { config }
    )
  },
}
