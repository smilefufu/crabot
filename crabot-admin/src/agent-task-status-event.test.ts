/**
 * `agent.task_status_changed` 订阅（P7/J cutover，protocol-agent-v3 §9.2）。
 *
 * cutover 之后 task 的真相源是 agent 的台账，admin 不再是状态机的执行者。
 * v2 里 Master Chat 的状态卡是 `applyStatusTransition` 顺手推的；那条路没了之后，
 * **不订阅这个事件，卡片就永远停在创建时的那一帧**——不会转完成、不会转失败，
 * 而且一句报错都没有。这个文件钉的就是这条链路。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type { ChatTaskSnapshot } from './types.js'
import { newCredentialsFromPassword, writeCredentials } from './credentials.js'

const TEST_PROTOCOL_PORT = 19831
const TEST_WEB_PORT = 13031
const TEST_DATA_DIR = './test-data/agent-task-status-event-test'

const ADMIN_CHAT_WORKER = {
  worker_id: 'w-admin-1',
  task: { id: 'task-admin-1', title: '把 README 翻译成英文', status: 'running' },
  manager_key: 'admin-web::admin-chat',
  origin: { trigger_type: 'message' },
  report_to: { channel_id: 'admin-web', session_id: 'admin-chat' },
}

const WECHAT_WORKER = {
  worker_id: 'w-wechat-1',
  task: { id: 'task-wechat-1', title: '群里那个活', status: 'running' },
  manager_key: 'wechat::sess-1',
  origin: { trigger_type: 'message' },
  report_to: { channel_id: 'wechat', session_id: 'sess-1' },
}

interface Internals {
  onEvent(event: {
    id: string
    type: string
    source: string
    payload: unknown
    timestamp: string
  }): Promise<void>
  callAgentRpc: (method: string, params: unknown) => Promise<unknown>
  chatManager: { pushTaskUpdate(task: ChatTaskSnapshot): void } | null
}

describe('agent.task_status_changed 订阅（protocol-agent-v3 §9.2）', () => {
  let admin: AdminModule
  let internals: Internals
  let realChatManager: Internals['chatManager']

  let rpcCalls: Array<{ method: string; params: unknown }>
  let pushed: ChatTaskSnapshot[]
  /** 让 `get_worker_detail` 回哪个台账条目；'throw' = agent 不可达 */
  let workerDetail: unknown | 'throw'

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    process.env.TEST_JWT_SECRET_EVT = 'test_jwt_secret_at_least_32_chars'
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
    await writeCredentials(
      TEST_DATA_DIR,
      await newCredentialsFromPassword('test_password_123', { is_temp: false, changed_via: 'start' })
    )

    admin = new AdminModule(
      {
        moduleId: 'admin-evt-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        jwt_secret_env: 'TEST_JWT_SECRET_EVT',
        token_ttl: 3600,
      }
    )
    await admin.start()
    internals = admin as unknown as Internals
    realChatManager = internals.chatManager
  })

  afterAll(async () => {
    // 各用例把 chatManager 换成了桩；停机前换回真件，否则 stop() 里的 close() 打不到。
    internals.chatManager = realChatManager
    await admin.stop()
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function boot(): void {
    rpcCalls = []
    pushed = []
    workerDetail = ADMIN_CHAT_WORKER

    internals.callAgentRpc = async (method, params) => {
      rpcCalls.push({ method, params })
      if (method === 'get_worker_detail') {
        if (workerDetail === 'throw') throw new Error('Agent not available')
        return { worker: workerDetail }
      }
      return {}
    }
    internals.chatManager = {
      pushTaskUpdate: (task: ChatTaskSnapshot) => {
        pushed.push(task)
      },
    }
  }

  function statusEvent(p: {
    workerId: string
    taskId: string
    from: string
    to: string
  }) {
    return {
      id: 'evt-1',
      type: 'agent.task_status_changed',
      source: 'agent',
      payload: {
        worker_id: p.workerId,
        task_id: p.taskId,
        old_status: p.from,
        new_status: p.to,
        manager_key: 'admin-web::admin-chat',
      },
      timestamp: '2026-08-01T00:00:00.000Z',
    }
  }

  it('admin-web 来源的任务：状态卡随 agent 事件推给 Master Chat', async () => {
    boot()

    await internals.onEvent(
      statusEvent({ workerId: 'w-admin-1', taskId: 'task-admin-1', from: 'running', to: 'completed' })
    )

    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toEqual({
      task_id: 'task-admin-1',
      // 状态直接透传 v3 的精简状态机，不再由 admin 自己算
      status: 'completed',
      title: '把 README 翻译成英文',
    })
    // title 与归属都来自 §8.3 的只读端点（事件载荷里没有这两样）
    expect(rpcCalls).toEqual([{ method: 'get_worker_detail', params: { worker_id: 'w-admin-1' } }])
  })

  it('中间态同样推：卡片不会卡在创建时的那一帧', async () => {
    boot()

    await internals.onEvent(
      statusEvent({ workerId: 'w-admin-1', taskId: 'task-admin-1', from: 'queued', to: 'running' })
    )
    workerDetail = { ...ADMIN_CHAT_WORKER, task: { ...ADMIN_CHAT_WORKER.task, status: 'halted' } }
    await internals.onEvent(
      statusEvent({ workerId: 'w-admin-1', taskId: 'task-admin-1', from: 'running', to: 'halted' })
    )

    expect(pushed.map((p) => p.status)).toEqual(['running', 'halted'])
  })

  it('别的渠道的任务不往 Master Chat 推（判据是结果回报目标）', async () => {
    boot()
    workerDetail = WECHAT_WORKER

    await internals.onEvent(
      statusEvent({ workerId: 'w-wechat-1', taskId: 'task-wechat-1', from: 'running', to: 'completed' })
    )

    expect(pushed).toHaveLength(0)
  })

  it('回查失败只 warn，不把异常抛回事件总线', async () => {
    boot()
    workerDetail = 'throw'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      internals.onEvent(
        statusEvent({ workerId: 'w-gone', taskId: 'task-gone', from: 'running', to: 'failed' })
      )
    ).resolves.toBeUndefined()

    expect(pushed).toHaveLength(0)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('get_worker_detail'))).toBe(true)
  })

  it('订阅列表里声明了这个事件（不声明的话 broker 根本不会投递）', async () => {
    // onEvent 里有 case 还不够：ModuleConfig.subscriptions 没声明，broker 就不会把
    // 这个事件发过来（crabot-core 按订阅列表扇出）。
    const src = await fs.readFile(new URL('./main.ts', import.meta.url), 'utf-8')
    expect(src).toContain("'agent.task_status_changed'")
  })
})
