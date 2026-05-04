import { describe, it, expect, vi } from 'vitest'
import { DecisionDispatcher } from '../../src/orchestration/decision-dispatcher.js'

/**
 * Bug fix: channel send_message 网络抖动不应阻塞 create_task / supplement_task
 *
 * 历史现象：FrontHandler 决定 create_task → DecisionDispatcher.handleCreateTask 第一步
 * 发即时回复（ack）走 RPC 到 channel，channel 转发给 Telegram API 时 fetch failed →
 * 整个 handleCreateTask 抛错 → Admin 没创建 task、Worker 没启动、用户的请求被丢弃。
 *
 * 修复：ack 是次要动作，task 创建/投递才是核心。ack 失败必须只 log，不阻塞主流程。
 */

const ADMIN_PORT = 19001
const CHANNEL_PORT = 19010

interface MakeOpts {
  /** 让 send_message 这一步抛错（模拟 channel 不可达） */
  failOnSendMessage?: boolean
}

function makeDispatcher(opts: MakeOpts = {}) {
  const memoryWriter = {
    reportTaskFeedback: vi.fn(async () => undefined),
    listRecentLessons: vi.fn(async () => []),
    markValidationOutcome: vi.fn(async () => undefined),
    writeTaskCreated: vi.fn(async () => undefined),
    writeTaskFinished: vi.fn(async () => undefined),
    writeTriageDecision: vi.fn(async () => undefined),
    quickCapture: vi.fn(async () => undefined),
  } as any

  const rpcCalls: Array<{ port: number; method: string; params: any }> = []
  const rpcClient = {
    call: vi.fn(async (port: number, method: string, params: any) => {
      rpcCalls.push({ port, method, params })
      if (method === 'send_message' && opts.failOnSendMessage) {
        throw new Error('fetch failed')
      }
      if (method === 'create_task') {
        return { task: { id: 't_new_001', title: params.title, description: params.description, priority: 'medium' } }
      }
      return {}
    }),
  } as any

  const contextAssembler = {
    assembleWorkerContext: vi.fn(async () => ({})),
  } as any

  const executeTaskFn = vi.fn(async (params: any) => ({
    task_id: params?.task?.task_id ?? 't_new_001',
    outcome: 'completed' as const,
    summary: 'done',
    final_reply: { type: 'text' as const, text: '' },
  }))

  const dispatcher = new DecisionDispatcher(
    rpcClient,
    'agent-test',
    contextAssembler,
    memoryWriter,
    async () => ADMIN_PORT,
    async (_channelId: string) => CHANNEL_PORT,
    executeTaskFn,
  )

  // setWorkerHandler 是 handleCreateTask / handleSupplementTask 必备的 guard。
  // 给一个最小 stub，包含 hasActiveTask + deliverHumanResponse（supplement_task 用）。
  dispatcher.setWorkerHandler({
    executeTask: vi.fn(),
    hasActiveTask: vi.fn(() => true),
    deliverHumanResponse: vi.fn(),
  } as any)

  return { dispatcher, rpcClient, rpcCalls, memoryWriter, executeTaskFn }
}

describe('DecisionDispatcher.handleCreateTask resilience', () => {
  it('creates task and dispatches worker even when ack send_message RPC fails', async () => {
    const { dispatcher, rpcCalls, executeTaskFn } = makeDispatcher({ failOnSendMessage: true })

    const result = await dispatcher.dispatch(
      {
        type: 'create_task',
        task_title: '整理 video-app 重库指南',
        task_description: '收到，我来整理',
        immediate_reply: { type: 'text', text: '收到，我来整理一份新服务器重库的可执行指南。' },
      },
      {
        channel_id: 'telegram-001',
        session_id: 'sess-x',
        messages: [{
          platform_message_id: 'm1',
          session: { channel_id: 'telegram-001', session_id: 'sess-x', type: 'group' as const },
          sender: { friend_id: 'f_wu', platform_user_id: 'u1', platform_display_name: 'Mr.Wu' },
          content: { type: 'text' as const, text: '整理一份指南' },
          features: { is_mention_crab: true },
          platform_timestamp: new Date().toISOString(),
        }],
        senderFriend: { id: 'f_wu', display_name: 'Mr.Wu' } as any,
        memoryPermissions: { write_visibility: 'internal', write_scopes: [] } as any,
      },
    )

    // task 必须被创建（这是核心动作）
    expect(result).toEqual({ task_id: 't_new_001' })

    // RPC 路径上必须出现 create_task（第二步），即使第一步 send_message 失败也得继续
    const methodOrder = rpcCalls.map(c => c.method)
    expect(methodOrder).toContain('send_message')   // ack 尝试发了
    expect(methodOrder).toContain('create_task')    // task 被创建
    // 顺序必须是先 ack 再 create_task（即 ack 失败不能短路 create_task）
    expect(methodOrder.indexOf('send_message')).toBeLessThan(methodOrder.indexOf('create_task'))

    // Worker 仍然被调度执行（fire-and-forget，flush 一下微任务）
    await new Promise(r => setTimeout(r, 30))
    expect(executeTaskFn).toHaveBeenCalledTimes(1)
  })

  it('still creates task when ack succeeds (regression: happy path unchanged)', async () => {
    const { dispatcher, executeTaskFn } = makeDispatcher({ failOnSendMessage: false })

    const result = await dispatcher.dispatch(
      {
        type: 'create_task',
        task_title: 't',
        task_description: 'd',
        immediate_reply: { type: 'text', text: '收到' },
      },
      {
        channel_id: 'telegram-001',
        session_id: 'sess-x',
        messages: [{
          platform_message_id: 'm1',
          session: { channel_id: 'telegram-001', session_id: 'sess-x', type: 'group' as const },
          sender: { friend_id: 'f_wu', platform_user_id: 'u1', platform_display_name: 'Mr.Wu' },
          content: { type: 'text' as const, text: 'go' },
          features: { is_mention_crab: true },
          platform_timestamp: new Date().toISOString(),
        }],
        senderFriend: { id: 'f_wu', display_name: 'Mr.Wu' } as any,
        memoryPermissions: { write_visibility: 'internal', write_scopes: [] } as any,
      },
    )

    expect(result).toEqual({ task_id: 't_new_001' })
    await new Promise(r => setTimeout(r, 30))
    expect(executeTaskFn).toHaveBeenCalledTimes(1)
  })
})

describe('DecisionDispatcher.handleSupplementTask resilience', () => {
  it('delivers supplement to worker even when ack send_message RPC fails', async () => {
    const { dispatcher, rpcCalls } = makeDispatcher({ failOnSendMessage: true })

    const deliverSpy = vi.fn()
    dispatcher.setWorkerHandler({
      executeTask: vi.fn(),
      hasActiveTask: vi.fn(() => true),
      deliverHumanResponse: deliverSpy,
    } as any)

    const result = await dispatcher.dispatch(
      {
        type: 'supplement_task',
        task_id: 't_active',
        supplement_content: '应该是明天，不是今天',
        immediate_reply: { type: 'text', text: '好的，已记录' },
      },
      {
        channel_id: 'telegram-001',
        session_id: 'sess-x',
        messages: [],
        senderFriend: { id: 'f_wu', display_name: 'Mr.Wu' } as any,
        memoryPermissions: {} as any,
      },
    )

    expect(result).toEqual({ task_id: 't_active' })
    // ack 尝试过
    expect(rpcCalls.some(c => c.method === 'send_message')).toBe(true)
    // supplement 仍被投递
    expect(deliverSpy).toHaveBeenCalledTimes(1)
  })
})

describe('DecisionDispatcher.handleSupplementTask scheduled-task fallback', () => {
  it('downgrades supplement to create_task when target is scheduled (admin chat / group route)', async () => {
    // 历史 bug：Front 误把用户新需求 supplement 到正在跑的定时巡检任务上，
    // 巡检 worker 被纠偏后偏离本职，新需求也没有独立 task。
    // 兜底：dispatcher 看到目标 task trigger_type='scheduled' → 转 create_task。
    const memoryWriter = {
      reportTaskFeedback: vi.fn(async () => undefined),
      listRecentLessons: vi.fn(async () => []),
      markValidationOutcome: vi.fn(async () => undefined),
      writeTaskCreated: vi.fn(async () => undefined),
      writeTaskFinished: vi.fn(async () => undefined),
      writeTriageDecision: vi.fn(async () => undefined),
      quickCapture: vi.fn(async () => undefined),
    } as any

    const rpcCalls: Array<{ port: number; method: string; params: any }> = []
    const rpcClient = {
      call: vi.fn(async (port: number, method: string, params: any) => {
        rpcCalls.push({ port, method, params })
        if (method === 'get_task') {
          return { task: { id: params.task_id, source: { trigger_type: 'scheduled' } } }
        }
        if (method === 'create_task') {
          return { task: { id: 't_new_via_fallback', title: params.title, description: params.description, priority: 'medium' } }
        }
        return {}
      }),
    } as any

    const contextAssembler = { assembleWorkerContext: vi.fn(async () => ({})) } as any
    const executeTaskFn = vi.fn(async (params: any) => ({
      task_id: params?.task?.task_id ?? 't_new_via_fallback',
      outcome: 'completed' as const,
      summary: 'done',
      final_reply: { type: 'text' as const, text: '' },
    }))

    const dispatcher = new DecisionDispatcher(
      rpcClient, 'agent-test', contextAssembler, memoryWriter,
      async () => ADMIN_PORT,
      async () => CHANNEL_PORT,
      executeTaskFn,
    )

    const deliverSpy = vi.fn()
    dispatcher.setWorkerHandler({
      executeTask: vi.fn(),
      hasActiveTask: vi.fn(() => true),
      deliverHumanResponse: deliverSpy,
    } as any)

    const result = await dispatcher.dispatch(
      {
        type: 'supplement_task',
        task_id: 't_scheduled',
        supplement_content: '研究一下 UTC 0 点信号差异',
        immediate_reply: { type: 'text', text: '好的，调整一下方向' },
      },
      {
        channel_id: 'telegram-001',
        session_id: 'sess-x',
        messages: [{
          platform_message_id: 'm1',
          session: { channel_id: 'telegram-001', session_id: 'sess-x', type: 'private' as const },
          sender: { friend_id: 'f_wu', platform_user_id: 'u1', platform_display_name: 'Mr.Wu' },
          content: { type: 'text' as const, text: '研究一下' },
          features: { is_mention_crab: false },
          platform_timestamp: new Date().toISOString(),
        }],
        senderFriend: { id: 'f_wu', display_name: 'Mr.Wu' } as any,
        memoryPermissions: { write_visibility: 'internal', write_scopes: [] } as any,
      },
    )

    // 走 create_task 路径，返回新创建的 task_id
    expect(result).toEqual({ task_id: 't_new_via_fallback' })

    const methods = rpcCalls.map(c => c.method)
    expect(methods).toContain('get_task')      // 兜底前先查类型
    expect(methods).toContain('create_task')   // 触发 create_task fallback

    // supplement 不应投递到 worker（巡检本职被保护）
    expect(deliverSpy).not.toHaveBeenCalled()

    // worker 仍被调度去做用户的新需求（fire-and-forget）
    await new Promise(r => setTimeout(r, 30))
    expect(executeTaskFn).toHaveBeenCalledTimes(1)
  })

  it('proceeds with normal supplement when target is manual (regression: happy path unchanged)', async () => {
    const memoryWriter = {
      reportTaskFeedback: vi.fn(async () => undefined),
      listRecentLessons: vi.fn(async () => []),
      markValidationOutcome: vi.fn(async () => undefined),
      writeTaskCreated: vi.fn(async () => undefined),
      writeTaskFinished: vi.fn(async () => undefined),
      writeTriageDecision: vi.fn(async () => undefined),
      quickCapture: vi.fn(async () => undefined),
    } as any

    const rpcClient = {
      call: vi.fn(async (_port: number, method: string, params: any) => {
        if (method === 'get_task') {
          return { task: { id: params.task_id, source: { trigger_type: 'manual' } } }
        }
        return {}
      }),
    } as any

    const dispatcher = new DecisionDispatcher(
      rpcClient, 'agent-test',
      { assembleWorkerContext: vi.fn(async () => ({})) } as any,
      memoryWriter,
      async () => ADMIN_PORT,
      async () => CHANNEL_PORT,
      vi.fn(),
    )

    const deliverSpy = vi.fn()
    dispatcher.setWorkerHandler({
      executeTask: vi.fn(),
      hasActiveTask: vi.fn(() => true),
      deliverHumanResponse: deliverSpy,
    } as any)

    await dispatcher.dispatch(
      {
        type: 'supplement_task',
        task_id: 't_manual',
        supplement_content: '调整方向',
        immediate_reply: { type: 'text', text: '好的' },
      },
      {
        channel_id: 'telegram-001',
        session_id: 'sess-x',
        messages: [],
        senderFriend: { id: 'f_wu', display_name: 'Mr.Wu' } as any,
        memoryPermissions: {} as any,
      },
    )

    // manual task 走 supplement 投递
    expect(deliverSpy).toHaveBeenCalledTimes(1)
  })
})
