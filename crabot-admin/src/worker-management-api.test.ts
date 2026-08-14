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
  const put = (body: unknown) => fetch(`http://localhost:${TEST_WEB_PORT}/api/agent/worker-implementations`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

  it('GET 返回 revision 1 安全初始配置（新部署原子落盘）', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const config = await res.json() as { revision: number; default_impl: string; implementations: Record<string, { enabled: boolean }> }
    expect(config.revision).toBe(1)
    expect(config.default_impl).toBe('builtin')
    expect(config.implementations.builtin.enabled).toBe(true)
    expect(config.implementations['claude-code'].enabled).toBe(false)
  })

  it('PUT CAS：expected_revision 不符 → 409；缺 expected_revision → 400', async () => {
    const conflict = await put({ expected_revision: 99, implementations: {
      builtin: { enabled: true }, 'claude-code': { enabled: false }, codex: { enabled: false },
    } })
    expect(conflict.status).toBe(409)
    const bad = await put({ implementations: {} })
    expect(bad.status).toBe(400)
  })

  it('PUT 成功：enable claude-code existing_host，revision +1', async () => {
    const res = await put({ expected_revision: 1, implementations: {
      builtin: { enabled: true },
      'claude-code': { enabled: true, connection: { mode: 'existing_host' } },
      codex: { enabled: false },
    } })
    if (res.status !== 200) console.log('PUT error body:', await res.clone().text())
    expect(res.status).toBe(200)
    const config = await res.json() as { revision: number; implementations: Record<string, { enabled: boolean; connection?: { mode: string } }> }
    expect(config.revision).toBe(2)
    expect(config.implementations['claude-code'].connection?.mode).toBe('existing_host')
    // 持久化幸存
    const fresh = await get()
    expect((await fresh.json() as { revision: number }).revision).toBe(2)
  })

  it('PUT 拒绝：default_impl 改走（P6-C 前过渡 gate）', async () => {
    const res = await put({ expected_revision: 2, default_impl: 'claude-code', implementations: {
      builtin: { enabled: true },
      'claude-code': { enabled: true, connection: { mode: 'existing_host' } },
      codex: { enabled: false },
    } })
    expect(res.status).toBe(400)
  })

  it('PUT 拒绝：builtin 带 connection / credential 字段混入', async () => {
    const res = await put({ expected_revision: 2, implementations: {
      builtin: { enabled: true, connection: { mode: 'native_account' } },
      'claude-code': { enabled: false },
      codex: { enabled: false },
    } })
    expect(res.status).toBe(400)
  })
})
