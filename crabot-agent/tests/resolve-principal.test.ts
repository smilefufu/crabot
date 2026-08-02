import { describe, it, expect, vi } from 'vitest'
import { UnifiedAgent } from '../src/unified-agent.js'
import type { Friend, ResolvedPermissions } from '../src/types.js'

/**
 * Task 5：resolvePrincipalPermissions 是 UnifiedAgent 唯一的权限解析入口
 * （取代旧 resolveSessionPermissions/resolveGroupPermissions/resolvePermissionsForTemplate/fetchFriendPermissions）。
 *
 * 这里只验证 RPC 调用形状（method 名 + params），不构造完整 UnifiedAgent。
 * 用 Object.create(prototype) 跳过重型 constructor，与 unified-agent-hot-reload.test.ts 同一模式。
 */

const ADMIN_PORT = 19001
const RESOLVED_OK: ResolvedPermissions = {
  tool_access: {
    memory: true,
    messaging: true,
    task: true,
    mcp_skill: false,
    file_io: false,
    browser: false,
    shell: false,
    remote_exec: false,
    desktop: false,
  },
  cli_access: {
    provider: 'none', agent: 'none', mcp: 'none', skill: 'none',
    schedule: 'none', channel: 'none', friend: 'none',
    permission: 'none', config: 'none', undo: 'none',
  },
  storage: null,
  memory_scopes: ['scope-a'],
}

function makeFriend(id: string): Friend {
  return {
    id,
    display_name: id,
    permission: 'normal',
    channel_identities: [],
    created_at: '2026-05-06T00:00:00Z',
    updated_at: '2026-05-06T00:00:00Z',
  }
}

function buildAgent(rpcCall: ReturnType<typeof vi.fn>): unknown {
  const agent = Object.create(UnifiedAgent.prototype) as Record<string, unknown>
  agent.config = { moduleId: 'test-agent' }
  agent.rpcClient = { call: rpcCall }
  agent.getAdminPort = async () => ADMIN_PORT
  return agent
}

type ResolveFn = (
  senderFriendId: string | undefined,
  sessionId: string,
  sessionType: 'private' | 'group',
) => Promise<ResolvedPermissions | null>

describe('UnifiedAgent.resolvePrincipalPermissions', () => {
  it('私聊：传 sender_friend_id + session_id + session_type=private', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ resolved: RESOLVED_OK, sources: {} })
    const agent = buildAgent(rpcCall)
    const friend = makeFriend('friend-1')

    const result = await (agent as { resolvePrincipalPermissions: ResolveFn })
      .resolvePrincipalPermissions(friend.id, 'session-private-1', 'private')

    expect(rpcCall).toHaveBeenCalledTimes(1)
    expect(rpcCall).toHaveBeenCalledWith(
      ADMIN_PORT,
      'resolve_principal_permissions',
      {
        sender_friend_id: 'friend-1',
        session_id: 'session-private-1',
        session_type: 'private',
      },
      'test-agent',
    )
    expect(result).toEqual(RESOLVED_OK)
  })

  it('群聊：传 sender_friend_id + session_id + session_type=group', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ resolved: RESOLVED_OK, sources: {} })
    const agent = buildAgent(rpcCall)
    const friend = makeFriend('friend-group-speaker')

    await (agent as { resolvePrincipalPermissions: ResolveFn })
      .resolvePrincipalPermissions(friend.id, 'session-group-1', 'group')

    expect(rpcCall).toHaveBeenCalledWith(
      ADMIN_PORT,
      'resolve_principal_permissions',
      {
        sender_friend_id: 'friend-group-speaker',
        session_id: 'session-group-1',
        session_type: 'group',
      },
      'test-agent',
    )
  })

  it('陌生人/无 friend：params 不带 sender_friend_id', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ resolved: RESOLVED_OK, sources: {} })
    const agent = buildAgent(rpcCall)

    await (agent as { resolvePrincipalPermissions: ResolveFn })
      .resolvePrincipalPermissions(undefined, 'session-x', 'private')

    expect(rpcCall).toHaveBeenCalledWith(
      ADMIN_PORT,
      'resolve_principal_permissions',
      {
        session_id: 'session-x',
        session_type: 'private',
      },
      'test-agent',
    )
    const sentParams = rpcCall.mock.calls[0][2] as Record<string, unknown>
    expect('sender_friend_id' in sentParams).toBe(false)
  })

  it('RPC 抛错时返回 null（fail-soft），不向上抛', async () => {
    const rpcCall = vi.fn().mockRejectedValue(new Error('admin unavailable'))
    const agent = buildAgent(rpcCall)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await (agent as { resolvePrincipalPermissions: ResolveFn })
      .resolvePrincipalPermissions(makeFriend('friend-z'), 'session-y', 'group')

    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
