import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { AdminModule } from './index.js'
import { newCredentialsFromPassword, writeCredentials } from './credentials.js'

const TEST_DATA_DIR = path.join(process.cwd(), 'test-data', 'worker-management-api')
const TEST_PROTOCOL_PORT = 19817
const TEST_WEB_PORT = 13017

describe('Worker implementation management API（P6-B §5）', () => {
  let admin: AdminModule
  let token: string
  let fakeMM: http.Server

  beforeAll(async () => {
    // config mutation 的 invalidation 发布走 MM publish_event；vitest.setup 把 CRABOT_MM_PORT
    // 指到 59321，这里起一个只回成功的 stub（否则 publish 失败 → outbox 残留 → 后续写 409）。
    fakeMM = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'stub', success: true, data: { subscriber_count: 0 }, timestamp: new Date().toISOString() }))
    })
    await new Promise<void>((resolve) => fakeMM.listen(59321, '127.0.0.1', resolve))
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    process.env.TEST_JWT_SECRET_WAPI = 'test_jwt_secret_at_least_32_chars'
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
    await writeCredentials(TEST_DATA_DIR, await newCredentialsFromPassword('test_password_123', { is_temp: false, changed_via: 'start' }))
    admin = new AdminModule(
      { moduleId: 'admin-web-test', moduleType: 'admin', version: '0.1.0', protocolVersion: '0.1.0', port: TEST_PROTOCOL_PORT, subscriptions: [] },
      { web_port: TEST_WEB_PORT, data_dir: TEST_DATA_DIR, password_env: 'TEST_ADMIN_WEB_PASSWORD', jwt_secret_env: 'TEST_JWT_SECRET_WAPI', token_ttl: 3600 },
    )
    await admin.start()
    const login = await fetch(`http://localhost:${TEST_WEB_PORT}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test_password_123' }),
    })
    token = (await login.json() as { token: string }).token
  })

  afterAll(async () => {
    await admin.stop()
    await new Promise<void>((resolve) => fakeMM.close(() => resolve()))
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  const get = () => fetch(`http://localhost:${TEST_WEB_PORT}/api/agent/worker-implementations`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const put = (body: { expected_revision: number; config: { default_impl?: string; implementations: unknown } }) =>
    fetch(`http://localhost:${TEST_WEB_PORT}/api/agent/worker-implementations`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  const startOperation = (impl: string, action: 'install' | 'verify', body: Record<string, unknown>) =>
    fetch(`http://localhost:${TEST_WEB_PORT}/api/agent/worker-implementations/${impl}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })

  it('GET 返回协议合并 shape（config + agent_status + statuses），revision 1 安全初始配置', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const result = await res.json() as { config: { revision: number; default_impl: string; implementations: Record<string, { enabled: boolean }> }; agent_status: string; statuses: unknown[] }
    expect(result.agent_status).toBe('unavailable') // 测试环境无 Agent
    expect(result.unavailable_reason).toBeTruthy()
    const config = result.config
    expect(config.revision).toBe(1)
    expect(config.default_impl).toBe('builtin')
    expect(config.implementations.builtin.enabled).toBe(true)
    expect(config.implementations['claude-code'].enabled).toBe(false)
  })

  it('PUT CAS：expected_revision 不符 → 409；缺 expected_revision → 400', async () => {
    const conflict = await put({ expected_revision: 99, config: { implementations: {
      builtin: { enabled: true }, 'claude-code': { enabled: false }, codex: { enabled: false },
    } } })
    expect(conflict.status).toBe(409)
    const bad = await put({ config: { implementations: {} } } as never)
    expect(bad.status).toBe(400)
  })

  it('PUT 启用 CLI 时 Agent 不可用 → 503（协议 §3.19.12 门禁）', async () => {
    const res = await put({ expected_revision: 2, config: { implementations: {
      builtin: { enabled: true },
      'claude-code': { enabled: false },
      codex: { enabled: true, connection: { mode: 'existing_host' } },
    } } })
    expect(res.status).toBe(503)
    expect((await res.json() as { code?: string }).code).toBe('ADMIN_CORE_AGENT_UNAVAILABLE')
  })

  it('PUT 成功：enable claude-code existing_host，revision +1', async () => {
    // §3.19.12 启用门禁要求 Agent status 可用来校验 translator 兼容——stub 一个
    // 「已装 2.1.232 + existing_host capability」的 Agent 状态响应。
    ;(admin as unknown as { callAgentRpc: unknown }).callAgentRpc = async (method: string) => {
      if (method === 'list_worker_implementation_status') {
        return { items: [{
          impl: 'claude-code', installed: true, version: '2.1.232',
          connection_capabilities: [{ mode: 'existing_host', translator_id: 'claude-code-existing-host-v1', translator_version: '1', cli_version_range: '2.x', credential_transport: 'native_store', model_selection: 'native_default', credential_scope: 'runtime_user_home' }],
        }] }
      }
      throw new Error(`unexpected agent RPC in test: ${method}`)
    }
    const res = await put({ expected_revision: 1, config: { implementations: {
      builtin: { enabled: true },
      'claude-code': { enabled: true, connection: { mode: 'existing_host' } },
      codex: { enabled: false },
    } } })
    if (res.status !== 200) console.log('PUT error body:', await res.clone().text())
    expect(res.status).toBe(200)
    const body = await res.json() as { config: { revision: number; implementations: Record<string, { enabled: boolean; connection?: { mode: string } }> } }
    expect(body.config.revision).toBe(2)
    expect(body.config.implementations['claude-code'].connection?.mode).toBe('existing_host')
    // 持久化幸存
    const fresh = await get()
    expect(((await fresh.json()) as { config: { revision: number } }).config.revision).toBe(2)
  })

  it('PUT default 改走 claude-code 成功（P6-C，C-17 回归）；Agent 校验 translator', async () => {
    ;(admin as unknown as { callAgentRpc: unknown }).callAgentRpc = async (method: string) => {
      if (method === 'list_worker_implementation_status') {
        return { items: [{
          impl: 'claude-code', installed: true, version: '2.1.232', ready: true,
          connection_capabilities: [{ mode: 'existing_host', translator_id: 'claude-code-existing-host-v1', translator_version: '1', cli_version_range: '2.x', credential_transport: 'native_store', model_selection: 'native_default', credential_scope: 'runtime_user_home' }],
        }] }
      }
      throw new Error(`unexpected agent RPC in test: ${method}`)
    }
    const res = await put({ expected_revision: 2, config: { default_impl: 'claude-code', implementations: {
      builtin: { enabled: true },
      'claude-code': { enabled: true, connection: { mode: 'existing_host' } },
      codex: { enabled: false },
    } } })
    expect(res.status).toBe(200)
    const body = await res.json() as { config: { default_impl: string; revision: number } }
    expect(body.config.default_impl).toBe('claude-code')
    expect(body.config.revision).toBe(3)
  })

  it('PUT 拒绝：builtin 带 connection / credential 字段混入', async () => {
    const res = await put({ expected_revision: 3, config: { implementations: {
      builtin: { enabled: true, connection: { mode: 'native_account' } },
      'claude-code': { enabled: false },
      codex: { enabled: false },
    } } })
    expect(res.status).toBe(400)
  })

  it('disabled 且未配置的 CLI 也可安装，拒绝浏览器额外字段', async () => {
    const current = await get()
    const revision = ((await current.json()) as { config: { revision: number } }).config.revision
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(admin as unknown as { ensureAgentPort: () => Promise<number> }).ensureAgentPort = async () => 19999
    ;(admin as unknown as { rpcClient: { callSensitive: (port: number, method: string, params: Record<string, unknown>) => Promise<unknown> } }).rpcClient.callSensitive = async (_port, method, params) => {
      calls.push({ method, params })
      const expected = params.expected as { action: 'install'; operation_id: string; impl: 'codex'; mode: 'install'; policy_revision: number }
      await (admin as unknown as { workerOperationAssertions: { consume: (assertion: string, claims: typeof expected) => Promise<unknown> } })
        .workerOperationAssertions.consume(params.assertion as string, expected)
      return { operation_id: params.operation_id, state: 'completed', version: '0.1.2' }
    }

    const invalid = await startOperation('codex', 'install', {
      expected_revision: revision,
      package: 'attacker-controlled-package',
      args: ['--unsafe'],
    })
    expect(invalid.status).toBe(400)
    expect(calls).toHaveLength(0)

    const res = await startOperation('codex', 'install', { expected_revision: revision })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ operation: expect.objectContaining({ state: 'completed', version: '0.1.2' }) })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'install_worker_implementation',
      params: {
        impl: 'codex',
        expected: { action: 'install', impl: 'codex', mode: 'install', policy_revision: revision },
      },
    })
  })
})
