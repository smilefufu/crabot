import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'

const target = { channel_id: 'wechat-test', session_id: 'group-1', type: 'group' }
const execution = { kind: 'worker', worker_id: 'worker-1', incarnation_id: 'inc-1' }

describe('Agent CLI credential: group authorization', () => {
  let admin: any

  beforeEach(() => {
    admin = Object.create(AdminModule.prototype)
    Object.assign(admin, {
      config: { moduleId: 'admin-test' },
      adminConfig: { token_ttl: 3600 },
      jwtSecret: 'test-group-credential-secret',
      friends: new Map(),
      rpcClient: {
        callModuleManagerSensitive: vi.fn().mockResolvedValue({ verified: true }),
        call: vi.fn().mockResolvedValue({ valid: true, cli_access: 'read', shell: true }),
      },
      ensureAgentPort: vi.fn().mockResolvedValue(19005),
      resolvePrincipalPermissions: vi.fn().mockResolvedValue({
        resolved: { cli_access: { schedule: 'read' }, tool_access: { shell: true } },
      }),
    })
  })

  const issue = (admin: any, creator?: string, session = target) => admin.handleIssueAgentCliCredential({
    context: {
      execution,
      manager_key: `${session.channel_id}::${session.session_id}`,
      target_session: session,
      ...(creator ? { creator_friend_id: creator } : {}),
    },
  }, { authorizationBearer: 'test-runtime-bearer' })

  it.each(['guest:wechat-test:member', 'deleted-friend', undefined])(
    'issues a group credential independently of Friend existence: %s', async (creator) => {
      const { token } = await issue(admin, creator)
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
      expect(payload.agent_cli).toEqual({
        execution, manager_key: 'wechat-test::group-1', target_session: target,
        ...(creator ? { creator_friend_id: creator } : {}),
      })
      const result = await admin.authorizeAgentCliRequest(payload, 'GET', '/api/schedules')
      expect(admin.resolvePrincipalPermissions).toHaveBeenCalledWith({
        channel_id: target.channel_id, session_id: target.session_id, session_type: 'group',
      })
      expect(result).toMatchObject({ masterPrivate: false, shell: true })
      admin.resolvePrincipalPermissions.mockResolvedValue({
        resolved: { cli_access: { schedule: 'none' }, tool_access: { shell: false } },
      })
      await expect(admin.authorizeAgentCliRequest(payload, 'GET', '/api/schedules'))
        .rejects.toMatchObject({ code: 'FORBIDDEN' })
    },
  )

  it.each(['guest:wechat-test:member', 'deleted-friend', undefined])(
    'still rejects a private credential without a trusted Friend: %s', async (creator) => {
      await expect(issue(admin, creator, { ...target, type: 'private' }))
        .rejects.toMatchObject({ code: 'FORBIDDEN' })
    },
  )

  it('does not bypass core Agent authentication for groups', async () => {
    admin.rpcClient.callModuleManagerSensitive.mockRejectedValue(new Error('invalid runtime bearer'))
    await expect(issue(admin, 'guest:wechat-test:member')).rejects.toThrow('invalid runtime bearer')
  })
})
