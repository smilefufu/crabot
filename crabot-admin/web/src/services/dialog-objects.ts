import { api } from './api'
import type {
  DialogObjectApplication,
  DialogObjectFriend,
  DialogObjectGroupEntry,
  DialogObjectPrivatePoolEntry,
  Friend,
} from '../types'

export const dialogObjectsService = {
  async listFriends(): Promise<{ items: DialogObjectFriend[] }> {
    return api.get<{ items: DialogObjectFriend[] }>('/dialog-objects/friends')
  },

  async listPrivatePool(): Promise<{ items: DialogObjectPrivatePoolEntry[] }> {
    return api.get<{ items: DialogObjectPrivatePoolEntry[] }>('/dialog-objects/private-pool')
  },

  async listGroups(): Promise<{ items: DialogObjectGroupEntry[] }> {
    return api.get<{ items: DialogObjectGroupEntry[] }>('/dialog-objects/groups')
  },

  async listApplications(): Promise<{ items: DialogObjectApplication[] }> {
    return api.get<{ items: DialogObjectApplication[] }>('/dialog-objects/applications')
  },

  async assignApplicationFriend(
    applicationId: string,
    data: { friend_id: string }
  ): Promise<{ friend: Friend }> {
    return api.post<{ friend: Friend }>(
      `/dialog-objects/applications/${encodeURIComponent(applicationId)}/assign-friend`,
      data
    )
  },

  async createApplicationFriend(
    applicationId: string,
    data: { display_name: string; permission_template_id?: string }
  ): Promise<{ friend: Friend }> {
    return api.post<{ friend: Friend }>(
      `/dialog-objects/applications/${encodeURIComponent(applicationId)}/create-friend`,
      data
    )
  },

  async linkApplicationMaster(
    applicationId: string
  ): Promise<{ friend: Friend; created: boolean }> {
    return api.post<{ friend: Friend; created: boolean }>(
      `/dialog-objects/applications/${encodeURIComponent(applicationId)}/link-master`
    )
  },

  async rejectApplication(applicationId: string): Promise<{ deleted: true }> {
    return api.delete<{ deleted: true }>(
      `/dialog-objects/applications/${encodeURIComponent(applicationId)}`
    )
  },

  async assignPrivatePoolToFriend(
    sessionId: string,
    data: { channel_id: string; friend_id: string }
  ): Promise<{ friend: Friend }> {
    return api.post<{ friend: Friend }>(
      `/dialog-objects/private-pool/${encodeURIComponent(sessionId)}/assign-friend`,
      data
    )
  },

  async createFriendFromPrivatePool(
    sessionId: string,
    data: { channel_id: string; display_name: string; permission_template_id?: string }
  ): Promise<{ friend: Friend }> {
    return api.post<{ friend: Friend }>(
      `/dialog-objects/private-pool/${encodeURIComponent(sessionId)}/create-friend`,
      data
    )
  },
}
