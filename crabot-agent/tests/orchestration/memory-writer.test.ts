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

describe('MemoryWriter — D.1 删除 + D.2 新写入路径', () => {
  it('writeTaskCreated 方法已删除', () => {
    const w: any = new MemoryWriter({} as any, 'test', async () => 1234)
    expect(typeof w.writeTaskCreated).toBe('undefined')
  })
  it('writeTriageDecision 方法已删除', () => {
    const w: any = new MemoryWriter({} as any, 'test', async () => 1234)
    expect(typeof w.writeTriageDecision).toBe('undefined')
  })
  it('writeUserSignal 写入 channel/session/friend refs + emotion topic', async () => {
    const calls: any[] = []
    const fakeRpc = { call: async (...a: any[]) => { calls.push(a); return {} } }
    const w = new MemoryWriter(fakeRpc as any, 'crabot-agent', async () => 1234)
    await w.writeUserSignal({
      friend_name: 'FuFu', friend_id: 'f-1',
      channel_id: 'tg-001', session_id: 'sess-A',
      message_brief: '这版不对，重做',
      emotion: 'frustrated',
      visibility: 'private', scopes: [],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toBe('write_short_term')
    const payload = calls[0][2]
    expect(payload.content).toContain('FuFu')
    expect(payload.content).toContain('frustrated')
    expect(payload.content).toContain('这版不对，重做')
    expect(payload.refs.friend_id).toBe('f-1')
    expect(payload.refs.channel_id).toBe('tg-001')
    expect(payload.refs.session_id).toBe('sess-A')
    expect(payload.topic).toBe('user_signal:frustrated')
  })
})

describe('writeTaskFinished — Phase 2 structured content', () => {
  it('content 为 brief 一行（无亮点时不带过程亮点段）', async () => {
    const calls: any[] = []
    const rpcClient = { call: vi.fn((_p, _m, payload) => { calls.push(payload); return Promise.resolve({}) }) } as any
    const writer = new MemoryWriter(rpcClient, 'agent-test', () => 19002)

    await writer.writeTaskFinished({
      task_id: 't-1',
      task_title: '示例任务',
      outcome: 'completed',
      outcome_brief: '已修复 /fav 500，根因 vod_ids 未校验',
      process_highlights: [],
      friend_name: 'FuFu',
      friend_id: 'f-1',
      channel_id: 'telegram-001',
      session_id: 's-1',
      visibility: 'public',
      scopes: [],
      trace_id: 'tr-1',
    })

    expect(calls).toHaveLength(1)
    const content: string = calls[0].content
    expect(content).toBe('任务 t-1（示例任务）完成：已修复 /fav 500，根因 vod_ids 未校验')
    expect(content).not.toMatch(/过程亮点/)
  })

  it('content 含过程亮点 markdown 列表', async () => {
    const calls: any[] = []
    const rpcClient = { call: vi.fn((_p, _m, payload) => { calls.push(payload); return Promise.resolve({}) }) } as any
    const writer = new MemoryWriter(rpcClient, 'agent-test', () => 19002)

    await writer.writeTaskFinished({
      task_id: 't-2',
      task_title: 'GitHub 早报',
      outcome: 'completed',
      outcome_brief: '已发送早报到微信群',
      process_highlights: [
        'list_groups 失败（Method not found），改用 list_sessions 兜底定位群成功',
        'GitHub API 403 rate limit → 改用 trending 页面数据',
      ],
      friend_name: 'FuFu',
      friend_id: 'f-1',
      channel_id: 'feishu-fengyan',
      session_id: 's-2',
      visibility: 'public',
      scopes: [],
      trace_id: 'tr-2',
    })

    const content: string = calls[0].content
    expect(content).toMatch(/^任务 t-2（GitHub 早报）完成：已发送早报到微信群\n\n过程亮点:/)
    expect(content).toMatch(/- list_groups 失败/)
    expect(content).toMatch(/- GitHub API 403/)
  })

  it('outcome failed 时不写 task_finished 记忆', async () => {
    const calls: any[] = []
    const rpcClient = { call: vi.fn((_p, _m, payload) => { calls.push(payload); return Promise.resolve({}) }) } as any
    const writer = new MemoryWriter(rpcClient, 'agent-test', () => 19002)

    await writer.writeTaskFinished({
      task_id: 't-3',
      task_title: '失败任务',
      outcome: 'failed',
      outcome_brief: 'API 限流，未完成',
      process_highlights: ['连续 3 次重试均 429'],
      friend_name: 'FuFu',
      friend_id: 'f-1',
      channel_id: 'admin-web',
      session_id: 's-3',
      visibility: 'public',
      scopes: [],
    })

    expect(calls).toHaveLength(0)
  })
})
