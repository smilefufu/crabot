/**
 * wait_for_signal targets 准入校验 + 唤醒/超时快照。
 * spec: 2026-07-16-wait-signal-targets-goal-lifecycle-design §5 / §6
 *
 * 关键语义：
 *  - targets 必填；命名目标不存在 → 立即拒绝（带不带 timeout_ms 都拒绝）
 *  - external 必须带 timeout_ms（轮询间隔——系统无法感知外部事件）
 *  - audit / human_reply 不是合法等待对象 → 定向教育文案
 *  - target 只做准入校验，不做唤醒过滤（任何 push 都唤醒——§5.2 硬不变量）
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createWaitForSignalTool,
  formatStillRunningSnapshot,
  type WaitForSignalDeps,
} from '../../src/mcp/wait-for-signal.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import type { ToolCallContext } from '../../src/engine/types.js'

const CTX = {} as ToolCallContext

function makeDeps(overrides: Partial<WaitForSignalDeps> & { humanQueue: HumanMessageQueue }): WaitForSignalDeps {
  return {
    listActiveAsyncSubagentIds: () => [],
    listRunningBgEntities: async () => [],
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('wait_for_signal targets 准入校验', () => {
  it('subagent 目标存在 → 挂起成功', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({
      humanQueue,
      listActiveAsyncSubagentIds: () => ['agent_1'],
    }))
    const result = await tool.call(
      { reason: '等 research 完成', targets: [{ kind: 'subagent' }] }, CTX)
    expect(result.isError).toBe(false)
    expect(humanQueue.hasBarrier).toBe(true)
    humanQueue.clearBarrier()
  })

  it('指定 id 的 subagent 在跑 → 挂起成功', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({
      humanQueue,
      listActiveAsyncSubagentIds: () => ['agent_1', 'agent_2'],
    }))
    const result = await tool.call(
      { reason: '等 agent_2', targets: [{ kind: 'subagent', id: 'agent_2' }] }, CTX)
    expect(result.isError).toBe(false)
    expect(humanQueue.hasBarrier).toBe(true)
    humanQueue.clearBarrier()
  })

  it('subagent 目标不存在 → 立即拒绝（带 timeout_ms 也拒绝——堵住旁路）', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
    const result = await tool.call(
      { reason: '等一个不存在的 subagent', targets: [{ kind: 'subagent' }], timeout_ms: 120_000 }, CTX)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('不存在')
    expect(humanQueue.hasBarrier).toBe(false)
  })

  it('指定 id 的 subagent 已完成 → 拒绝并指向 get_subagent_output', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({
      humanQueue,
      listActiveAsyncSubagentIds: () => ['agent_other'],
    }))
    const result = await tool.call(
      { reason: '等 agent_gone', targets: [{ kind: 'subagent', id: 'agent_gone' }] }, CTX)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('agent_gone')
    expect(result.output).toContain('get_subagent_output')
    expect(humanQueue.hasBarrier).toBe(false)
  })

  it('bg_entity 目标存在 → 挂起成功', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({
      humanQueue,
      listRunningBgEntities: async () => [{ id: 'shell_1', kind: 'bg_entity' }],
    }))
    const result = await tool.call(
      { reason: '等构建', targets: [{ kind: 'bg_entity' }] }, CTX)
    expect(result.isError).toBe(false)
    expect(humanQueue.hasBarrier).toBe(true)
    humanQueue.clearBarrier()
  })

  it('bg_entity 目标不存在 → 立即拒绝（带 timeout_ms 也拒绝）', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
    const result = await tool.call(
      { reason: '等 shell', targets: [{ kind: 'bg_entity', id: 'shell_gone' }], timeout_ms: 60_000 }, CTX)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('shell_gone')
    expect(humanQueue.hasBarrier).toBe(false)
  })

  it('external 不带 timeout_ms → 拒绝并解释轮询间隔语义', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
    const result = await tool.call(
      { reason: '等 PR review', targets: [{ kind: 'external' }] }, CTX)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('timeout_ms')
    expect(humanQueue.hasBarrier).toBe(false)
  })

  it('external + timeout_ms → 挂起成功', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
    const result = await tool.call(
      { reason: '等 PR review', targets: [{ kind: 'external' }], timeout_ms: 300_000 }, CTX)
    expect(result.isError).toBe(false)
    expect(humanQueue.hasBarrier).toBe(true)
    humanQueue.clearBarrier()
  })

  it('audit 不是合法等待对象 → 定向教育：系统在 end_turn 时自动等待', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
    const result = await tool.call(
      { reason: '等待最终交付验证完成', targets: [{ kind: 'audit' }], timeout_ms: 120_000 }, CTX)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('end_turn')
    expect(result.output).toContain('自动')
    expect(humanQueue.hasBarrier).toBe(false)
  })

  it('human_reply 不是合法等待对象 → 指向 ask_human', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
    const result = await tool.call(
      { reason: '等用户回复', targets: [{ kind: 'human_reply' }] }, CTX)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('ask_human')
    expect(humanQueue.hasBarrier).toBe(false)
  })

  it('targets 缺失 → schema 拒绝', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
    const result = await tool.call({ reason: 'bare wait' }, CTX)
    expect(result.isError).toBe(true)
    expect(humanQueue.hasBarrier).toBe(false)
  })

  it('混合 targets：subagent 存在 + external 带 timeout → 挂起成功', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({
      humanQueue,
      listActiveAsyncSubagentIds: () => ['agent_1'],
    }))
    const result = await tool.call(
      { reason: '等 subagent 或 CI', targets: [{ kind: 'subagent' }, { kind: 'external' }], timeout_ms: 300_000 }, CTX)
    expect(result.isError).toBe(false)
    expect(humanQueue.hasBarrier).toBe(true)
    humanQueue.clearBarrier()
  })

  it('已有 pending 唤醒事件 → 不挂起，提示先处理队列（优先级最高）', async () => {
    const humanQueue = new HumanMessageQueue()
    humanQueue.push('pending message')
    const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
    const result = await tool.call(
      { reason: '等', targets: [{ kind: 'subagent' }] }, CTX)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('已有 pending')
    expect(humanQueue.hasBarrier).toBe(false)
    expect(humanQueue.drainPending()).toEqual(['pending message'])
  })

  it('§5.2 硬不变量：挂起后任何 push 都唤醒（target 不做唤醒过滤）', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({
      humanQueue,
      listActiveAsyncSubagentIds: () => ['agent_1'],
    }))
    await tool.call({ reason: '等 subagent', targets: [{ kind: 'subagent', id: 'agent_1' }] }, CTX)
    expect(humanQueue.hasBarrier).toBe(true)
    // 与 target 无关的用户消息 push → barrier 立即清除
    humanQueue.push('用户实时纠偏')
    expect(humanQueue.hasBarrier).toBe(false)
  })

  it('rejects non-integer timeout_ms', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
    const result = await tool.call(
      { reason: 'bad', targets: [{ kind: 'external' }], timeout_ms: 'soon' }, CTX)
    expect(result.isError).toBe(true)
    expect(humanQueue.hasBarrier).toBe(false)
  })

  it('clamps timeout_ms below the minimum', async () => {
    vi.useFakeTimers()
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
    await tool.call({ reason: 'tiny wait', targets: [{ kind: 'external' }], timeout_ms: 10 }, CTX)
    // 10ms 被钳到最小值（1s）：10ms 后 barrier 仍在
    vi.advanceTimersByTime(10)
    expect(humanQueue.hasBarrier).toBe(true)
    vi.advanceTimersByTime(1_000)
    expect(humanQueue.hasBarrier).toBe(false)
  })
})

describe('wait_for_signal 超时消息', () => {
  it('超时消息含 [wait_timeout] + 声明对象回显；external 提示主动检查', async () => {
    vi.useFakeTimers()
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({
      humanQueue,
      listActiveAsyncSubagentIds: () => ['agent_1'],
    }))
    await tool.call(
      { reason: '等 subagent 和 PR review', targets: [{ kind: 'subagent', id: 'agent_1' }, { kind: 'external' }], timeout_ms: 60_000 }, CTX)
    vi.advanceTimersByTime(60_001)
    const drained = humanQueue.drainPending()
    expect(drained).toHaveLength(1)
    const msg = String(drained[0])
    expect(msg).toContain('[wait_timeout]')
    expect(msg).toContain('agent_1')
    expect(msg).toContain('主动检查')
  })

  it('early push 提前唤醒 → 不产生 [wait_timeout] 标记', async () => {
    vi.useFakeTimers()
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({
      humanQueue,
      listRunningBgEntities: async () => [{ id: 'shell_abc', kind: 'bg_entity' }],
    }))
    await tool.call({ reason: 'wait', targets: [{ kind: 'bg_entity' }], timeout_ms: 600_000 }, CTX)

    humanQueue.push('[系统] Background shell shell_abc 已退出')
    expect(humanQueue.hasBarrier).toBe(false)

    vi.advanceTimersByTime(600_000)
    const drained = humanQueue.drainPending()
    expect(drained).toHaveLength(1)
    expect(String(drained[0])).not.toContain('[wait_timeout]')
  })

  it('重复 external 超时仍只提示主动检查，不强制收尾或创建 schedule', async () => {
    vi.useFakeTimers()
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
    const messages: string[] = []
    for (let i = 0; i < 3; i++) {
      await tool.call(
        { reason: '等外部事件', targets: [{ kind: 'external' }], timeout_ms: 60_000 }, CTX)
      vi.advanceTimersByTime(60_001)
      // 模拟 agent 醒来消费掉超时消息后再次挂起
      messages.push(...humanQueue.drainPending().map(String))
    }
    expect(messages.length).toBe(3)
    for (const message of messages) {
      expect(message).toContain('立即主动检查外部状态')
      expect(message).not.toContain('收尾')
      expect(message).not.toContain('schedule')
    }
  })
})

describe('formatStillRunningSnapshot', () => {
  it('空列表 → 空串', () => {
    expect(formatStillRunningSnapshot([])).toBe('')
  })

  it('列出每个在跑对象的 id，并引导继续等待', () => {
    const line = formatStillRunningSnapshot([
      { id: 'agent_7bc2', kind: 'subagent', runtime_ms: 192_000, description: 'research' },
      { id: 'shell_a19a', kind: 'bg_entity', runtime_ms: 100_000 },
    ])
    expect(line).toContain('agent_7bc2')
    expect(line).toContain('shell_a19a')
    expect(line).toContain('仍在运行')
    expect(line).toContain('wait_for_signal')
  })
})
