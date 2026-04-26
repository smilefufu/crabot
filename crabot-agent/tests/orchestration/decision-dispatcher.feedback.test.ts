import { describe, it, expect, vi } from 'vitest'
import { DecisionDispatcher } from '../../src/orchestration/decision-dispatcher.js'

// dispatch 内部对 reportFeedbackIfPresent 是 fire-and-forget；
// 测试需要 flush 微任务 + IO 才能看到 spy 被调用。
async function flushFireAndForget() {
  await new Promise(resolve => setTimeout(resolve, 30))
}

// 工厂：构造一个最小可工作的 dispatcher，外部依赖全部 mock
// DecisionDispatcher 构造签名是位置参数：
//   (rpcClient, moduleId, contextAssembler, memoryWriter, getAdminPort, getChannelPort, executeTaskFn?)
function makeDispatcher(opts: {
  listTasksReturn?: any[]
  reportFeedbackSpy?: ReturnType<typeof vi.fn>
}) {
  const reportSpy = opts.reportFeedbackSpy ?? vi.fn(async () => undefined)
  const memoryWriter = {
    reportTaskFeedback: reportSpy,
    listRecentLessons: vi.fn(async () => []),
    markValidationOutcome: vi.fn(async () => undefined),
    writeTaskCreated: vi.fn(async () => undefined),
    writeTaskFinished: vi.fn(async () => undefined),
    writeTriageDecision: vi.fn(async () => undefined),
  } as any
  const rpcClient = {
    call: vi.fn(async (_port: number, method: string) => {
      if (method === 'list_tasks') {
        return { items: opts.listTasksReturn ?? [] }
      }
      return {}
    }),
  } as any
  // ContextAssembler 在 feedback 流程中不被调用，传 dummy 即可
  const contextAssembler = {} as any
  const dispatcher = new DecisionDispatcher(
    rpcClient,
    'agent-test',
    contextAssembler,
    memoryWriter,
    async () => 19001,
    async (_channelId: string) => 19010,
  )
  return { dispatcher, reportSpy, memoryWriter, rpcClient }
}

describe('DecisionDispatcher feedback anchoring', () => {
  it('reply with user_attitude=pass anchors to most recent finished task in same channel/sender', async () => {
    const recentFinishedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()  // 5 分钟前
    const olderFinishedAt = new Date(Date.now() - 25 * 60 * 1000).toISOString()  // 25 分钟前
    const { dispatcher, reportSpy } = makeDispatcher({
      listTasksReturn: [
        { id: 't_old', status: 'completed', finished_at: olderFinishedAt,
          source: { channel_id: 'ch_a', friend_id: 'f_zhang' } },
        { id: 't_recent', status: 'completed', finished_at: recentFinishedAt,
          source: { channel_id: 'ch_a', friend_id: 'f_zhang' } },
      ],
    })
    await dispatcher.dispatch(
      { type: 'direct_reply', reply: { type: 'text', text: '不客气' }, user_attitude: 'pass' },
      {
        channel_id: 'ch_a',
        session_id: 'sess_1',
        messages: [],
        senderFriend: { id: 'f_zhang', display_name: '张三' } as any,
        memoryPermissions: {} as any,
      },
    )
    await flushFireAndForget()
    expect(reportSpy).toHaveBeenCalledTimes(1)
    expect(reportSpy).toHaveBeenCalledWith('t_recent', 'pass')
  })

  it('reply with user_attitude=pass skips when no finished task within 30 min window', async () => {
    const tooOld = new Date(Date.now() - 60 * 60 * 1000).toISOString()  // 1 小时前
    const { dispatcher, reportSpy } = makeDispatcher({
      listTasksReturn: [
        { id: 't_x', status: 'completed', finished_at: tooOld,
          source: { channel_id: 'ch_a', friend_id: 'f_zhang' } },
      ],
    })
    await dispatcher.dispatch(
      { type: 'direct_reply', reply: { type: 'text', text: '不客气' }, user_attitude: 'pass' },
      {
        channel_id: 'ch_a',
        session_id: 'sess_1',
        messages: [],
        senderFriend: { id: 'f_zhang', display_name: '张三' } as any,
        memoryPermissions: {} as any,
      },
    )
    await flushFireAndForget()
    expect(reportSpy).not.toHaveBeenCalled()
  })

  it('reply skips when sender mismatch (group chat isolation)', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    const { dispatcher, reportSpy } = makeDispatcher({
      listTasksReturn: [
        { id: 't_a_task', status: 'completed', finished_at: recent,
          source: { channel_id: 'ch_g', friend_id: 'f_alice' } },
      ],
    })
    // sender = bob，但 task 是 alice 发起的
    await dispatcher.dispatch(
      { type: 'direct_reply', reply: { type: 'text', text: '收到' }, user_attitude: 'pass' },
      {
        channel_id: 'ch_g',
        session_id: 'sess_g',
        messages: [],
        senderFriend: { id: 'f_bob', display_name: 'Bob' } as any,
        memoryPermissions: {} as any,
      },
    )
    await flushFireAndForget()
    expect(reportSpy).not.toHaveBeenCalled()
  })

  it('supplement_task with user_attitude=fail anchors to payload task_id (not list_tasks query)', async () => {
    const { dispatcher, reportSpy } = makeDispatcher({})
    // 注意：本测试只验证 feedback 钩子是否锚定到 payload 的 task_id；
    // handleSupplementTask 在 workerHandler 未配置时会抛错，但 dispatch 入口的
    // reportFeedbackIfPresent 是 fire-and-forget，先于 switch 执行，所以即便后续
    // 抛错也不影响 spy 验证。
    await dispatcher.dispatch(
      { type: 'supplement_task',
        task_id: 't_active',
        supplement_content: 'should be tomorrow',
        user_attitude: 'fail' },
      {
        channel_id: 'ch_a',
        session_id: 'sess_1',
        messages: [],
        senderFriend: { id: 'f_zhang', display_name: '张三' } as any,
        memoryPermissions: {} as any,
      },
    ).catch(() => undefined)
    await flushFireAndForget()
    expect(reportSpy).toHaveBeenCalledTimes(1)
    expect(reportSpy).toHaveBeenCalledWith('t_active', 'fail')
  })

  it('decision without user_attitude triggers no feedback call', async () => {
    const { dispatcher, reportSpy } = makeDispatcher({})
    await dispatcher.dispatch(
      { type: 'direct_reply', reply: { type: 'text', text: '好的' } },
      {
        channel_id: 'ch_a',
        session_id: 'sess_1',
        messages: [],
        senderFriend: { id: 'f_zhang', display_name: '张三' } as any,
        memoryPermissions: {} as any,
      },
    )
    await flushFireAndForget()
    expect(reportSpy).not.toHaveBeenCalled()
  })
})
