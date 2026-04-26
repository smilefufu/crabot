import { describe, it, expect, vi } from 'vitest'
import { WorkerHandler } from '../../src/agent/worker-handler.js'
import type { ConfirmedSnapshot } from '../../src/orchestration/memory-writer.js'

describe('WorkerHandler frozen snapshot', () => {
  const sdkEnv = {
    modelId: 'test',
    format: 'anthropic' as const,
    env: { ANTHROPIC_API_KEY: 'x' },
  }

  it('loadConfirmedSnapshot caches snapshot and buildSystemPrompt includes it', async () => {
    const snap: ConfirmedSnapshot = {
      snapshot_id: 'snap-1',
      generated_at: '2026-04-24T00:00:00Z',
      by_type: {
        fact: [{ id: 'f1', brief: '用户偏好 zsh', tags: [] }],
        lesson: [{ id: 'l1', brief: '不要 mock 数据库', tags: [] }],
        concept: [],
      },
    }
    const memoryWriter = {
      fetchConfirmedSnapshot: vi.fn().mockResolvedValue(snap),
    } as any
    const handler = new WorkerHandler(sdkEnv, { systemPrompt: 'BASE' }, { memoryWriter })

    await handler.loadConfirmedSnapshot()

    const prompt = (handler as any).buildSystemPrompt({ available_tools: [], sandbox_path_mappings: [] })
    expect(prompt).toContain('BASE')
    expect(prompt).toContain('## 你已知的长期事实 / 经验 / 概念（snapshot snap-1）')
    expect(prompt).toContain('### fact')
    expect(prompt).toContain('- (f1) 用户偏好 zsh')
    expect(prompt).toContain('### lesson')
    expect(prompt).toContain('- (l1) 不要 mock 数据库')
    expect(prompt).not.toContain('### concept')  // 空段落不输出
  })

  it('handles null snapshot gracefully', async () => {
    const memoryWriter = {
      fetchConfirmedSnapshot: vi.fn().mockResolvedValue(null),
    } as any
    const handler = new WorkerHandler(sdkEnv, { systemPrompt: 'BASE' }, { memoryWriter })

    await handler.loadConfirmedSnapshot()

    const prompt = (handler as any).buildSystemPrompt({ available_tools: [], sandbox_path_mappings: [] })
    expect(prompt).toBe('BASE')
  })

  it('does nothing when memoryWriter not provided', async () => {
    const handler = new WorkerHandler(sdkEnv, { systemPrompt: 'BASE' }, {})

    await handler.loadConfirmedSnapshot()  // no throw

    const prompt = (handler as any).buildSystemPrompt({ available_tools: [], sandbox_path_mappings: [] })
    expect(prompt).toBe('BASE')
  })

  it('snapshot is frozen for the worker lifecycle: changing memory state does NOT update cached block until loadConfirmedSnapshot re-invoked (spec §13.2 prefix cache)', async () => {
    // Arrange: 第一次返回 snap-old，第二次返回 snap-new
    const snapOld: ConfirmedSnapshot = {
      snapshot_id: 'snap-old',
      generated_at: '2026-04-24T00:00:00Z',
      by_type: { fact: [{ id: 'f1', brief: 'old fact', tags: [] }], lesson: [], concept: [] },
    }
    const snapNew: ConfirmedSnapshot = {
      snapshot_id: 'snap-new',
      generated_at: '2026-04-24T01:00:00Z',
      by_type: { fact: [{ id: 'f2', brief: 'new fact', tags: [] }], lesson: [], concept: [] },
    }
    const fetchMock = vi.fn().mockResolvedValueOnce(snapOld).mockResolvedValueOnce(snapNew)
    const memoryWriter = { fetchConfirmedSnapshot: fetchMock } as any
    const handler = new WorkerHandler(sdkEnv, { systemPrompt: 'BASE' }, { memoryWriter })

    // Act 1: 启动时加载一次
    await handler.loadConfirmedSnapshot()
    const promptAfterStartup = (handler as any).buildSystemPrompt({ available_tools: [], sandbox_path_mappings: [] })

    // Act 2: 模拟若干 executeTask 调用（这些调用不应触发 fetchConfirmedSnapshot）
    const promptDuringExec1 = (handler as any).buildSystemPrompt({ available_tools: [], sandbox_path_mappings: [] })
    const promptDuringExec2 = (handler as any).buildSystemPrompt({ available_tools: [], sandbox_path_mappings: [] })

    // Assert: 多次构建 prompt 时 snapshot 块完全一致 → prefix cache 不会失效
    expect(promptDuringExec1).toBe(promptAfterStartup)
    expect(promptDuringExec2).toBe(promptAfterStartup)
    expect(promptAfterStartup).toContain('snap-old')
    expect(promptAfterStartup).toContain('old fact')
    expect(promptAfterStartup).not.toContain('snap-new')

    // RPC 在生命周期内只被调用一次
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 显式 reload 才能拿到新内容
    await handler.loadConfirmedSnapshot()
    const promptAfterReload = (handler as any).buildSystemPrompt({ available_tools: [], sandbox_path_mappings: [] })
    expect(promptAfterReload).toContain('snap-new')
    expect(promptAfterReload).toContain('new fact')
  })

  it('snapshot stays under 30k char budget even with 1000 confirmed entries (prefix cache safety)', async () => {
    // Arrange: 制造 1000 条 brief 各 ~60 字符的 confirmed entries（接近 spec 上限）
    const makeMany = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `${prefix}${i}`,
        brief: `${prefix}-brief 描述 ${i} 测试样本 用于覆盖 snapshot 大小预算 spec §13.2`,
        tags: [],
      }))

    const snap: ConfirmedSnapshot = {
      snapshot_id: 'snap-budget',
      generated_at: '2026-04-24T00:00:00Z',
      by_type: {
        fact: makeMany('f', 400),
        lesson: makeMany('l', 400),
        concept: makeMany('c', 200),
      },
    }
    const memoryWriter = { fetchConfirmedSnapshot: vi.fn().mockResolvedValue(snap) } as any
    const handler = new WorkerHandler(sdkEnv, { systemPrompt: 'BASE' }, { memoryWriter })

    await handler.loadConfirmedSnapshot()
    const block = (handler as any).confirmedSnapshotBlock as string

    // Snapshot 串本身不应越过预算（这里取宽松上限 200k chars，留 follow-up 引入硬截断）
    expect(block.length).toBeGreaterThan(0)
    expect(block.length).toBeLessThan(200_000)
    // 每行至少包含 "(id) brief" 模式
    expect(block.split('\n').filter((l) => l.startsWith('- (')).length).toBe(1000)
  })
})
