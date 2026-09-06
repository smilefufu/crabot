import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sha256CanonicalJson } from 'crabot-shared'
import { AdminModule } from './index.js'
import { newCredentialsFromPassword, writeCredentials } from './credentials.js'

const KEY = 'feishu::cotton-candy'
const WEB_PORT = 13057
const PROTOCOL_PORT = 19857

const ITEM = {
  title: '核查上下文',
  status: 'in_progress',
  objective: '确认 Manager 的上下文状态',
  acceptance: ['能说明发生过的事情'],
  current_state: '等待核查',
  next_action: '读取调用记录',
  blockers: [],
}

describe('Manager workboard Admin API', () => {
  let admin: AdminModule
  let dataDir: string
  let token: string

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'workboard-management-api-'))
    process.env.TEST_JWT_SECRET_WORKBOARD = 'test_jwt_secret_at_least_32_chars'
    await writeCredentials(dataDir, await newCredentialsFromPassword('test_password_123', { is_temp: false, changed_via: 'start' }))
    admin = new AdminModule(
      { moduleId: 'admin-workboard-api-test', moduleType: 'admin', version: '0.1.0', protocolVersion: '0.1.0', port: PROTOCOL_PORT, subscriptions: [] },
      { web_port: WEB_PORT, data_dir: dataDir, password_env: 'TEST_ADMIN_WEB_PASSWORD', jwt_secret_env: 'TEST_JWT_SECRET_WORKBOARD', token_ttl: 3600 },
    )
    await admin.start()
    const login = await fetch(`http://localhost:${WEB_PORT}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test_password_123' }),
    })
    token = (await login.json() as { token: string }).token
  })

  afterAll(async () => {
    await admin.stop()
    await rm(dataDir, { recursive: true, force: true })
    delete process.env.TEST_JWT_SECRET_WORKBOARD
  })

  const endpoint = `/api/agent/managers/${encodeURIComponent(KEY)}/workboard`
  const headers = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

  it('要求 JWT，并只 decode 一次 manager key 后代理 GET 参数', async () => {
    expect((await fetch(`http://localhost:${WEB_PORT}${endpoint}`)).status).toBe(401)

    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(admin as unknown as { callAgentRpc: (method: string, params: Record<string, unknown>) => Promise<unknown> }).callAgentRpc = async (method, params) => {
      calls.push({ method, params })
      return {
        manager_key: KEY,
        revision: 4,
        view: 'archive',
        items: [],
        active_count: 1,
        archive_count: 2,
        pagination: { page: 2, page_size: 4, total_items: 2, total_pages: 1 },
      }
    }

    const response = await fetch(`http://localhost:${WEB_PORT}${endpoint}?view=archive&page=2&page_size=4`, { headers: headers() })
    expect(response.status).toBe(200)
    expect(calls).toEqual([{
      method: 'get_workboard_admin',
      params: { manager_key: KEY, view: 'archive', page: 2, page_size: 4 },
    }])
    expect((await response.json() as { revision: number }).revision).toBe(4)

    const invalid = await fetch(`http://localhost:${WEB_PORT}${endpoint}?page=0`, { headers: headers() })
    expect(invalid.status).toBe(400)
  })

  it('PATCH 由服务端签发 assertion，并经 callSensitive 转交 Agent', async () => {
    const calls: Array<{ port: number; method: string; params: Record<string, unknown> }> = []
    ;(admin as unknown as { ensureAgentPort: () => Promise<number> }).ensureAgentPort = async () => 19991
    ;(admin as unknown as {
      rpcClient: { callSensitive: (port: number, method: string, params: Record<string, unknown>, source: string) => Promise<unknown> }
    }).rpcClient.callSensitive = async (port, method, params) => {
      calls.push({ port, method, params })
      const mutation = { action: params.action, item: params.item }
      await (admin as unknown as {
        workboardAdminAssertions: {
          consume(assertion: string, expected: Record<string, unknown>): Promise<unknown>
        }
      }).workboardAdminAssertions.consume(params.assertion as string, {
        manager_key: params.manager_key,
        action: params.action,
        expected_revision: params.expected_revision,
        payload_sha256: sha256CanonicalJson(mutation),
      })
      return {
        manager_key: KEY,
        revision: 1,
        item: { ...ITEM, updated_at: '2026-09-05T00:00:00.000Z' },
        active_count: 1,
        archive_count: 0,
        manager_notification: 'pending',
      }
    }
    ;(admin as unknown as { resolveSystemTaskPermissions: () => never }).resolveSystemTaskPermissions = () => {
      throw new Error('任务板保存不得解析系统所有者权限')
    }

    const response = await fetch(`http://localhost:${WEB_PORT}${endpoint}`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ action: 'create', item: ITEM, expected_revision: 0 }),
    })
    const body = await response.json() as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ manager_key: KEY, revision: 1, manager_notification: 'pending' })
    expect(JSON.stringify(body)).not.toContain('assertion')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      port: 19991,
      method: 'change_workboard_admin',
      params: { manager_key: KEY, action: 'create', item: ITEM, expected_revision: 0, assertion: expect.any(String) },
    })
  })

  it('将 Agent 的 404、409 和不可用错误映射为稳定 HTTP 结果', async () => {
    ;(admin as unknown as { callAgentRpc: (method: string, params: Record<string, unknown>) => Promise<unknown> }).callAgentRpc = async () => {
      throw new Error(`Manager 不存在: ${KEY}`)
    }
    expect((await fetch(`http://localhost:${WEB_PORT}${endpoint}`, { headers: headers() })).status).toBe(404)

    ;(admin as unknown as { ensureAgentPort: () => Promise<number> }).ensureAgentPort = async () => 19991
    ;(admin as unknown as {
      rpcClient: { callSensitive: (port: number, method: string, params: Record<string, unknown>, source: string) => Promise<unknown> }
    }).rpcClient.callSensitive = async () => {
      const error = Object.assign(new Error('任务板 revision 冲突'), {
        code: 'WORKBOARD_REVISION_CONFLICT', details: { current_revision: 8 },
      })
      throw error
    }
    const conflict = await fetch(`http://localhost:${WEB_PORT}${endpoint}`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ action: 'create', item: ITEM, expected_revision: 0 }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'WORKBOARD_REVISION_CONFLICT', current_revision: 8 })

    ;(admin as unknown as {
      rpcClient: { callSensitive: (port: number, method: string, params: Record<string, unknown>, source: string) => Promise<unknown> }
    }).rpcClient.callSensitive = async () => {
      throw Object.assign(new Error('blocked 任务项必须至少包含一个 blocker'), { code: 'INVALID_PARAMS' })
    }
    const invalidAgentInput = await fetch(`http://localhost:${WEB_PORT}${endpoint}`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ action: 'create', item: ITEM, expected_revision: 0 }),
    })
    expect(invalidAgentInput.status).toBe(400)
    expect(await invalidAgentInput.json()).toMatchObject({ code: 'INVALID_PARAMS' })

    ;(admin as unknown as {
      rpcClient: { callSensitive: (port: number, method: string, params: Record<string, unknown>, source: string) => Promise<unknown> }
    }).rpcClient.callSensitive = async () => { throw new Error('Agent not available') }
    const unavailable = await fetch(`http://localhost:${WEB_PORT}${endpoint}`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ action: 'create', item: ITEM, expected_revision: 0 }),
    })
    expect(unavailable.status).toBe(503)

    const invalid = await fetch(`http://localhost:${WEB_PORT}${endpoint}`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ action: 'create', item: ITEM, expected_revision: -1 }),
    })
    expect(invalid.status).toBe(400)
  })
})
