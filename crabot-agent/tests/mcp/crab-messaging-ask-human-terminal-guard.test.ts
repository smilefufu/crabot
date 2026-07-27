/**
 * ask_human barrier 超时自醒时的终态兜底（决策 2026-07-27，issue #43 现象二第三道防线）。
 *
 * 正常路径：admin 判死前经 abort_worker 叫停 worker，barrier 根本等不到超时。
 * 这条覆盖那次 RPC 失败的窄窗口——barrier 自己醒来时先查 task 状态，已终态就 abort，
 * 不让 worker 带着死任务继续跑（历史上它会发出用户看不懂的进度消息，再撞状态机拒绝）。
 */
import { describe, it, expect, vi } from 'vitest'
import { buildMessagingTools } from '../../src/mcp/crab-messaging.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'

function findTool(tools: ReturnType<typeof buildMessagingTools>, name: string) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

function buildTools(queue: HumanMessageQueue, abortIfTaskTerminal: () => Promise<void>) {
  return buildMessagingTools({
    rpcClient: {
      call: vi.fn().mockResolvedValue({ platform_message_id: 'm', sent_at: '' }),
    } as never,
    moduleId: 'worker-test',
    getAdminPort: async () => 19001,
    resolveChannelPort: async () => 19009,
    getTaskContext: () => ({
      taskId: 't1',
      humanQueue: queue,
      triggerType: 'message' as const,
      hasGoal: () => false,
      abortIfTaskTerminal,
    }),
  })
}

describe('ask_human barrier 终态兜底', () => {
  it('barrier 超时触发 abortIfTaskTerminal', async () => {
    vi.useFakeTimers()
    try {
      const queue = new HumanMessageQueue()
      const guard = vi.fn().mockResolvedValue(undefined)
      const tools = buildTools(queue, guard)

      await findTool(tools, 'send_message').handler({
        channel_id: 'telegram-001', session_id: 's1', content: 'q', intent: 'ask_human',
      })
      expect(queue.hasBarrier).toBe(true)
      expect(guard).not.toHaveBeenCalled()

      // barrier 是 24h + 15min（> admin 24h 超时 + 5min 扫描周期）
      vi.advanceTimersByTime(24 * 3600 * 1000)
      expect(guard).not.toHaveBeenCalled()
      vi.advanceTimersByTime(16 * 60 * 1000)
      expect(guard).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('人类回复提前唤醒时不触发兜底（只有超时自醒才查）', async () => {
    vi.useFakeTimers()
    try {
      const queue = new HumanMessageQueue()
      const guard = vi.fn().mockResolvedValue(undefined)
      const tools = buildTools(queue, guard)

      await findTool(tools, 'send_message').handler({
        channel_id: 'telegram-001', session_id: 's1', content: 'q', intent: 'ask_human',
      })
      queue.push('人类回复')

      expect(queue.hasBarrier).toBe(false)
      vi.advanceTimersByTime(25 * 3600 * 1000)
      expect(guard).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
