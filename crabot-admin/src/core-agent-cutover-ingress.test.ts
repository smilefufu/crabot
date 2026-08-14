import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import AdminModule from './index.js'
import { newCredentialsFromPassword, writeCredentials } from './credentials.js'

let nextPort = 13500
const instances: AdminModule[] = []
const dataDirs: string[] = []

async function makeAdmin(): Promise<{ admin: AdminModule; port: number; dataDir: string; token: string }> {
  const port = nextPort++
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-admin-cutover-ingress-'))
  dataDirs.push(dataDir)
  const credentials = await newCredentialsFromPassword('test_password_123', { is_temp: false, changed_via: 'start' })
  await writeCredentials(dataDir, credentials)
  const previousMode = process.env.CRABOT_ADMIN_STARTUP_MODE
  const previousBearer = process.env.CRABOT_ADMIN_CUTOVER_BEARER
  process.env.CRABOT_ADMIN_STARTUP_MODE = 'core-agent-cutover'
  process.env.CRABOT_ADMIN_CUTOVER_BEARER = 'test-cutover-bearer'
  const admin = new AdminModule(
    { moduleId: 'admin-web', moduleType: 'admin', version: '0.1.0', protocolVersion: '0.1.0', port: port + 1000, subscriptions: [] },
    { web_port: port, data_dir: dataDir, password_env: 'TEST_ADMIN_CUTOVER_PASSWORD', jwt_secret_env: 'TEST_JWT_SECRET_CUTOVER', token_ttl: 3600 },
  )
  try {
    await admin.start()
  } finally {
    if (previousMode === undefined) delete process.env.CRABOT_ADMIN_STARTUP_MODE
    else process.env.CRABOT_ADMIN_STARTUP_MODE = previousMode
    if (previousBearer === undefined) delete process.env.CRABOT_ADMIN_CUTOVER_BEARER
    else process.env.CRABOT_ADMIN_CUTOVER_BEARER = previousBearer
  }
  instances.push(admin)
  const token = await login(port)
  return { admin, port, dataDir, token }
}

async function login(port: number): Promise<string> {
  const response = await fetch(`http://localhost:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test_password_123' }),
  })
  expect(response.status).toBe(200)
  return (await response.json() as { token: string }).token
}

async function websocketStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0) })
    socket.once('open', () => { socket.close(); resolve(101) })
    socket.once('error', error => {
      if (socket.readyState === WebSocket.CLOSED) return
      reject(error)
    })
  })
}

async function rawWebSocketOpen(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('open', () => { socket.close(); resolve() })
    socket.once('unexpected-response', (_request, response) => { response.resume(); reject(new Error(`unexpected ${response.statusCode}`)) })
    socket.once('error', reject)
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (instances.length) await instances.pop()!.stop().catch(() => {})
  while (dataDirs.length) await fs.rm(dataDirs.pop()!, { recursive: true, force: true })
})

describe('management-only Admin ingress gate', () => {
  it('rejects authenticated multipart chat with zero ChatManager or Agent side effects', async () => {
    const { admin, port, token } = await makeAdmin()
    const chat = (admin as unknown as { chatManager: { handleInboundMessage: (...args: unknown[]) => Promise<unknown>; getMessages(limit: number): unknown[] } }).chatManager
    const inbound = vi.spyOn(chat, 'handleInboundMessage')
    const agent = vi.spyOn((admin as unknown as { rpcClient: { call: (...args: unknown[]) => Promise<unknown> } }).rpcClient, 'call')
    const body = new FormData()
    body.set('request_id', 'blocked-multipart')
    body.set('text', 'must not reach chat manager')
    const response = await fetch(`http://localhost:${port}/api/chat/messages`, { method: 'POST', body, headers: { Authorization: `Bearer ${token}` } })
    expect(response.status).toBe(503)
    expect(inbound).not.toHaveBeenCalled()
    expect(agent).not.toHaveBeenCalled()
    expect(chat.getMessages(100)).toEqual([])
  })

  it('rejects authenticated /ws/chat before activation and accepts it after activation', async () => {
    const { admin, port, token } = await makeAdmin()
    expect(await websocketStatus(`ws://localhost:${port}/ws/chat?token=${encodeURIComponent(token)}`)).toBe(503)
    ;(admin as unknown as { cutoverActivated: boolean }).cutoverActivated = true
    await rawWebSocketOpen(`ws://localhost:${port}/ws/chat?token=${encodeURIComponent(token)}`)
  })

  it('requires an exact registered core Agent plus healthy configured status before readiness can open ingress', async () => {
    const { admin } = await makeAdmin()
    const rpc = (admin as unknown as { rpcClient: { resolve: (...args: unknown[]) => Promise<unknown>; call: (...args: unknown[]) => Promise<unknown> } }).rpcClient
    ;(admin as unknown as { agentPort: number }).agentPort = 0
    const resolve = vi.spyOn(rpc, 'resolve').mockResolvedValue([{ module_id: 'crabot-agent', port: 19999, status: 'running' }])
    const health = vi.spyOn(rpc, 'call').mockResolvedValue({ status: 'healthy', details: { llm_status: 'not_configured' } })
    await expect((admin as unknown as { waitForCoreAgentReady(input: { attempts: number; delayMs: number }): Promise<void> }).waitForCoreAgentReady({ attempts: 1, delayMs: 0 })).rejects.toThrow(/timed out/)
    expect((admin as unknown as { cutoverActivated: boolean }).cutoverActivated).toBe(false)
    expect(resolve).toHaveBeenCalledWith({ module_id: 'crabot-agent' }, 'admin-web')
    health.mockResolvedValueOnce({ status: 'healthy', details: { llm_status: 'ready' } })
    await expect((admin as unknown as { waitForCoreAgentReady(input: { attempts: number; delayMs: number }): Promise<void> }).waitForCoreAgentReady({ attempts: 1, delayMs: 0 })).resolves.toBeUndefined()
    expect(health).toHaveBeenLastCalledWith(19999, 'health', {}, 'admin-web')
  })

  it('rejects worker-dependent graph rebuild and Agent proxy reads before activation', async () => {
    const { admin, port, token } = await makeAdmin()
    const rpc = vi.spyOn((admin as unknown as { rpcClient: { call: (...args: unknown[]) => Promise<unknown> } }).rpcClient, 'call')
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    // P6-A：退役的 trace-tree/conversation-units 换成仍存活的 gated managers 路由。
    const [rebuild, workers, managers, managerEpisodes, entities, entityLog, killEntity, diskUsage, cleanup] = await Promise.all([
      fetch(`http://localhost:${port}/api/memory/v2/graph/rebuild`, { method: 'POST', headers, body: '{}' }),
      fetch(`http://localhost:${port}/api/agent/workers`, { headers }),
      fetch(`http://localhost:${port}/api/agent/managers`, { headers }),
      fetch(`http://localhost:${port}/api/agent/managers/wechat%253A%253Asess-1/episodes`, { headers }),
      fetch(`http://localhost:${port}/api/bg-entities`, { headers }),
      fetch(`http://localhost:${port}/api/bg-entities/entity/log`, { headers }),
      fetch(`http://localhost:${port}/api/bg-entities/entity`, { method: 'DELETE', headers }),
      fetch(`http://localhost:${port}/api/agent/traces/disk-usage`, { headers }),
      fetch(`http://localhost:${port}/api/agent/traces/old?days=30`, { method: 'DELETE', headers }),
    ])
    expect([rebuild, workers, managers, managerEpisodes, entities, entityLog, killEntity, diskUsage, cleanup].map((response) => response.status))
      .toEqual([503, 503, 503, 503, 503, 503, 503, 503, 503])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('does not run due schedules before activation and runs the same callback after activation', async () => {
    const { admin } = await makeAdmin()
    const schedule = {
      id: 'due-schedule', name: 'due schedule', enabled: true,
      trigger: { type: 'interval' as const, seconds: 60 },
      task_template: { title: 'due', description: '' },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }
    const trigger = vi.spyOn(admin as unknown as { handleScheduleTrigger: (schedule: unknown) => Promise<unknown> }, 'handleScheduleTrigger')
    const engine = (admin as unknown as { scheduleEngine: { triggerNow(id: string, schedule: unknown): void } }).scheduleEngine
    const rpc = vi.spyOn((admin as unknown as { rpcClient: { call: (...args: unknown[]) => Promise<unknown> } }).rpcClient, 'call').mockResolvedValue({ accepted: true })
    ;(admin as unknown as { agentPort: number }).agentPort = 19999
    engine.triggerNow(schedule.id, schedule)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(rpc).not.toHaveBeenCalled()
    ;(admin as unknown as { cutoverActivated: boolean }).cutoverActivated = true
    trigger.mockClear()
    engine.triggerNow(schedule.id, schedule)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith(19999, 'trigger_schedule', expect.any(Object), 'admin-web')
  })
})
