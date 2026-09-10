/**
 * resolve_principal_permissions 对 admin chat 合成 master 身份的解析
 *
 * 背景：chat-manager 构造 process_message 时固定 sender.friend_id='master'（合成 id），
 * 但真实 master friend 的 id 是 UUID。修复前 friends.get('master') 查不到 →
 * 落 minimal（陌生人）模板 → worker 工具全被滤光（tools=[]），admin chat 回复链路静默断裂。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from './index.js'

const TEST_PROTOCOL_PORT = 19832
const TEST_WEB_PORT = 13032
const TEST_DATA_DIR = './test-data/admin-chat-master-perm-test'

describe('resolvePrincipalPermissions: admin chat 合成 master 身份', () => {
  let admin: AdminModule

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    admin = new AdminModule(
      {
        moduleId: 'admin-chat-master-perm-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD_MASTERPERM',
        jwt_secret_env: 'TEST_JWT_SECRET_MASTERPERM',
        token_ttl: 3600,
      }
    )
    process.env.TEST_ADMIN_PASSWORD_MASTERPERM = 'test_password_123'
    process.env.TEST_JWT_SECRET_MASTERPERM = 'test_jwt_secret_at_least_32_chars'
    await admin.start()
  })

  afterAll(async () => {
    await admin.stop()
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("sender_friend_id='master' 且无 master friend 记录 → 按 master_private 模板解析（不落 minimal）", async () => {
    const result = await (admin as any).resolvePrincipalPermissions({
      sender_friend_id: 'master',
      session_id: 'admin-chat',
      session_type: 'private',
    })
    expect(result.sources.friend_template_id).toBe('master_private')
    expect(result.sources.fallback).toBeUndefined()
  })

  it("sender_friend_id='master' 且存在真实 master friend → 同样按 master 解析", async () => {
    ;(admin as any).handleCreateFriend({
      display_name: '主人',
      permission: 'master',
    })
    const result = await (admin as any).resolvePrincipalPermissions({
      sender_friend_id: 'master',
      session_id: 'admin-chat',
      session_type: 'private',
    })
    expect(result.sources.friend_template_id).toBe('master_private')
  })

  it('admin chat 合成 master 身份可以签发 Agent CLI 凭据', async () => {
    vi.spyOn((admin as any).rpcClient, 'callModuleManagerSensitive').mockResolvedValue({ verified: true })

    await expect((admin as any).handleIssueAgentCliCredential(
      {
        context: {
          execution: { kind: 'worker', worker_id: 'worker-1', incarnation_id: 'inc-1' },
          manager_key: 'admin-web::admin-chat',
          target_session: { channel_id: 'admin-web', session_id: 'admin-chat', type: 'private' },
          creator_friend_id: 'master',
        },
      },
      { authorizationBearer: 'runtime-bearer' },
    )).resolves.toMatchObject({ token: expect.any(String) })
  })

  it('admin chat 合成 master 凭据保留跨会话 master 权限', async () => {
    vi.spyOn(admin as any, 'ensureAgentPort').mockResolvedValue(19002)
    vi.spyOn((admin as any).rpcClient, 'call').mockResolvedValue({ valid: true, cli_access: 'read', shell: false })

    const result = await (admin as any).authorizeAgentCliRequest(
      {
        agent_cli: {
          execution: { kind: 'worker', worker_id: 'worker-1', incarnation_id: 'inc-1' },
          manager_key: 'admin-web::admin-chat',
          target_session: { channel_id: 'admin-web', session_id: 'admin-chat', type: 'private' },
          creator_friend_id: 'master',
        },
      },
      'GET',
      '/api/schedules',
    )

    expect(result.masterPrivate).toBe(true)
  })

  it('不存在的普通 friend id → 仍落 minimal 兜底（回归）', async () => {
    const result = await (admin as any).resolvePrincipalPermissions({
      sender_friend_id: 'no-such-friend',
      session_id: 'some-session',
      session_type: 'private',
    })
    expect(result.sources.fallback).toBe('minimal')
  })
})
