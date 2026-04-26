import { describe, it, expect, vi } from 'vitest'
import { MemoryWriter } from '../../src/orchestration/memory-writer.js'

describe('MemoryWriter phase 3 helpers', () => {
  it('quickCapture posts to memory quick_capture RPC', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ data: { id: 'mem-l-x', status: 'ok' } })
    const rpcClient: any = { call: rpcCall }
    const writer = new MemoryWriter(rpcClient, 'agent-1', () => 18000)

    await writer.quickCapture({
      type: 'lesson',
      brief: '飞书表情用 emoji_id',
      content: 'detail',
      source_ref: { type: 'reflection', task_id: 't1' },
      entities: [],
      tags: ['feishu'],
      importance_factors: { proximity: 0.8, surprisal: 0.7, entity_priority: 0.5, unambiguity: 0.7 },
    })

    expect(rpcCall).toHaveBeenCalledWith(
      18000, 'quick_capture', expect.objectContaining({ type: 'lesson' }), 'agent-1',
    )
  })

  it('fetchConfirmedSnapshot returns by_type', async () => {
    const rpcCall = vi.fn().mockResolvedValue({
      data: { snapshot_id: 'snap-1', generated_at: 'now', by_type: { fact: [], lesson: [], concept: [] } },
    })
    const writer = new MemoryWriter({ call: rpcCall } as any, 'agent-1', () => 18000)
    const snap = await writer.fetchConfirmedSnapshot()
    expect(snap?.snapshot_id).toBe('snap-1')
    expect(snap?.by_type.fact).toEqual([])
  })

  it('bumpLessonUseCount issues update_long_term style RPC', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ data: { status: 'ok' } })
    const writer = new MemoryWriter({ call: rpcCall } as any, 'agent-1', () => 18000)
    await writer.bumpLessonUseCount('mem-l-1')
    expect(rpcCall).toHaveBeenCalledWith(18000, 'bump_lesson_use', expect.objectContaining({ id: 'mem-l-1' }), 'agent-1')
  })

  it('markValidationOutcome posts update_long_term', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ data: { status: 'ok' } })
    const writer = new MemoryWriter({ call: rpcCall } as any, 'agent-1', () => 18000)
    await writer.markValidationOutcome('mem-l-1', 'fail')
    expect(rpcCall).toHaveBeenCalledWith(
      18000, 'update_long_term',
      expect.objectContaining({ id: 'mem-l-1', patch: { validation_outcome: 'fail' } }),
      'agent-1',
    )
  })

  it('runMaintenance posts to memory run_maintenance RPC with scope=all by default', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ data: { report: {} } })
    const writer = new MemoryWriter({ call: rpcCall } as any, 'agent-1', () => 18000)
    await writer.runMaintenance()
    expect(rpcCall).toHaveBeenCalledWith(18000, 'run_maintenance', { scope: 'all' }, 'agent-1')
  })

  it('runMaintenance accepts custom scope', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ data: { report: {} } })
    const writer = new MemoryWriter({ call: rpcCall } as any, 'agent-1', () => 18000)
    await writer.runMaintenance('observation_check')
    expect(rpcCall).toHaveBeenCalledWith(18000, 'run_maintenance', { scope: 'observation_check' }, 'agent-1')
  })

  it('quickCapture is fire-and-forget: caller proceeds even when memory RPC blocks 2s (spec §6.0.1)', async () => {
    // Arrange: 模拟 memory 端 RPC 卡 2 秒
    const rpcCall = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ data: { id: 'mem-x' } }), 2000)),
    )
    const writer = new MemoryWriter({ call: rpcCall } as any, 'agent-1', () => 18000)

    // 模拟 decision-dispatcher 的 call-site 模式：不 await quickCapture
    const start = Date.now()
    const _detached: Promise<void> = writer.quickCapture({
      type: 'lesson',
      brief: 'fire-and-forget',
      content: 'detail',
      source_ref: { type: 'reflection', task_id: 't1' },
      entities: [],
      tags: [],
      importance_factors: { proximity: 0.5, surprisal: 0.5, entity_priority: 0.5, unambiguity: 0.5 },
    })
    const elapsedAfterCall = Date.now() - start

    // Caller 立即返回（不等 2s RPC）
    expect(elapsedAfterCall).toBeLessThan(100)

    // Cleanup: 等 detached promise 完成，避免 vitest 报 unhandled promise
    await _detached
    expect(rpcCall).toHaveBeenCalledTimes(1)
  })

  it('quickCapture swallows memory RPC failure (caller never sees rejection)', async () => {
    // Arrange: RPC 抛错
    const rpcCall = vi.fn().mockRejectedValue(new Error('memory module down'))
    const writer = new MemoryWriter({ call: rpcCall } as any, 'agent-1', () => 18000)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Act: 即使内部 await 也不应该向外抛
    await expect(
      writer.quickCapture({
        type: 'lesson',
        brief: 'swallow',
        content: 'x',
        source_ref: { type: 'reflection' },
        entities: [],
        tags: [],
        importance_factors: { proximity: 0.5, surprisal: 0.5, entity_priority: 0.5, unambiguity: 0.5 },
      }),
    ).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to quick_capture memory'),
      expect.stringContaining('memory module down'),
    )
    errorSpy.mockRestore()
  })
})
