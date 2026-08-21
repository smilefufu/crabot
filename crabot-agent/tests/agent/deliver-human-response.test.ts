/**
 * deliverHumanResponse 渲染媒体测试
 *
 * 验证 deliverHumanResponse 正确处理包含文件 / 图片的消息，
 * 渲染为人类可读的文本（含文件名 / 图片 URL）。
 *
 * Spec: 2026-05-20-session-lane-dispatcher-design.md §3.5
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import type { ChannelMessage, TaskId } from '../../src/types.js'

// Mock the engine so tests don't actually run the worker loop
vi.mock('../../src/engine/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    runEngine: vi.fn(),
  }
})

function makeSdkEnv() {
  return {
    modelId: 'test-model',
    format: 'anthropic' as const,
    env: {
      ANTHROPIC_BASE_URL: 'http://localhost:4000',
      ANTHROPIC_API_KEY: 'test-key',
    },
  }
}

describe('deliverHumanResponse 渲染媒体', () => {
  let handler: AgentHandler
  let pushed: string[]

  beforeEach(() => {
    pushed = []
    const mockRpcCall = vi.fn().mockImplementation(
      async (_port: unknown, method: string) => {
        if (method === 'create_task') {
          return { ok: true }
        }
        return {}
      },
    )

    handler = new AgentHandler(
      makeSdkEnv(),
      { systemPrompt: 'test agent' },
      {
        deps: {
          rpcClient: { call: mockRpcCall } as never,
          moduleId: 'test-agent',
          resolveChannelPort: async () => 3003,
          getMemoryPort: async () => 3002,
          getAdminPort: async () => 0,
        },
      },
    )

    // Manually inject task state and humanQueue for testing
    const taskId = 'task-test' as TaskId
    ;(handler as any).activeTasks.set(taskId, {
      taskId,
      status: 'executing',
      startedAt: '2026-05-20T00:00:00Z',
      title: 't',
      triggerType: 'message',
      abortController: new AbortController(),
      pendingHumanMessages: [],
      taskOrigin: {
        channel_id: 'c',
        session_id: 's',
        friend_id: 'f',
        session_type: 'private',
      },
      todoStore: { get current() { return [] } },
    })
    ;(handler as any).humanQueues.set(taskId, {
      push: (content: string) => pushed.push(content),
    })
  })

  afterEach(() => {
    handler.dispose()
  })

  function msg(over: Partial<ChannelMessage>): ChannelMessage {
    return {
      platform_message_id: 'm',
      session: { session_id: 's', channel_id: 'c', type: 'private' },
      sender: { friend_id: 'f', platform_user_id: 'u', platform_display_name: '灰灰' },
      content: { type: 'text', text: '' },
      features: { is_mention_crab: false },
      platform_timestamp: '2026-05-20T00:00:00Z',
      ...over,
    } as ChannelMessage
  }

  it('文件消息渲染为 [文件: filename]', () => {
    handler.deliverHumanResponse('task-test' as TaskId, [
      msg({
        content: {
          type: 'file',
          text: '',
          media_url: 'https://x/r.pdf',
          filename: '刘希红.pdf',
        } as any,
      }),
    ])
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatch(/\[文件: 刘希红\.pdf\]/)
  })

  it('图片消息渲染为 [图片: url]', () => {
    handler.deliverHumanResponse('task-test' as TaskId, [
      msg({
        content: {
          type: 'image',
          text: '',
          media_url: 'https://x/i.png',
        } as any,
      }),
    ])
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatch(/\[图片: https:\/\/x\/i\.png\]/)
  })

  it('文本 + 媒体混合，按消息顺序换行拼接', () => {
    handler.deliverHumanResponse('task-test' as TaskId, [
      msg({ content: { type: 'text', text: '看这文件' } as any }),
      msg({
        content: {
          type: 'file',
          text: '',
          media_url: 'u',
          filename: 'a.pdf',
        } as any,
      }),
    ])
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatch(/看这文件/)
    expect(pushed[0]).toMatch(/\[文件: a\.pdf\]/)
    // 顺序：text 在前
    expect(pushed[0].indexOf('看这文件')).toBeLessThan(pushed[0].indexOf('[文件:'))
  })

  it('多条纯文本仍按换行拼接（不破坏老行为）', () => {
    handler.deliverHumanResponse('task-test' as TaskId, [
      msg({ content: { type: 'text', text: '第一条' } as any }),
      msg({ content: { type: 'text', text: '第二条' } as any }),
    ])
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatch(/第一条\n第二条/)
  })

  it('投递真实 supplement → 发放改目标券（goalRevisionUnlocked=true）', () => {
    handler.deliverHumanResponse('task-test' as TaskId, [
      msg({ content: { type: 'text', text: '删除吧' } as any }),
    ])
    const taskState = (handler as any).activeTasks.get('task-test')
    expect(taskState.goalRevisionUnlocked).toBe(true)
  })


  it('全空消息（无内容投递）→ 不发券', () => {
    handler.deliverHumanResponse('task-test' as TaskId, [
      msg({ content: { type: 'text', text: '' } }),
    ])
    const taskState = (handler as any).activeTasks.get('task-test')
    expect(taskState.goalRevisionUnlocked).toBeFalsy()
  })

  it('全为空消息（无 text 也无 media）不 push humanQueue，但 status 仍更新为 executing', () => {
    handler.deliverHumanResponse('task-test' as TaskId, [
      // 既无 text 也无 media_url——formatMessageContent 返回 EMPTY_MESSAGE_PLACEHOLDER
      msg({ content: { type: 'text', text: '' } }),
    ])
    // 期望 silent drop：humanQueue 不被 push
    expect(pushed).toHaveLength(0)
    // 但 status 已更新（pendingHumanMessages 入栈）
    const taskState = (handler as any).activeTasks.get('task-test')
    expect(taskState.pendingHumanMessages).toHaveLength(1)
  })
})

/**
 * deliverHumanResponse 模板 variant 测试（Task 5）
 *
 * 验证根据 goalModeEnabled（this.extra.goal_mode_enabled !== false &&
 * taskState.triggerType !== 'scheduled'）选取对应模板：
 *  - on  → SUPPLEMENT_INJECTION_TEMPLATE_GOAL（含 set_task_goal 提示）
 *  - off → SUPPLEMENT_INJECTION_TEMPLATE_BASIC（仅"调整你的执行方向"）
 *
 * Spec: 2026-06-05-goal-soft-control-workflow-redesign-design.md §6
 */
describe('deliverHumanResponse template variant', () => {
  function setup(opts: {
    triggerType?: 'message' | 'scheduled'
    goalModeEnabled?: boolean
  }) {
    const pushed: string[] = []
    const mockRpcCall = vi.fn().mockResolvedValue({})
    const config: any = { systemPrompt: 'test agent' }
    if (opts.goalModeEnabled !== undefined) {
      config.extra = { goal_mode_enabled: opts.goalModeEnabled }
    }
    const handler = new AgentHandler(
      makeSdkEnv(),
      config,
      {
        deps: {
          rpcClient: { call: mockRpcCall } as never,
          moduleId: 'test-agent',
          resolveChannelPort: async () => 3003,
          getMemoryPort: async () => 3002,
          getAdminPort: async () => 0,
        },
      },
    )
    const taskId = 'task-variant' as TaskId
    ;(handler as any).activeTasks.set(taskId, {
      taskId,
      status: 'executing',
      startedAt: '2026-06-05T00:00:00Z',
      title: 't',
      triggerType: opts.triggerType ?? 'message',
      abortController: new AbortController(),
      pendingHumanMessages: [],
      taskOrigin: {
        channel_id: 'c',
        session_id: 's',
        friend_id: 'f',
        session_type: 'private',
      },
      todoStore: { get current() { return [] } },
    })
    ;(handler as any).humanQueues.set(taskId, {
      push: (content: string) => pushed.push(content),
    })
    return { handler, pushed, taskId }
  }

  function textMsg(text: string): ChannelMessage {
    return {
      platform_message_id: 'm',
      session: { session_id: 's', channel_id: 'c', type: 'private' },
      sender: { friend_id: 'f', platform_user_id: 'u', platform_display_name: '灰灰' },
      content: { type: 'text', text },
      features: { is_mention_crab: false },
      platform_timestamp: '2026-06-05T00:00:00Z',
    } as ChannelMessage
  }

  it('goal mode enabled（默认 + trigger=message）→ 使用 GOAL 模板（含 set_task_goal 提示）', () => {
    const { handler, pushed, taskId } = setup({ triggerType: 'message' })
    handler.deliverHumanResponse(taskId, [textMsg('换个方向，改成统计昨天的')])
    expect(pushed).toHaveLength(1)
    const injected = pushed[0]
    expect(injected).toContain('[实时纠偏 - 来自用户]')
    expect(injected).toContain('换个方向，改成统计昨天的')
    expect(injected).toContain('set_task_goal')
    expect(injected).toContain('讨论到这里需求才明确清楚')
    expect(injected).toContain('系统已为你解锁一次重写机会')
    handler.dispose()
  })

  it('goal mode disabled（scheduled task）→ 使用 BASIC 模板（不含 set_task_goal 提示）', () => {
    const { handler, pushed, taskId } = setup({ triggerType: 'scheduled' })
    handler.deliverHumanResponse(taskId, [textMsg('再加个条件')])
    expect(pushed).toHaveLength(1)
    const injected = pushed[0]
    expect(injected).toContain('[实时纠偏 - 来自用户]')
    expect(injected).toContain('再加个条件')
    expect(injected).toContain('调整你的执行方向')
    expect(injected).not.toContain('set_task_goal')
    expect(injected).not.toContain('解锁')
    handler.dispose()
  })

  it('goal mode disabled（extra.goal_mode_enabled=false）→ 使用 BASIC 模板', () => {
    const { handler, pushed, taskId } = setup({
      triggerType: 'message',
      goalModeEnabled: false,
    })
    handler.deliverHumanResponse(taskId, [textMsg('补充：只看 prod 环境')])
    expect(pushed).toHaveLength(1)
    const injected = pushed[0]
    expect(injected).toContain('补充：只看 prod 环境')
    expect(injected).toContain('调整你的执行方向')
    expect(injected).not.toContain('set_task_goal')
    handler.dispose()
  })
})
