import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PermissionChecker } from '../../src/orchestration/permission-checker.js'

function createMockRpcClient() {
  return {
    call: vi.fn(),
    resolve: vi.fn().mockResolvedValue([]),
    publishEvent: vi.fn().mockResolvedValue(0),
    registerModuleDefinition: vi.fn().mockResolvedValue({}),
    startModule: vi.fn().mockResolvedValue({}),
  }
}

const masterFriend = {
  id: 'friend-master',
  display_name: 'Master',
  permission: 'master' as const,
  channel_identities: [{ channel_id: 'ch-1', platform_user_id: 'user-1' }],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const normalFriend = {
  id: 'friend-normal',
  display_name: 'Normal',
  permission: 'normal' as const,
  permission_template_id: 'tpl-1',
  channel_identities: [{ channel_id: 'ch-1', platform_user_id: 'user-2' }],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

describe('PermissionChecker', () => {
  let checker: PermissionChecker
  let mockRpc: ReturnType<typeof createMockRpcClient>

  beforeEach(() => {
    mockRpc = createMockRpcClient()
    checker = new PermissionChecker(mockRpc as any, 'flow-default', () => 19100)
  })

  describe('private chat', () => {
    it('should allow master', async () => {
      mockRpc.call.mockResolvedValueOnce({ friend: masterFriend })

      const result = await checker.checkPermission({
        channel_id: 'ch-1',
        session_id: 'session-1',
        sender_id: 'user-1',
        message: 'hello',
        is_group: false,
        is_at_bot: false,
      })

      expect(result.allowed).toBe(true)
      expect(result.friend?.permission).toBe('master')
    })

    it('should allow normal friend', async () => {
      mockRpc.call
        .mockResolvedValueOnce({ friend: normalFriend })
        .mockResolvedValueOnce({ config: { desktop: false, network: { mode: 'whitelist', rules: [] }, storage: [], memory_scopes: ['default'], template_id: 'tpl-1', updated_at: '2026-01-01T00:00:00Z' } })

      const result = await checker.checkPermission({
        channel_id: 'ch-1',
        session_id: 'session-1',
        sender_id: 'user-2',
        message: 'hello',
        is_group: false,
        is_at_bot: false,
      })

      expect(result.allowed).toBe(true)
      expect(result.friend?.permission).toBe('normal')
    })

    it('should return pending_authorization for unknown sender', async () => {
      mockRpc.call.mockResolvedValueOnce({ friend: null })

      const result = await checker.checkPermission({
        channel_id: 'ch-1',
        session_id: 'session-1',
        sender_id: 'unknown',
        message: 'hello',
        is_group: false,
        is_at_bot: false,
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('pending_authorization')
    })
  })

  describe('group chat', () => {
    it('should reject if not @bot', async () => {
      mockRpc.call.mockResolvedValueOnce({ friend: masterFriend })

      const result = await checker.checkPermission({
        channel_id: 'ch-1',
        session_id: 'group-session-1',
        sender_id: 'user-1',
        message: 'hello',
        is_group: true,
        is_at_bot: false,
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('not_mentioned')
    })

    it('should allow master with @bot', async () => {
      mockRpc.call.mockResolvedValueOnce({ friend: masterFriend })

      const result = await checker.checkPermission({
        channel_id: 'ch-1',
        session_id: 'group-session-1',
        sender_id: 'user-1',
        message: '@bot hello',
        is_group: true,
        is_at_bot: true,
      })

      expect(result.allowed).toBe(true)
    })

    it('should reject non-friend in group', async () => {
      mockRpc.call.mockResolvedValueOnce({ friend: null })

      const result = await checker.checkPermission({
        channel_id: 'ch-1',
        session_id: 'group-session-1',
        sender_id: 'stranger',
        message: '@bot hello',
        is_group: true,
        is_at_bot: true,
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('not_friend')
    })
  })
})