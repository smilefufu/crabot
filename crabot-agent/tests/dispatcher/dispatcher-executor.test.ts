import { describe, it, expect, vi } from 'vitest'
import { executeDispatchActions } from '../../src/dispatcher/dispatcher-executor.js'
import type { ExecuteContext, DispatchAction } from '../../src/dispatcher/dispatcher-types.js'

function makeExecCtx(overrides: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    dispatchCtx: {
      messages: [], recentMessages: [], activeTasks: [], sessionType: 'private',
      channelId: 'ch', sessionId: 'sess',
      senderFriend: {} as never, traceId: 'trace-1',
    },
    pushSupplement: vi.fn().mockResolvedValue('delivered'),
    spawnAgentInstance: vi.fn().mockResolvedValue({ spawnedTraceId: 'spawn-1' }),
    sendErrorToUser: vi.fn(),
    ...overrides,
  }
}

describe('executeDispatchActions', () => {
  it('单个 supplement 动作调 pushSupplement', async () => {
    const ctx = makeExecCtx()
    const actions: DispatchAction[] = [
      { kind: 'supplement', target_task_id: 'task-A', text: '改成红米' },
    ]
    await executeDispatchActions(actions, ctx)
    expect(ctx.pushSupplement).toHaveBeenCalledWith('task-A', '改成红米')
  })

  it('单个 new_task 动作调 spawnAgentInstance', async () => {
    const ctx = makeExecCtx()
    const actions: DispatchAction[] = [{ kind: 'new_task', text: '查 github' }]
    await executeDispatchActions(actions, ctx)
    expect(ctx.spawnAgentInstance).toHaveBeenCalledWith('查 github', undefined)
  })

  it('stay_silent 动作不调任何回调', async () => {
    const ctx = makeExecCtx()
    const actions: DispatchAction[] = [{ kind: 'stay_silent', reason: 'irrelevant' }]
    await executeDispatchActions(actions, ctx)
    expect(ctx.pushSupplement).not.toHaveBeenCalled()
    expect(ctx.spawnAgentInstance).not.toHaveBeenCalled()
    expect(ctx.sendErrorToUser).not.toHaveBeenCalled()
  })

  it('多动作按顺序执行', async () => {
    const calls: string[] = []
    const ctx = makeExecCtx({
      pushSupplement: vi.fn().mockImplementation(async () => { calls.push('supp'); return 'delivered' }),
      spawnAgentInstance: vi.fn().mockImplementation(async () => { calls.push('spawn'); return { spawnedTraceId: 's' } }),
    })
    const actions: DispatchAction[] = [
      { kind: 'new_task', text: 'A' },
      { kind: 'supplement', target_task_id: 'T', text: 'B' },
      { kind: 'new_task', text: 'C' },
    ]
    await executeDispatchActions(actions, ctx)
    expect(calls).toEqual(['spawn', 'supp', 'spawn'])
  })

  it('某个动作失败不阻塞后续动作', async () => {
    const ctx = makeExecCtx({
      pushSupplement: vi.fn().mockRejectedValue(new Error('boom')),
    })
    const actions: DispatchAction[] = [
      { kind: 'supplement', target_task_id: 'T', text: 'x' },
      { kind: 'new_task', text: 'after-failure' },
    ]
    await executeDispatchActions(actions, ctx)
    expect(ctx.spawnAgentInstance).toHaveBeenCalledWith('after-failure', undefined)
  })

  it('supplement target not found 返回 fallback，不影响后续', async () => {
    const ctx = makeExecCtx({
      pushSupplement: vi.fn().mockResolvedValue('fallback'),
    })
    const actions: DispatchAction[] = [
      { kind: 'supplement', target_task_id: 'gone', text: 'x' },
      { kind: 'new_task', text: 'follow' },
    ]
    await executeDispatchActions(actions, ctx)
    // 现在 fallback 会触发降级 → spawnAgentInstance(action.text) + 后续 new_task 各 1 次
    // supplement fallback 路径不传 spawnOptions（1 参）；new_task 路径无 immediate_reply 时传 undefined 第二参
    expect(ctx.spawnAgentInstance).toHaveBeenCalledWith('x')
    expect(ctx.spawnAgentInstance).toHaveBeenCalledWith('follow', undefined)
    expect(ctx.spawnAgentInstance).toHaveBeenCalledTimes(2)
  })

  // ============================================================================
  // Regression: spec §3.6 — supplement_fallback 不再静默吃消息
  // 修复来源：trace db206eaf — LLM 编 task_id，pushSupplement 返回 fallback，
  // 旧实现仅 log warn 就丢消息；现改为自动降级 new_task 并写恢复 span。
  // ============================================================================

  it('supplement → fallback 时降级到 spawnAgentInstance，参数是 action.text', async () => {
    const spawn = vi.fn().mockResolvedValue({ spawnedTraceId: 'spawn-recovered' })
    const ctx = makeExecCtx({
      pushSupplement: vi.fn().mockResolvedValue('fallback'),
      spawnAgentInstance: spawn,
    })
    const actions: DispatchAction[] = [
      { kind: 'supplement', target_task_id: 'gone', text: '请帮我查 X' },
    ]
    await executeDispatchActions(actions, ctx)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith('请帮我查 X')
  })

  it('supplement → delivered 时不调 spawnAgentInstance（不误降级）', async () => {
    const spawn = vi.fn().mockResolvedValue({ spawnedTraceId: 's' })
    const ctx = makeExecCtx({
      pushSupplement: vi.fn().mockResolvedValue('delivered'),
      spawnAgentInstance: spawn,
    })
    const actions: DispatchAction[] = [
      { kind: 'supplement', target_task_id: 'task-A', text: '改成红米' },
    ]
    await executeDispatchActions(actions, ctx)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('supplement targeting recent terminal candidate calls reviveTerminalSupplement instead of pushSupplement', async () => {
    const reviveTerminalSupplement = vi.fn().mockResolvedValue({ outcome: 'revived' as const, traceId: 'trace-old' })
    const pushSupplement = vi.fn().mockResolvedValue('delivered')
    const base = makeExecCtx()
    const ctx = makeExecCtx({
      dispatchCtx: {
        ...base.dispatchCtx,
        activeTasks: [{
          task_id: 'task-done' as never,
          title: 'done',
          status: 'completed',
          priority: 'normal',
          candidate_kind: 'recent_terminal',
        } as never],
      },
      pushSupplement,
      reviveTerminalSupplement,
    } as Partial<ExecuteContext>)
    await executeDispatchActions([{ kind: 'supplement', target_task_id: 'task-done', text: '继续' }], ctx)
    expect(pushSupplement).not.toHaveBeenCalled()
    expect(reviveTerminalSupplement).toHaveBeenCalledWith('task-done', '继续')
  })

  it('terminal supplement revive success links dispatch trace to revived task', async () => {
    const markSupplementLinkedToTask = vi.fn()
    const base = makeExecCtx()
    const ctx = makeExecCtx({
      dispatchCtx: {
        ...base.dispatchCtx,
        activeTasks: [{
          task_id: 'task-done' as never,
          title: 'done',
          status: 'completed',
          priority: 'normal',
          candidate_kind: 'recent_terminal',
        } as never],
      },
      reviveTerminalSupplement: vi.fn().mockResolvedValue({ outcome: 'revived' as const }),
      markSupplementLinkedToTask,
    } as Partial<ExecuteContext>)
    await executeDispatchActions([{ kind: 'supplement', target_task_id: 'task-done', text: '继续' }], ctx)
    expect(markSupplementLinkedToTask).toHaveBeenCalledWith('task-done')
  })

  it('terminal supplement revive fallback does not link dispatch trace to attempted task', async () => {
    const markSupplementLinkedToTask = vi.fn()
    const base = makeExecCtx()
    const ctx = makeExecCtx({
      dispatchCtx: {
        ...base.dispatchCtx,
        activeTasks: [{
          task_id: 'task-done' as never,
          title: 'done',
          status: 'completed',
          priority: 'normal',
          candidate_kind: 'recent_terminal',
        } as never],
      },
      reviveTerminalSupplement: vi.fn().mockResolvedValue({ outcome: 'fallback' as const }),
      markSupplementLinkedToTask,
    } as Partial<ExecuteContext>)
    await executeDispatchActions([{ kind: 'supplement', target_task_id: 'task-done', text: '继续' }], ctx)
    expect(markSupplementLinkedToTask).not.toHaveBeenCalled()
  })

  it('terminal supplement revive fallback spawns new task with original supplement text', async () => {
    const spawn = vi.fn().mockResolvedValue({ spawnedTraceId: 'spawn-new' })
    const base = makeExecCtx()
    const ctx = makeExecCtx({
      dispatchCtx: {
        ...base.dispatchCtx,
        activeTasks: [{
          task_id: 'task-failed' as never,
          title: 'failed',
          status: 'failed',
          priority: 'normal',
          candidate_kind: 'recent_terminal',
        } as never],
      },
      reviveTerminalSupplement: vi.fn().mockResolvedValue({ outcome: 'fallback' as const }),
      spawnAgentInstance: spawn,
    } as Partial<ExecuteContext>)
    await executeDispatchActions([{ kind: 'supplement', target_task_id: 'task-failed', text: '继续' }], ctx)
    expect(spawn).toHaveBeenCalledWith('继续')
  })

  it('terminal supplement revive rejection spawns new task with original supplement text', async () => {
    const spawn = vi.fn().mockResolvedValue({ spawnedTraceId: 'spawn-new' })
    const base = makeExecCtx()
    const ctx = makeExecCtx({
      dispatchCtx: {
        ...base.dispatchCtx,
        activeTasks: [{
          task_id: 'task-failed' as never,
          title: 'failed',
          status: 'failed',
          priority: 'normal',
          candidate_kind: 'recent_terminal',
        } as never],
      },
      reviveTerminalSupplement: vi.fn().mockRejectedValue(new Error('admin down')),
      spawnAgentInstance: spawn,
    } as Partial<ExecuteContext>)
    await expect(executeDispatchActions([{ kind: 'supplement', target_task_id: 'task-failed', text: '继续' }], ctx))
      .resolves.toBeUndefined()
    expect(spawn).toHaveBeenCalledWith('继续')
  })

  it('terminal supplement missing revive callback spawns new task with original supplement text', async () => {
    const spawn = vi.fn().mockResolvedValue({ spawnedTraceId: 'spawn-new' })
    const base = makeExecCtx()
    const ctx = makeExecCtx({
      dispatchCtx: {
        ...base.dispatchCtx,
        activeTasks: [{
          task_id: 'task-done' as never,
          title: 'done',
          status: 'completed',
          priority: 'normal',
          candidate_kind: 'recent_terminal',
        } as never],
      },
      spawnAgentInstance: spawn,
    } as Partial<ExecuteContext>)
    await executeDispatchActions([{ kind: 'supplement', target_task_id: 'task-done', text: '继续' }], ctx)
    expect(spawn).toHaveBeenCalledWith('继续')
  })

  it('supplement fallback 触发 span outcome=supplement_fallback_recovered 并带 spawned_trace_id', async () => {
    const endSpan = vi.fn()
    const trace = {
      startSpan: vi.fn().mockReturnValue({ span_id: 'sp-1' }),
      endSpan,
    }
    const ctx = makeExecCtx({
      pushSupplement: vi.fn().mockResolvedValue('fallback'),
      spawnAgentInstance: vi.fn().mockResolvedValue({ spawnedTraceId: 'trace-child-9' }),
      trace,
    })
    await executeDispatchActions(
      [{ kind: 'supplement', target_task_id: 'gone', text: 'x' }],
      ctx,
    )
    expect(endSpan).toHaveBeenCalledTimes(1)
    const [, status, details] = endSpan.mock.calls[0]
    expect(status).toBe('completed')
    expect(details).toMatchObject({
      outcome: 'supplement_fallback_recovered',
      recovered_via: 'new_task',
      spawned_trace_id: 'trace-child-9',
      attempted_target_task_id: 'gone',
    })
  })

  // ============================================================================
  // immediate_reply（spec: 2026-06-03-dispatcher-immediate-reply-and-overdue-removal-design.md）
  // ============================================================================

  it('new_task 带 immediate_reply 时先 sendImmediateReply 后 spawn', async () => {
    const calls: string[] = []
    const sendImmediateReply = vi.fn().mockImplementation(async (text: string) => {
      calls.push('reply')
      return { text, platform_message_id: 'pm-1', sent_at: '2026-06-08T00:00:00.000Z' }
    })
    const spawnAgentInstance = vi.fn().mockImplementation(async () => {
      calls.push('spawn')
      return { spawnedTraceId: 's' }
    })
    const ctx = makeExecCtx({ sendImmediateReply, spawnAgentInstance })
    await executeDispatchActions(
      [{ kind: 'new_task', text: '查 github trending', immediate_reply: '好的，我看下' }],
      ctx,
    )
    expect(calls).toEqual(['reply', 'spawn'])
    expect(sendImmediateReply).toHaveBeenCalledWith('好的，我看下')
    expect(spawnAgentInstance).toHaveBeenCalledWith('查 github trending', {
      immediateReply: { text: '好的，我看下', platform_message_id: 'pm-1', sent_at: '2026-06-08T00:00:00.000Z' },
    })
  })

  it('new_task 不带 immediate_reply 时跳过 sendImmediateReply 直接 spawn（无 spawnOptions）', async () => {
    const sendImmediateReply = vi.fn()
    const spawnAgentInstance = vi.fn().mockResolvedValue({ spawnedTraceId: 's' })
    const ctx = makeExecCtx({ sendImmediateReply, spawnAgentInstance })
    await executeDispatchActions([{ kind: 'new_task', text: 'hi' }], ctx)
    expect(sendImmediateReply).not.toHaveBeenCalled()
    expect(spawnAgentInstance).toHaveBeenCalledWith('hi', undefined)
  })

  it('sendImmediateReply 抛错时 warn 但不阻塞 spawn 继续，且 spawn 不带 immediateReply', async () => {
    const sendImmediateReply = vi.fn().mockRejectedValue(new Error('network'))
    const spawnAgentInstance = vi.fn().mockResolvedValue({ spawnedTraceId: 's' })
    const ctx = makeExecCtx({ sendImmediateReply, spawnAgentInstance })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await executeDispatchActions(
      [{ kind: 'new_task', text: '调研', immediate_reply: '好' }],
      ctx,
    )
    warnSpy.mockRestore()
    expect(spawnAgentInstance).toHaveBeenCalledWith('调研', undefined)
  })

  it('immediate_reply 出现在 dispatch_action span outcome 详情里', async () => {
    const endSpan = vi.fn()
    const trace = {
      startSpan: vi.fn().mockReturnValue({ span_id: 'sp-1' }),
      endSpan,
    }
    const ctx = makeExecCtx({
      sendImmediateReply: vi.fn().mockResolvedValue({
        text: '好的', platform_message_id: 'pm-2', sent_at: '2026-06-08T00:00:00.000Z',
      }),
      trace,
    })
    await executeDispatchActions(
      [{ kind: 'new_task', text: '调研', immediate_reply: '好的' }],
      ctx,
    )
    const [, status, details] = endSpan.mock.calls[0]
    expect(status).toBe('completed')
    expect(details).toMatchObject({
      outcome: 'new_task_spawned',
      immediate_reply_sent: true,
    })
  })

  it('immediate_reply 字段存在但 ExecuteContext 未注入 sendImmediateReply 回调时跳过发送，直接 spawn', async () => {
    const spawnAgentInstance = vi.fn().mockResolvedValue({ spawnedTraceId: 's' })
    const ctx = makeExecCtx({ spawnAgentInstance })  // 未传 sendImmediateReply
    await executeDispatchActions(
      [{ kind: 'new_task', text: '调研', immediate_reply: '好的' }],
      ctx,
    )
    expect(spawnAgentInstance).toHaveBeenCalledWith('调研', undefined)
  })

  it('sendImmediateReply 抛错时 span outcome.immediate_reply_sent=false', async () => {
    const endSpan = vi.fn()
    const trace = {
      startSpan: vi.fn().mockReturnValue({ span_id: 'sp-1' }),
      endSpan,
    }
    const ctx = makeExecCtx({
      sendImmediateReply: vi.fn().mockRejectedValue(new Error('boom')),
      trace,
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await executeDispatchActions(
      [{ kind: 'new_task', text: 'x', immediate_reply: '好' }],
      ctx,
    )
    warnSpy.mockRestore()
    const [, status, details] = endSpan.mock.calls[0]
    expect(status).toBe('completed')
    expect(details).toMatchObject({
      outcome: 'new_task_spawned',
      immediate_reply_sent: false,
    })
  })

  describe('reactToTriggerMessage 触发逻辑（spec 2026-06-04）', () => {
    function makeMsg(id: string) {
      return {
        platform_message_id: id,
        session: { session_id: 'sess', channel_id: 'ch', type: 'private' as const },
        sender: { platform_user_id: 'u1', platform_display_name: 'U' },
        content: { type: 'text' as const, text: 'hi' },
        features: { is_mention_crab: false },
        platform_timestamp: '2026-06-04T00:00:00Z',
      }
    }

    it('new_task 成功后调 reactToTriggerMessage，参数是批次最后一条消息 id', async () => {
      const react = vi.fn().mockResolvedValue(undefined)
      const ctx = makeExecCtx({
        reactToTriggerMessage: react,
        dispatchCtx: {
          messages: [makeMsg('m1'), makeMsg('m2')],
          recentMessages: [], activeTasks: [], sessionType: 'private',
          channelId: 'ch', sessionId: 'sess',
          senderFriend: {} as never, traceId: 'trace-1',
        },
      })
      await executeDispatchActions([{ kind: 'new_task', text: 'go' }], ctx)
      expect(react).toHaveBeenCalledTimes(1)
      expect(react).toHaveBeenCalledWith('m2')
    })

    it('supplement delivered 后调 reactToTriggerMessage', async () => {
      const react = vi.fn().mockResolvedValue(undefined)
      const ctx = makeExecCtx({
        reactToTriggerMessage: react,
        dispatchCtx: {
          messages: [makeMsg('m9')],
          recentMessages: [], activeTasks: [], sessionType: 'private',
          channelId: 'ch', sessionId: 'sess',
          senderFriend: {} as never, traceId: 'trace-1',
        },
      })
      await executeDispatchActions(
        [{ kind: 'supplement', target_task_id: 't', text: 'add' }],
        ctx,
      )
      expect(react).toHaveBeenCalledWith('m9')
    })

    it('supplement fallback 降级 new_task 后也调 reactToTriggerMessage', async () => {
      const react = vi.fn().mockResolvedValue(undefined)
      const ctx = makeExecCtx({
        reactToTriggerMessage: react,
        pushSupplement: vi.fn().mockResolvedValue('fallback'),
        dispatchCtx: {
          messages: [makeMsg('m_last')],
          recentMessages: [], activeTasks: [], sessionType: 'private',
          channelId: 'ch', sessionId: 'sess',
          senderFriend: {} as never, traceId: 'trace-1',
        },
      })
      await executeDispatchActions(
        [{ kind: 'supplement', target_task_id: 'gone', text: 'x' }],
        ctx,
      )
      expect(react).toHaveBeenCalledTimes(1)
      expect(react).toHaveBeenCalledWith('m_last')
    })

    it('stay_silent 不调 reactToTriggerMessage', async () => {
      const react = vi.fn().mockResolvedValue(undefined)
      const ctx = makeExecCtx({
        reactToTriggerMessage: react,
        dispatchCtx: {
          messages: [makeMsg('m1')],
          recentMessages: [], activeTasks: [], sessionType: 'group',
          channelId: 'ch', sessionId: 'sess',
          senderFriend: {} as never, traceId: 'trace-1',
        },
      })
      await executeDispatchActions([{ kind: 'stay_silent', reason: 'x' }], ctx)
      expect(react).not.toHaveBeenCalled()
    })

    it('reactToTriggerMessage 抛错不阻塞 spawn / supplement', async () => {
      const spawn = vi.fn().mockResolvedValue({ spawnedTraceId: 's' })
      const ctx = makeExecCtx({
        spawnAgentInstance: spawn,
        reactToTriggerMessage: vi.fn().mockRejectedValue(new Error('rpc-down')),
        dispatchCtx: {
          messages: [makeMsg('m1')],
          recentMessages: [], activeTasks: [], sessionType: 'private',
          channelId: 'ch', sessionId: 'sess',
          senderFriend: {} as never, traceId: 'trace-1',
        },
      })
      await executeDispatchActions([{ kind: 'new_task', text: 'go' }], ctx)
      expect(spawn).toHaveBeenCalledTimes(1)
    })

    it('不注入 reactToTriggerMessage 时正常工作（向后兼容）', async () => {
      const ctx = makeExecCtx({
        dispatchCtx: {
          messages: [makeMsg('m1')],
          recentMessages: [], activeTasks: [], sessionType: 'private',
          channelId: 'ch', sessionId: 'sess',
          senderFriend: {} as never, traceId: 'trace-1',
        },
      })
      await executeDispatchActions([{ kind: 'new_task', text: 'go' }], ctx)
      expect(ctx.spawnAgentInstance).toHaveBeenCalledTimes(1)
    })

    it('messages 为空时不报错也不调 react（防御）', async () => {
      const react = vi.fn().mockResolvedValue(undefined)
      const ctx = makeExecCtx({ reactToTriggerMessage: react })
      await executeDispatchActions([{ kind: 'new_task', text: 'go' }], ctx)
      expect(react).not.toHaveBeenCalled()
    })
  })
})
