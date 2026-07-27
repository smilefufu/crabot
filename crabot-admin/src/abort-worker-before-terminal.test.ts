/**
 * 不变量：**task 非终态 ⟺ worker 活着**（决策 2026-07-27）。
 *
 * admin 是 task 状态的 SSOT，但 worker loop 活在 agent 进程里——改 tasks.json 不会让
 * 挂起的 loop 消失。历史 bug（issue #43 现象二）：waiting_human 超时判死后 worker 仍
 * parked 在 24h barrier 上，醒来继续发消息、再撞状态机拒绝。
 *
 * 这里锁三条 admin 主动判死路径都先叫停 worker，且 abort 失败不阻断判死。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from './index.js'

const TEST_PROTOCOL_PORT = 19824
const TEST_WEB_PORT = 13024
const TEST_DATA_DIR = './test-data/admin-abort-worker-test'

type AgentCall = { method: string; params: unknown }

describe('admin 判死前 abort worker', () => {
  let admin: AdminModule
  let agentCalls: AgentCall[]
  let abortShouldFail: boolean

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})

    admin = new AdminModule(
      {
        moduleId: 'admin-abort-worker-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD_ABORT_WORKER',
        jwt_secret_env: 'TEST_JWT_SECRET_ABORT_WORKER',
        token_ttl: 3600,
      }
    )

    process.env.TEST_ADMIN_PASSWORD_ABORT_WORKER = 'test_password_123'
    process.env.TEST_JWT_SECRET_ABORT_WORKER = 'test_jwt_secret_at_least_32_chars'

    await admin.start()
  })

  afterAll(async () => {
    await admin.stop()
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  beforeEach(() => {
    agentCalls = []
    abortShouldFail = false
    // 拦截所有 agent RPC：记录调用，abort_worker 按开关决定成败，其余静默成功
    ;(admin as any).callAgentRpc = async (method: string, params: unknown) => {
      agentCalls.push({ method, params })
      if (method === 'abort_worker') {
        if (abortShouldFail) throw new Error('agent unreachable')
        return { aborted: true }
      }
      return {}
    }
  })

  async function createTask(): Promise<{ id: string }> {
    const { task } = await (admin as any).handleCreateTask({
      title: 't', priority: 'normal',
      source: { trigger_type: 'manual', origin: 'human' },
    })
    return task
  }

  function abortCalls(): AgentCall[] {
    return agentCalls.filter((c) => c.method === 'abort_worker')
  }

  it('cancel 前叫停 worker', async () => {
    const task = await createTask()

    await (admin as any).handleCancelTask({ task_id: task.id, reason: 'user-canceled' })

    expect(abortCalls()).toHaveLength(1)
    expect(abortCalls()[0].params).toMatchObject({ task_id: task.id, reason: 'user-canceled' })
    expect((admin as any).tasks.get(task.id).status).toBe('cancelled')
  })

  it('cancel 一个 waiting 任务：worker 也活着（park 在 waitForPush），abort 后正常切 cancelled', async () => {
    const task = await createTask()
    const stored = (admin as any).tasks.get(task.id)
    stored.status = 'waiting'
    stored.started_at = new Date().toISOString()
    stored.waiting_at = new Date().toISOString()

    await (admin as any).handleCancelTask({ task_id: task.id, reason: 'user-canceled' })

    expect(abortCalls()).toHaveLength(1)
    expect((admin as any).tasks.get(task.id).status).toBe('cancelled')
  })

  it('waiting_human 超时判死前叫停 worker', async () => {
    const task = await createTask()
    const stored = (admin as any).tasks.get(task.id)
    stored.status = 'waiting_human'
    stored.started_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
    stored.waiting_human_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString()

    await admin.runWaitingHumanTimeoutScan()

    expect(abortCalls()).toHaveLength(1)
    expect(abortCalls()[0].params).toMatchObject({ task_id: task.id })
    expect((admin as any).tasks.get(task.id).status).toBe('failed')
  })

  it('abort RPC 失败仍然落 failed（不因 agent 不可达把任务永久卡住）', async () => {
    const task = await createTask()
    const stored = (admin as any).tasks.get(task.id)
    stored.status = 'waiting_human'
    stored.started_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
    stored.waiting_human_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
    abortShouldFail = true

    await admin.runWaitingHumanTimeoutScan()

    expect(abortCalls()).toHaveLength(1)
    expect((admin as any).tasks.get(task.id).status).toBe('failed')
  })

  it('worker 自己上报终态时不叫停（那是正常收尾，abort 会打断）', async () => {
    const task = await createTask()
    const stored = (admin as any).tasks.get(task.id)
    stored.status = 'executing'
    stored.started_at = new Date().toISOString()

    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'completed' })

    expect(abortCalls()).toHaveLength(0)
    expect((admin as any).tasks.get(task.id).status).toBe('completed')
  })
})
