import { describe, it, expect, vi } from 'vitest'
import { buildWorkerMessagingTools } from '../../src/mcp/crab-messaging.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'

function findTool(tools: ReturnType<typeof buildWorkerMessagingTools>, name: string) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

describe('send_message intent=ask_human', () => {
  it('calls update_task_status with waiting_human + pending_question', async () => {
    const queue = new HumanMessageQueue()
    const rpcCalls: Array<{ method: string; params: unknown }> = []
    const callOrder: string[] = []

    const tools = buildWorkerMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string, params: unknown) => {
          rpcCalls.push({ method, params })
          callOrder.push(method)
          if (method === 'update_task_status') return { task: { id: 't1', status: 'waiting_human' } }
          if (method === 'send_message') return { platform_message_id: 'm1', sent_at: '2026-05-14T00:00:00Z' }
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'message' as const, hasGoal: () => false }),
    })

    const sendTool = findTool(tools, 'send_message')
    await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: '你倾向 A、B 还是 C？',
      intent: 'ask_human',
    })

    const updateCall = rpcCalls.find(c => c.method === 'update_task_status')
    expect(updateCall).toBeDefined()
    expect(updateCall!.params).toMatchObject({
      task_id: 't1',
      status: 'waiting_human',
      pending_question: '你倾向 A、B 还是 C？',
    })

    const sendCall = rpcCalls.find(c => c.method === 'send_message')
    expect(sendCall).toBeDefined()  // ask_human 必须继续走原 send 逻辑，不能早 return

    // ordering 断言：send_message 必须在 update_task_status 之前（send-first）
    expect(callOrder.indexOf('send_message')).toBeLessThan(callOrder.indexOf('update_task_status'))

    queue.clearBarrier()
  })

  it('sets barrier on humanQueue after ask_human', async () => {
    const queue = new HumanMessageQueue()

    const tools = buildWorkerMessagingTools({
      rpcClient: {
        call: vi.fn().mockResolvedValue({ platform_message_id: 'm', sent_at: '' }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'message' as const, hasGoal: () => false }),
    })

    expect(queue.hasBarrier).toBe(false)
    const sendTool = findTool(tools, 'send_message')
    await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'q',
      intent: 'ask_human',
    })
    expect(queue.hasBarrier).toBe(true)
    // cleanup timer to avoid leaking into vitest
    queue.clearBarrier()
  })

  it('returns error when getTaskContext is null', async () => {
    const tools = buildWorkerMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'front',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => null,
    })
    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'q',
      intent: 'ask_human',
    })
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    expect(parsed.error).toBeDefined()
    expect(parsed.error).toContain('ask_human')
  })

  it('intent=info does NOT touch task state or barrier', async () => {
    const queue = new HumanMessageQueue()
    const rpcMethods: string[] = []

    const tools = buildWorkerMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string) => {
          rpcMethods.push(method)
          return { platform_message_id: 'm', sent_at: '' }
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'message' as const, hasGoal: () => false }),
    })

    const sendTool = findTool(tools, 'send_message')
    await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'info message',
    })
    expect(rpcMethods).not.toContain('update_task_status')
    expect(queue.hasBarrier).toBe(false)
  })

  it('scheduled 任务调用 ask_human 时返回拒绝错误，错误消息含明确指引', async () => {
    const queue = new HumanMessageQueue()

    const tools = buildWorkerMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'scheduled' as const, hasGoal: () => false }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'are you there?',
      intent: 'ask_human',
    })

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    expect(parsed.error).toBeDefined()
    expect(parsed.error).toContain('ask_human is not allowed in scheduled tasks')
    expect(parsed.error).toMatch(/intent='?info'?/)
  })

  it('daily_reflection 任务的工具白名单不暴露 send_message / send_private_message / list_*，唯一对外通道是 send_master_private', async () => {
    // daily-reflection 反思任务专用：避免反思内容（trace 数据 / Evolution Mode 等内部黑话）被发到任意 channel/session。
    // 其他 scheduled 任务（用户自建的群推送 / 巡检）不受此白名单影响——它们走 triggerType='scheduled' 但 taskType 不是 'daily_reflection'。
    const queue = new HumanMessageQueue()

    const tools = buildWorkerMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1', humanQueue: queue,
        triggerType: 'scheduled' as const,
        taskType: 'daily_reflection',
        hasGoal: () => false,
      }),
    })

    expect(tools.find(t => t.name === 'send_message')).toBeUndefined()
    expect(tools.find(t => t.name === 'send_private_message')).toBeUndefined()
    expect(tools.find(t => t.name === 'lookup_friend')).toBeUndefined()
    expect(tools.find(t => t.name === 'list_groups')).toBeUndefined()
    expect(tools.find(t => t.name === 'send_master_private')).toBeDefined()
  })

  it('非 daily_reflection 的 scheduled 任务（用户自建推送等）保留完整 messaging 工具集', async () => {
    const queue = new HumanMessageQueue()

    const tools = buildWorkerMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1', humanQueue: queue,
        triggerType: 'scheduled' as const,
        taskType: 'news_briefing',
        hasGoal: () => false,
      }),
    })

    expect(tools.find(t => t.name === 'send_message')).toBeDefined()
    expect(tools.find(t => t.name === 'send_private_message')).toBeDefined()
    expect(tools.find(t => t.name === 'lookup_friend')).toBeDefined()
    expect(tools.find(t => t.name === 'list_groups')).toBeDefined()
    expect(tools.find(t => t.name === 'send_master_private')).toBeDefined()
  })

  it('message 任务调用 ask_human 不在 scheduled 闸门被拒（仍可走后续流程）', async () => {
    const queue = new HumanMessageQueue()

    const tools = buildWorkerMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string) => {
          if (method === 'update_task_status') return { task: { id: 't1', status: 'waiting_human' } }
          if (method === 'send_message') return { platform_message_id: 'm1', sent_at: '' }
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'message' as const, hasGoal: () => false }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'are you there?',
      intent: 'ask_human',
    })

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    // message 触发的任务不应被第一道闸门（scheduled 拒绝）挡住
    expect(parsed.error ?? '').not.toContain('ask_human is not allowed in scheduled tasks')

    queue.clearBarrier()
  })

  it('does NOT set barrier if update_task_status fails (transient admin failure — spec §5.3)', async () => {
    const queue = new HumanMessageQueue()

    const tools = buildWorkerMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string) => {
          if (method === 'update_task_status') throw new Error('admin unavailable')
          if (method === 'send_message') return { platform_message_id: 'm1', sent_at: '' }
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'message' as const, hasGoal: () => false }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'q',
      intent: 'ask_human',
    })

    // barrier 不应被设置，防止 worker 卡死 24h
    expect(queue.hasBarrier).toBe(false)

    // 结果应含 ask_human_state_error 字段，让 worker 感知到状态切换失败
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    expect(parsed.ask_human_state_error).toBeDefined()
    expect(parsed.ask_human_state_error).toContain('update_task_status')
    // 消息已经成功发出，即使后续状态切换失败，目标仍是可信观察。
    expect(result.observedSessionTargets).toEqual([
      { channel_id: 'telegram-001', session_id: 's1' },
    ])
    expect(parsed).not.toHaveProperty('observedSessionTargets')
  })

  it('persistent state machine reject（ADMIN_INVALID_STATUS_TRANSITION）时先补齐状态机再 setBarrier', async () => {
    // 复现 trace 4751612f：task 长期停在 pending（trigger 路径不切状态机的 bug），
    // 第一次 pending→waiting_human 被 admin 状态机拒；ask_human 应自动尝试 planning→executing→waiting_human 修复，
    // 修复成功后 barrier 必须设置，让 loop 真正阻塞等回应。
    const queue = new HumanMessageQueue()
    let simulatedStatus: 'pending' | 'planning' | 'executing' | 'waiting_human' = 'pending'
    const transitionCalls: Array<{ status: string; pending_question?: string | null }> = []

    const tools = buildWorkerMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string, params: Record<string, unknown>) => {
          if (method === 'send_message') return { platform_message_id: 'm1', sent_at: '' }
          if (method === 'update_task_status') {
            const targetStatus = params.status as typeof simulatedStatus
            transitionCalls.push({ status: targetStatus, pending_question: params.pending_question as string | null | undefined })
            // 仿 admin 状态机
            const valid: Record<typeof simulatedStatus, string[]> = {
              pending: ['planning', 'cancelled'],
              planning: ['executing', 'failed', 'cancelled'],
              executing: ['waiting_human', 'completed', 'failed', 'cancelled'],
              waiting_human: ['executing', 'cancelled', 'failed'],
            }
            if (!valid[simulatedStatus].includes(targetStatus)) {
              throw new Error('ADMIN_INVALID_STATUS_TRANSITION')
            }
            simulatedStatus = targetStatus
            return { task: { id: 't1', status: simulatedStatus } }
          }
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'message' as const, hasGoal: () => false }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: '你倾向 A、B 还是 C？',
      intent: 'ask_human',
    })

    // 必须修复成功——最终落在 waiting_human
    expect(simulatedStatus).toBe('waiting_human')

    // 修复 sequence: 首尝试 waiting_human（被拒）→ planning → executing → waiting_human（成功）
    const targetSequence = transitionCalls.map(c => c.status)
    expect(targetSequence).toEqual(['waiting_human', 'planning', 'executing', 'waiting_human'])

    // barrier 必须设上，loop 才能真阻塞
    expect(queue.hasBarrier).toBe(true)

    // 返回值不应含 ask_human_state_error（成功路径）
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    expect(parsed.ask_human_state_error).toBeUndefined()
    expect(parsed.platform_message_id).toBe('m1')

    queue.clearBarrier()
  })

  it('补齐 sequence 仍失败时（如 task 已 completed），按 §5.3 兜底——不 setBarrier，返回 ask_human_state_error', async () => {
    const queue = new HumanMessageQueue()
    const transitionCalls: string[] = []
    // 仿真：task 已 completed（终结态），所有 transition 都会被拒
    const tools = buildWorkerMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string, params: Record<string, unknown>) => {
          if (method === 'send_message') return { platform_message_id: 'm1', sent_at: '' }
          if (method === 'update_task_status') {
            transitionCalls.push(params.status as string)
            throw new Error('ADMIN_INVALID_STATUS_TRANSITION')
          }
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'message' as const, hasGoal: () => false }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'q',
      intent: 'ask_human',
    })

    // 尝试了 waiting_human + planning + executing + waiting_human(重试) 共 4 次
    expect(transitionCalls.length).toBeGreaterThanOrEqual(4)

    // 修复失败 → barrier 不设
    expect(queue.hasBarrier).toBe(false)

    // 返回值应含 ask_human_state_error
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    expect(parsed.ask_human_state_error).toBeDefined()
    expect(parsed.ask_human_state_error).toContain('INVALID_STATUS_TRANSITION')
  })
})
