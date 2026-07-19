import { describe, it, expect, vi } from 'vitest'
import { dispatch, buildUserPrompt } from '../../src/dispatcher/dispatcher.js'
import type { DispatchContext, DispatchAction } from '../../src/dispatcher/dispatcher-types.js'
import type { LLMAdapter, LLMStreamParams } from '../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import type { ChannelMessage, TaskSummary } from '../../src/types.js'

function makeTask(id: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    task_id: id as never,
    title: `t-${id}`,
    status: 'executing',
    priority: 'normal',
    ...overrides,
  }
}

function makeCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    messages: [],
    recentMessages: [],
    activeTasks: [],
    sessionType: 'private',
    channelId: 'ch-test',
    sessionId: 'sess-test',
    senderFriend: {
      id: 'fr-1' as never,
      display_name: 'tester',
      permission: 'master',
      channel_identities: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    traceId: 'trace-test',
    ...overrides,
  }
}

function makeMockAdapter(responseText: string): LLMAdapter {
  return {
    stream: vi.fn(async function* () {
      yield* chunksFromContent([{ type: 'text', text: responseText }], 'end_turn')
    }),
    updateConfig: () => {},
  }
}

describe('dispatch', () => {
  it('LLM 返回单个 supplement 动作时正确解析', async () => {
    const adapter = makeMockAdapter(JSON.stringify({
      actions: [{ kind: 'supplement', target_task_id: 'task-A', text: '只看红米' }],
    }))
    const { actions } = await dispatch(
      makeCtx({ activeTasks: [makeTask('task-A')] }),
      { adapter, modelId: 'm', sendErrorToUser: vi.fn() },
    )
    expect(actions).toEqual<DispatchAction[]>([
      { kind: 'supplement', target_task_id: 'task-A' },
    ])
  })

  it('LLM 返回多个动作（拆分）时按顺序输出', async () => {
    const adapter = makeMockAdapter(JSON.stringify({
      actions: [
        { kind: 'new_task' },
        { kind: 'supplement', target_task_id: 'task-A', text: '对比 CPU' },
      ],
    }))
    const { actions } = await dispatch(
      makeCtx({ activeTasks: [makeTask('task-A')] }),
      { adapter, modelId: 'm', sendErrorToUser: vi.fn() },
    )
    expect(actions).toHaveLength(2)
    expect(actions[0].kind).toBe('new_task')
    expect(actions[1].kind).toBe('supplement')
  })

  it('LLM 返回的动作数超过 MAX_ACTIONS_PER_DISPATCH 时截断', async () => {
    const tooMany = Array.from({ length: 10 }, () => ({ kind: 'new_task' as const }))
    const adapter = makeMockAdapter(JSON.stringify({ actions: tooMany }))
    const { actions } = await dispatch(makeCtx(), { adapter, modelId: 'm', sendErrorToUser: vi.fn() })
    expect(actions.length).toBeLessThanOrEqual(5)
  })

  it('LLM 输出格式错误 → 重试用完后 sendErrorToUser 被调', async () => {
    const adapter: LLMAdapter = {
      stream: vi.fn(async function* () {
        yield* chunksFromContent([{ type: 'text', text: 'this is not json at all' }], 'end_turn')
      }),
      updateConfig: () => {},
    }
    const sendErrorToUser = vi.fn().mockResolvedValue(undefined)
    const { actions } = await dispatch(
      makeCtx(),
      { adapter, modelId: 'm', sendErrorToUser, maxParseRetries: 1 },
    )
    expect(actions).toEqual([])
    expect(sendErrorToUser).toHaveBeenCalledTimes(1)
    expect(sendErrorToUser.mock.calls[0][0]).toContain('系统出错')
  })

  // ============================================================================
  // Regression: dispatcher 必须能看到文件名 + 最近聊天历史
  // 修复来源：用户在 wechat 群里发 PDF + @棉花糖 "把人名隐去"，dispatcher 看到 [非文本] 失明
  // ============================================================================

  function makeFileMsg(over: Partial<ChannelMessage> = {}): ChannelMessage {
    return {
      platform_message_id: 'msg-pdf-1',
      session: { session_id: 'sess', channel_id: 'ch', type: 'private' },
      sender: { friend_id: 'fr-1', platform_user_id: 'u1', platform_display_name: '灰灰老师' },
      content: { type: 'file', text: '刘希红的家庭保障分析报告.pdf', media_url: 'https://example/file.pdf', filename: '刘希红的家庭保障分析报告.pdf' },
      features: { is_mention_crab: false },
      platform_timestamp: '2026-05-20T08:00:00Z',
      ...over,
    }
  }

  function makeTextMsg(text: string, over: Partial<ChannelMessage> = {}): ChannelMessage {
    return {
      platform_message_id: 'msg-text-1',
      session: { session_id: 'sess', channel_id: 'ch', type: 'private' },
      sender: { friend_id: 'fr-1', platform_user_id: 'u1', platform_display_name: '灰灰老师' },
      content: { type: 'text', text },
      features: { is_mention_crab: true },
      platform_timestamp: '2026-05-20T08:01:00Z',
      ...over,
    }
  }

  it('userPrompt 在 recent_messages 含 file 时渲染 [文件: filename]', () => {
    const fileMsg = makeFileMsg()
    const trigger = makeTextMsg('@棉花糖 把以上文件里的人名全隐去')
    const ctx = makeCtx({
      messages: [trigger],
      recentMessages: [fileMsg, trigger], // contextAssembler 拉的 recent 通常含 trigger
    })
    const prompt = buildUserPrompt(ctx)
    expect(prompt).toMatch(/## 最近聊天历史/)
    expect(prompt).toMatch(/\[文件: 刘希红的家庭保障分析报告\.pdf\]/)
    expect(prompt).toMatch(/## 当前消息批次/)
    // trigger 同时在 recentMessages 内，应该被去重，仅出现在「当前消息批次」
    expect((prompt.match(/把以上文件里的人名全隐去/g) ?? []).length).toBe(1)
  })

  it('userPrompt 在 messages 当前批次含 file 时也渲染 filename（群聊场景）', () => {
    const fileMsg = makeFileMsg()
    const ctx = makeCtx({
      messages: [fileMsg, makeTextMsg('@棉花糖 把以上文件里的人名全隐去', { platform_message_id: 'msg-text-2' })],
      recentMessages: [],
      sessionType: 'group',
    })
    const prompt = buildUserPrompt(ctx)
    expect(prompt).toMatch(/\[文件: 刘希红的家庭保障分析报告\.pdf\]/)
  })

  it('userPrompt 中 recent_messages 为空时不显示「最近聊天历史」段', () => {
    const ctx = makeCtx({
      messages: [makeTextMsg('你好')],
      recentMessages: [],
    })
    const prompt = buildUserPrompt(ctx)
    expect(prompt).not.toMatch(/## 最近聊天历史/)
    expect(prompt).toMatch(/## 当前消息批次/)
  })

  it('userPrompt renders recent completed and failed candidates under 可补充任务', () => {
    const ctx = makeCtx({
      activeTasks: [
        makeTask('task-active'),
        makeTask('task-done', {
          status: 'completed',
          candidate_kind: 'recent_terminal',
          completed_at: '2026-06-29T10:00:00.000Z',
          latest_progress: '已输出对比表格',
        }),
        makeTask('task-failed', {
          status: 'failed',
          candidate_kind: 'recent_terminal',
          completed_at: '2026-06-29T10:05:00.000Z',
          error: 'TypeError: terminated',
        }),
      ],
    })
    const prompt = buildUserPrompt(ctx, { timezone: 'Asia/Shanghai' })
    expect(prompt).toMatch(/## 当前正在运行的本 session task/)
    expect(prompt).toMatch(/status: executing/)
    // recent terminal 候选段只渲染处置信息（status/completed_at/失败原因），
    // 不渲染标题/进度——任务身份交给归因消息（2026-07-18 讨论结论）
    expect(prompt).toMatch(/## 近期结束的本 session task（可作为 supplement 候选）/)
    expect(prompt).toMatch(/\[task-done\] \(status: completed_recently, completed_at: 2026-06-29T10:00:00\.000Z\)/)
    expect(prompt).toMatch(/\[task-failed\] \(status: failed_recently/)
    expect(prompt).toMatch(/失败原因: TypeError: terminated/)
    expect(prompt).not.toMatch(/t-task-done/)
    expect(prompt).not.toMatch(/最近进度/)
    // 活跃 task 不出现在 recent terminal 段
    expect(prompt).not.toMatch(/\[task-active\].*completed_recently/)
  })

  it('userPrompt 无 recent terminal 候选时不渲染候选段', () => {
    const ctx = makeCtx({ activeTasks: [makeTask('task-active')] })
    const prompt = buildUserPrompt(ctx)
    expect(prompt).not.toMatch(/近期结束的本 session task/)
  })

  it('LLM can supplement a recent completed candidate because it is in the candidate whitelist', async () => {
    const adapter = makeMockAdapter(JSON.stringify({
      actions: [{ kind: 'supplement', target_task_id: 'task-done', text: '继续刚才的' }],
    }))
    const { actions } = await dispatch(
      makeCtx({ activeTasks: [makeTask('task-done', { status: 'completed', candidate_kind: 'recent_terminal' })] }),
      { adapter, modelId: 'm', sendErrorToUser: vi.fn() },
    )
    expect(actions).toEqual([{ kind: 'supplement', target_task_id: 'task-done' }])
  })

  // ============================================================================
  // Regression: trace db206eaf — 空 activeTasks 时 LLM 凭空输出 supplement +
  // 编造 trigger-<uuid> 形式的 target_task_id。schema 白名单校验在这里兜底。
  // ============================================================================

  it('LLM 输出 supplement 但 target_task_id 不在 activeTasks → 校验失败触发 retry', async () => {
    let callCount = 0
    const adapter: LLMAdapter = {
      stream: vi.fn(async function* () {
        callCount++
        const text = callCount === 1
          ? JSON.stringify({ actions: [{ kind: 'supplement', target_task_id: 'task-NONEXISTENT', text: 'x' }] })
          : JSON.stringify({ actions: [{ kind: 'new_task' }] })
        yield* chunksFromContent([{ type: 'text', text }], 'end_turn')
      }),
      updateConfig: () => {},
    }
    const { actions } = await dispatch(
      makeCtx({ activeTasks: [makeTask('task-REAL')] }),
      { adapter, modelId: 'm', sendErrorToUser: vi.fn(), maxParseRetries: 3 },
    )
    expect(callCount).toBe(2)
    expect(actions).toEqual([{ kind: 'new_task' }])
  })

  it('空 activeTasks + LLM 编造 supplement → 校验失败 retry → LLM 改输出 new_task', async () => {
    let callCount = 0
    const adapter: LLMAdapter = {
      stream: vi.fn(async function* () {
        callCount++
        const text = callCount === 1
          ? JSON.stringify({ actions: [{ kind: 'supplement', target_task_id: 'trigger-fake', text: 'x' }] })
          : JSON.stringify({ actions: [{ kind: 'new_task' }] })
        yield* chunksFromContent([{ type: 'text', text }], 'end_turn')
      }),
      updateConfig: () => {},
    }
    const { actions } = await dispatch(
      makeCtx({ activeTasks: [] }),
      { adapter, modelId: 'm', sendErrorToUser: vi.fn(), maxParseRetries: 3 },
    )
    expect(callCount).toBe(2)
    expect(actions[0].kind).toBe('new_task')
  })

  it('retry 时把上一次错误回灌进 user message，让 LLM 看到错在哪', async () => {
    const seenMessages: string[] = []
    let callCount = 0
    const adapter: LLMAdapter = {
      stream: vi.fn(async function* (p: LLMStreamParams) {
        const last = p.messages[p.messages.length - 1]
        const c = 'content' in last ? last.content : ''
        seenMessages.push(typeof c === 'string' ? c : JSON.stringify(c))
        callCount++
        const text = callCount === 1
          ? JSON.stringify({ actions: [{ kind: 'supplement', target_task_id: 'bogus', text: 'x' }] })
          : JSON.stringify({ actions: [{ kind: 'new_task' }] })
        yield* chunksFromContent([{ type: 'text', text }], 'end_turn')
      }),
      updateConfig: () => {},
    }
    await dispatch(
      makeCtx({ activeTasks: [makeTask('task-A')] }),
      { adapter, modelId: 'm', sendErrorToUser: vi.fn(), maxParseRetries: 3 },
    )
    expect(seenMessages.length).toBe(2)
    expect(seenMessages[0]).not.toMatch(/上一次输出被校验拒绝/)
    expect(seenMessages[1]).toMatch(/上一次输出被校验拒绝/)
    // 错误内容应提到 bogus 与可见 task_id 列表
    expect(seenMessages[1]).toMatch(/bogus/)
    expect(seenMessages[1]).toMatch(/task-A/)
  })

  it('私聊场景下 LLM 误输出 stay_silent → 校验失败 retry', async () => {
    let callCount = 0
    const adapter: LLMAdapter = {
      stream: vi.fn(async function* (_params: LLMStreamParams) {
        callCount++
        const text = callCount === 1
          ? JSON.stringify({ actions: [{ kind: 'stay_silent', reason: '...' }] })
          : JSON.stringify({ actions: [{ kind: 'new_task' }] })
        yield* chunksFromContent([{ type: 'text', text }], 'end_turn')
      }),
      updateConfig: () => {},
    }
    const { actions } = await dispatch(
      makeCtx({ sessionType: 'private' }),
      { adapter, modelId: 'm', sendErrorToUser: vi.fn(), maxParseRetries: 3 },
    )
    expect(actions[0].kind).toBe('new_task')
    expect(callCount).toBe(2)
  })
})
