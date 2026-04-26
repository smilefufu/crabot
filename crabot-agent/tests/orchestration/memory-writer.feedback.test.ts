import { describe, it, expect, vi } from 'vitest'
import { MemoryWriter } from '../../src/orchestration/memory-writer.js'

describe('MemoryWriter.reportTaskFeedback', () => {
  it('calls memory.report_task_feedback with task_id + attitude', async () => {
    const calls: any[] = []
    const rpcClient = {
      call: vi.fn(async (port: number, method: string, params: any, moduleId: string) => {
        calls.push({ port, method, params, moduleId })
        return { updated_count: 1, lesson_ids: ['mem_l_1'] }
      }),
    } as any
    const writer = new MemoryWriter(rpcClient, 'agent-test', () => 19002)
    await writer.reportTaskFeedback('task_a', 'pass')
    expect(rpcClient.call).toHaveBeenCalledTimes(1)
    expect(calls[0].method).toBe('report_task_feedback')
    expect(calls[0].params).toEqual({ task_id: 'task_a', attitude: 'pass' })
    expect(calls[0].port).toBe(19002)
  })

  it('does NOT throw on RPC failure (fire-and-forget)', async () => {
    const rpcClient = {
      call: vi.fn(async () => { throw new Error('rpc dead') }),
    } as any
    const writer = new MemoryWriter(rpcClient, 'agent-test', () => 19002)
    // 不应抛出
    await expect(writer.reportTaskFeedback('task_a', 'pass')).resolves.toBeUndefined()
  })

  it('forwards all 4 attitude values', async () => {
    const rpcClient = { call: vi.fn(async () => ({})) } as any
    const writer = new MemoryWriter(rpcClient, 'agent-test', () => 19002)
    await writer.reportTaskFeedback('t1', 'pass')
    await writer.reportTaskFeedback('t1', 'strong_pass')
    await writer.reportTaskFeedback('t1', 'fail')
    await writer.reportTaskFeedback('t1', 'strong_fail')
    expect(rpcClient.call).toHaveBeenCalledTimes(4)
    const attitudes = rpcClient.call.mock.calls.map((c: any[]) => c[2].attitude)
    expect(attitudes).toEqual(['pass', 'strong_pass', 'fail', 'strong_fail'])
  })
})
