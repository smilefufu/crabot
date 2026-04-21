import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { friendService } from './friend'
import type { FriendPermissionResponse, FriendPermissionConfig, FriendPermissionUpdateConfig } from './friend'

vi.mock('./api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

const apiMock = vi.mocked(api)

describe('friendService permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('gets friend permissions from the permissions endpoint', async () => {
    const response: FriendPermissionResponse = {
      config: {
        tool_access: {
          memory: true,
          messaging: false,
          task: true,
          mcp_skill: false,
          file_io: true,
          browser: false,
          shell: true,
          remote_exec: false,
          desktop: false,
        },
        storage: { workspace_path: '/workspace', access: 'readwrite' },
        memory_scopes: ['session-1'],
        updated_at: '2026-04-21T00:00:00.000Z',
      },
      resolved: {
        tool_access: {
          memory: true,
          messaging: true,
          task: true,
          mcp_skill: true,
          file_io: true,
          browser: true,
          shell: true,
          remote_exec: true,
          desktop: true,
        },
        storage: { workspace_path: '/', access: 'readwrite' },
        memory_scopes: [],
      },
    }
    apiMock.get.mockResolvedValueOnce(response)

    await expect(friendService.getPermissions('friend-1')).resolves.toEqual(response)
    expect(apiMock.get).toHaveBeenCalledWith('/friends/friend-1/permissions')
  })

  it('updates friend permissions with an explicit config payload', async () => {
    const config: FriendPermissionUpdateConfig = {
      tool_access: {
        memory: true,
        messaging: false,
        task: true,
        mcp_skill: false,
        file_io: true,
        browser: false,
        shell: true,
        remote_exec: false,
        desktop: false,
      },
      storage: null,
      memory_scopes: ['scope-a', 'scope-b'],
    }
    const response: { config: FriendPermissionConfig } = {
      config: {
        ...config,
        updated_at: '2026-04-21T00:00:00.000Z',
      },
    }
    apiMock.put.mockResolvedValueOnce(response)

    await expect(friendService.updatePermissions('friend-2', config)).resolves.toEqual(response)
    expect(apiMock.put).toHaveBeenCalledWith('/friends/friend-2/permissions', { config })
  })

  it('encodes reserved characters in permission requests', async () => {
    apiMock.get.mockResolvedValueOnce({
      config: null,
      resolved: null,
    })

    await friendService.getPermissions('friend/1?x=y#z')

    expect(apiMock.get).toHaveBeenCalledWith('/friends/friend%2F1%3Fx%3Dy%23z/permissions')
  })
})
