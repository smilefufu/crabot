/**
 * 集成测试：dispatcher race fix。
 *
 * 验证 msg₁ 启动 agent 实例 A 后，msg₂ 立即可 supplement A（不需要等 30s）。
 * 端到端链路：dispatch() → executeDispatchActions() 完整串联。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-19-prefront-dispatcher-design.md §1.2
 */

import { describe, it, expect, vi } from 'vitest'
import { dispatch } from '../../src/dispatcher/dispatcher.js'
import { executeDispatchActions } from '../../src/dispatcher/dispatcher-executor.js'
import type { DispatchContext, ExecuteContext, DispatchAction } from '../../src/dispatcher/dispatcher-types.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import type { TaskSummary } from '../../src/types.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

function makeMockAdapter(responseText: string): LLMAdapter {
  return {
    stream: vi.fn(async function* () {
      yield* chunksFromContent([{ type: 'text', text: responseText }], 'end_turn')
    }),
    updateConfig: () => {},
  }
}

function makeCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    messages: [],
    recentMessages: [],
    activeTasks: [],
    sessionType: 'private',
    channelId: 'test-channel',
    sessionId: 'test-session',
    senderFriend: {
      id: 'fr-1' as never,
      display_name: 'tester',
      permission: 'master',
      channel_identities: [],
      created_at: '2026-05-19T00:00:00Z',
      updated_at: '2026-05-19T00:00:00Z',
    },
    traceId: 'trace-test',
    ...overrides,
  }
}

function makeTaskSummary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    task_id: 'task-A' as never,
    title: '查 618 手机',
    status: 'executing',
    priority: 'normal',
    trigger_type: 'message' as never,
    ...overrides,
  }
}

describe('dispatcher race fix - msg₂ 立即可 supplement msg₁ 的 agent 实例', () => {
  it('Step A-E: msg₂ 拿到含 A 的 active_tasks → dispatcher 输出 supplement(A) → executor 投递成功', async () => {
    // Step A: 模拟 msg₁ 已启动 agent 实例 A（admin tasks 表里有 A，agent in-flight 也有 A）
    const activeTasksAfterMsg1: TaskSummary[] = [makeTaskSummary({ task_id: 'task-A' as never })]

    // Step B: msg₂ 进入 → dispatcher 看到 active_tasks 含 A
    const ctx = makeCtx({
      activeTasks: activeTasksAfterMsg1,
      messages: [{
        platform_message_id: 'msg-2',
        session: { session_id: 'test-session' as never, channel_id: 'test-channel' as never, type: 'private' },
        sender: { platform_user_id: 'u-1', platform_display_name: 'tester' },
        content: { type: 'text', text: '算了只查红米 K90 MAX' },
        features: { is_mention_crab: false },
        platform_timestamp: '2026-05-19T00:00:01Z',
      }],
    })

    // Step C: mock LLM 输出 supplement(task-A)
    const adapter = makeMockAdapter(JSON.stringify({
      actions: [{
        kind: 'supplement',
        target_task_id: 'task-A',
        text: '收窄到只查红米 K90 MAX',
      }],
    }))

    const { actions } = await dispatch(ctx, {
      adapter,
      modelId: 'test-model',
      sendErrorToUser: vi.fn(),
    })

    // Step D: 验证 dispatcher 输出含 task-A 的 supplement
    expect(actions).toHaveLength(1)
    expect(actions[0]).toEqual<DispatchAction>({
      kind: 'supplement',
      target_task_id: 'task-A',
    })

    // Step E: executor 调 pushSupplement → 成功投递到 A
    const pushSupplement = vi.fn().mockResolvedValue('delivered' as const)
    const spawnAgentInstance = vi.fn()
    const execCtx: ExecuteContext = {
      dispatchCtx: ctx,
      pushSupplement,
      spawnAgentInstance,
      sendErrorToUser: vi.fn(),
    }
    await executeDispatchActions(actions, execCtx)

    // 验证 supplement 投递成功
    expect(pushSupplement).toHaveBeenCalledTimes(1)
    expect(pushSupplement).toHaveBeenCalledWith('task-A')
    expect(spawnAgentInstance).not.toHaveBeenCalled()  // 不应开新 agent 实例
  })

  it('对照：msg₂ 是无关新任务 → dispatcher 输出 new_task(B)，不 supplement A', async () => {
    const activeTasks: TaskSummary[] = [makeTaskSummary({ task_id: 'task-A' as never, title: '查手机' })]

    const ctx = makeCtx({
      activeTasks,
      messages: [{
        platform_message_id: 'msg-2',
        session: { session_id: 'test-session' as never, channel_id: 'test-channel' as never, type: 'private' },
        sender: { platform_user_id: 'u-1', platform_display_name: 'tester' },
        content: { type: 'text', text: '查一下今天 github 早报' },
        features: { is_mention_crab: false },
        platform_timestamp: '2026-05-19T00:00:01Z',
      }],
    })

    const adapter = makeMockAdapter(JSON.stringify({
      actions: [{ kind: 'new_task' }],
    }))

    const { actions } = await dispatch(ctx, {
      adapter,
      modelId: 'test-model',
      sendErrorToUser: vi.fn(),
    })

    expect(actions[0].kind).toBe('new_task')

    const pushSupplement = vi.fn()
    const spawnAgentInstance = vi.fn().mockResolvedValue({ spawnedTraceId: 'spawn-B' })
    await executeDispatchActions(actions, {
      dispatchCtx: ctx,
      pushSupplement,
      spawnAgentInstance,
      sendErrorToUser: vi.fn(),
    })

    expect(pushSupplement).not.toHaveBeenCalled()
    expect(spawnAgentInstance).toHaveBeenCalledTimes(1)
    // 第二参数是 spawnOptions：无 immediate_reply 时 executor 显式传 undefined
    expect(spawnAgentInstance).toHaveBeenCalledWith(undefined, undefined)
  })

  it('混合：dispatcher 输出 supplement + new_task → executor 两个都执行（按顺序）', async () => {
    const activeTasks: TaskSummary[] = [makeTaskSummary({ task_id: 'task-A' as never, title: '查手机' })]

    const ctx = makeCtx({
      activeTasks,
      messages: [
        {
          platform_message_id: 'msg-2a',
          session: { session_id: 'test-session' as never, channel_id: 'test-channel' as never, type: 'private' },
          sender: { platform_user_id: 'u-1', platform_display_name: 'tester' },
          content: { type: 'text', text: '算了只查红米' },
          features: { is_mention_crab: false },
          platform_timestamp: '2026-05-19T00:00:01Z',
        },
        {
          platform_message_id: 'msg-2b',
          session: { session_id: 'test-session' as never, channel_id: 'test-channel' as never, type: 'private' },
          sender: { platform_user_id: 'u-1', platform_display_name: 'tester' },
          content: { type: 'text', text: '另外查一下 github 早报' },
          features: { is_mention_crab: false },
          platform_timestamp: '2026-05-19T00:00:02Z',
        },
      ],
    })

    const adapter = makeMockAdapter(JSON.stringify({
      actions: [
        { kind: 'supplement', target_task_id: 'task-A' },
        { kind: 'new_task' },
      ],
    }))

    const { actions } = await dispatch(ctx, {
      adapter,
      modelId: 'test-model',
      sendErrorToUser: vi.fn(),
    })

    expect(actions).toHaveLength(2)
    expect(actions[0].kind).toBe('supplement')
    expect(actions[1].kind).toBe('new_task')

    const calls: string[] = []
    const pushSupplement = vi.fn().mockImplementation(async () => { calls.push('supp'); return 'delivered' as const })
    const spawnAgentInstance = vi.fn().mockImplementation(async () => { calls.push('spawn'); return { spawnedTraceId: 's' } })
    await executeDispatchActions(actions, {
      dispatchCtx: ctx,
      pushSupplement,
      spawnAgentInstance,
      sendErrorToUser: vi.fn(),
    })

    // supplement 必须先于 new_task 执行（顺序保证）
    expect(calls).toEqual(['supp', 'spawn'])
    expect(pushSupplement).toHaveBeenCalledWith('task-A')
    expect(spawnAgentInstance).toHaveBeenCalledWith(undefined, undefined)
  })
})
