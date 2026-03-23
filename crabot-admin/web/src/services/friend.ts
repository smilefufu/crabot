/**
 * Friend / PendingMessage 服务
 */

import { api } from './api'
import type {
  Friend,
  PendingMessage,
  PaginatedResponse,
  ChannelIdentity,
  FriendPermission,
} from '../types'

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

  async getFriend(id: string): Promise<{ friend: Friend }> {
    return api.get<{ friend: Friend }>(`/friends/${id}`)
  },

  async createFriend(data: {
    display_name: string
    permission: FriendPermission
    channel_identities?: ChannelIdentity[]
    permission_template_id?: string
  }): Promise<{ friend: Friend }> {
    return api.post<{ friend: Friend }>('/friends', data)
  },

  async updateFriend(id: string, data: {
    display_name?: string
    permission?: FriendPermission
    permission_template_id?: string
  }): Promise<{ friend: Friend }> {
    return api.patch<{ friend: Friend }>(`/friends/${id}`, data)
  },

  async deleteFriend(id: string): Promise<{ deleted: true }> {
    return api.delete<{ deleted: true }>(`/friends/${id}`)
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

  async listPendingMessages(params?: {
    channel_id?: string
    page?: number
    page_size?: number
  }): Promise<PaginatedResponse<PendingMessage>> {
    const query = new URLSearchParams()
    if (params?.channel_id) query.set('channel_id', params.channel_id)
    if (params?.page) query.set('page', String(params.page))
    if (params?.page_size) query.set('page_size', String(params.page_size))
    const qs = query.toString()
    return api.get<PaginatedResponse<PendingMessage>>(`/pending-messages${qs ? `?${qs}` : ''}`)
  },

  async approvePendingMessage(id: string, data: {
    display_name: string
    permission_template_id?: string
  }): Promise<{ friend: Friend; notification_sent: boolean }> {
    return api.post<{ friend: Friend; notification_sent: boolean }>(
      `/pending-messages/${id}/approve`,
      data
    )
  },

  async rejectPendingMessage(id: string): Promise<{ deleted: true }> {
    return api.delete<{ deleted: true }>(`/pending-messages/${id}`)
  },
}
