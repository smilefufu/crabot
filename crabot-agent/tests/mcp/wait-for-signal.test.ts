import { describe, it, expect, vi } from 'vitest'
import { createWaitForSignalTool, type WaitForSignalDeps } from '../../src/mcp/wait-for-signal.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import type { ToolCallContext } from '../../src/engine/types.js'

function makeDeps(overrides: Partial<WaitForSignalDeps> & { humanQueue: HumanMessageQueue }): WaitForSignalDeps {
  return {
    hasActiveAudit: () => false,
    hasActiveAsyncSubagent: () => false,
    hasRunningBgEntity: () => false,
    ...overrides,
  }
}

describe('wait_for_signal', () => {
  it('returns error when no pending event exists', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
    const result = await tool.call({ reason: 'test' }, {} as ToolCallContext)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('无 pending')
    // 拒绝文案要引导 timeout_ms 路径，而不是只推 end_turn
    expect(result.output).toContain('timeout_ms')
    // assert observable: barrier NOT set
    expect(humanQueue.hasBarrier).toBe(false)
  })

  it('sets barrier when audit is active', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue, hasActiveAudit: () => true }))
    const result = await tool.call({ reason: 'await audit' }, {} as ToolCallContext)
    expect(result.isError).toBe(false)
    expect(humanQueue.hasBarrier).toBe(true)
    humanQueue.clearBarrier()
  })

  it('sets barrier when async subagent is active', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue, hasActiveAsyncSubagent: () => true }))
    await tool.call({ reason: 'await subagent' }, {} as ToolCallContext)
    expect(humanQueue.hasBarrier).toBe(true)
    humanQueue.clearBarrier()
  })

  it('does not set barrier when humanQueue already has a pending push', async () => {
    const humanQueue = new HumanMessageQueue()
    humanQueue.push('pending message')
    const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
    const result = await tool.call({ reason: 'await pending' }, {} as ToolCallContext)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('已有 pending')
    expect(humanQueue.hasBarrier).toBe(false)
    expect(humanQueue.drainPending()).toEqual(['pending message'])
  })

  it('sets barrier when a bg entity is running', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool(makeDeps({ humanQueue, hasRunningBgEntity: () => true }))
    const result = await tool.call({ reason: 'await bg shell exit' }, {} as ToolCallContext)
    expect(result.isError).toBe(false)
    expect(humanQueue.hasBarrier).toBe(true)
    humanQueue.clearBarrier()
  })

  describe('timeout_ms', () => {
    it('allows timed wait with no pending event, pushes [wait_timeout] on expiry', async () => {
      vi.useFakeTimers()
      try {
        const humanQueue = new HumanMessageQueue()
        const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
        const result = await tool.call(
          { reason: '10 分钟后复查导入进度', timeout_ms: 600_000 },
          {} as ToolCallContext,
        )
        expect(result.isError).toBe(false)
        expect(humanQueue.hasBarrier).toBe(true)

        vi.advanceTimersByTime(600_000)
        expect(humanQueue.hasBarrier).toBe(false)
        const drained = humanQueue.drainPending()
        expect(drained).toHaveLength(1)
        expect(String(drained[0])).toContain('[wait_timeout]')
        expect(String(drained[0])).toContain('10 分钟后复查导入进度')
      } finally {
        vi.useRealTimers()
      }
    })

    it('early push wakes barrier and suppresses the [wait_timeout] marker', async () => {
      vi.useFakeTimers()
      try {
        const humanQueue = new HumanMessageQueue()
        const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
        await tool.call({ reason: 'wait', timeout_ms: 600_000 }, {} as ToolCallContext)

        humanQueue.push('[系统] Background shell shell_abc 已退出')
        expect(humanQueue.hasBarrier).toBe(false)

        vi.advanceTimersByTime(600_000)
        const drained = humanQueue.drainPending()
        expect(drained).toHaveLength(1)
        expect(String(drained[0])).not.toContain('[wait_timeout]')
      } finally {
        vi.useRealTimers()
      }
    })

    it('clamps timeout_ms below the minimum', async () => {
      vi.useFakeTimers()
      try {
        const humanQueue = new HumanMessageQueue()
        const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
        await tool.call({ reason: 'tiny wait', timeout_ms: 10 }, {} as ToolCallContext)
        // 10ms 被钳到最小值（1s）：10ms 后 barrier 仍在
        vi.advanceTimersByTime(10)
        expect(humanQueue.hasBarrier).toBe(true)
        vi.advanceTimersByTime(1_000)
        expect(humanQueue.hasBarrier).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('rejects non-integer timeout_ms', async () => {
      const humanQueue = new HumanMessageQueue()
      const tool = createWaitForSignalTool(makeDeps({ humanQueue }))
      const result = await tool.call({ reason: 'bad', timeout_ms: 'soon' }, {} as ToolCallContext)
      expect(result.isError).toBe(true)
      expect(humanQueue.hasBarrier).toBe(false)
    })
  })
})
