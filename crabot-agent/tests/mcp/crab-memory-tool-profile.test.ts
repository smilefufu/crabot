/**
 * crab-memory 工具分组 profile 测试。
 *
 * spec: 2026-07-21-agent-token-efficiency-design.md 改动 4（memory 工具按任务用途分组注册）
 * - 普通对话任务 → 仅 A 组 6 个简化工具
 * - daily_reflection / memory_curate / tags 含 memory_rebuild → 全量 18 个（含 B 组 12 个反思级 RPC 工具）
 * - memory_maintenance 不经 Worker，不受影响
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createCrabMemoryServer,
  resolveMemoryToolProfile,
  filterMemoryToolsByProfile,
  CRAB_MEMORY_CONVERSATION_TOOLS,
} from '../../src/mcp/crab-memory.js'
import { mcpServerToToolDefinitions } from '../../src/agent/mcp-tool-bridge.js'
import type { MemoryTaskContext } from '../../src/mcp/crab-memory.js'

const GROUP_A = [
  'store_memory',
  'search_memory',
  'get_memory_detail',
  'set_scene_profile',
  'get_scene_profile',
  'delete_scene_profile',
]

const GROUP_B = [
  'quick_capture',
  'search_long_term',
  'update_long_term',
  'delete_memory',
  'list_recent',
  'list_entries',
  'set_memory_links',
  'run_maintenance',
  'get_stats',
  'get_evolution_mode',
  'set_evolution_mode',
  'promote_to_rule',
]

function makeMemoryTools(rpcCall = vi.fn().mockResolvedValue({})) {
  const ctx: MemoryTaskContext = {
    taskId: 'task_1',
    visibility: 'public',
    scopes: [],
    isMasterPrivate: false,
  }
  const server = createCrabMemoryServer({
    rpcClient: { call: rpcCall } as never,
    moduleId: 'agent-test',
    getMemoryPort: async () => 3002,
  }, ctx)
  return mcpServerToToolDefinitions(server, 'crab-memory')
}

describe('resolveMemoryToolProfile', () => {
  it('daily_reflection → 全量 profile（不再要求 triggerType==scheduled）', () => {
    expect(resolveMemoryToolProfile({ taskType: 'daily_reflection' }))
      .toBe('daily_reflection')
  })

  it('memory_curate（每小时记忆整理）→ 全量 profile', () => {
    // 整理 SKILL 依赖 list_entries / delete_memory / update_long_term 等 B 组工具
    expect(resolveMemoryToolProfile({ taskType: 'memory_curate' }))
      .toBe('daily_reflection')
  })

  it('tags 含 memory_rebuild 的 manual 任务 → 全量 profile', () => {
    // 重建图谱任务 trigger_type=manual、无 task_type，靠 tags 识别
    expect(resolveMemoryToolProfile({ tags: ['memory_rebuild'] }))
      .toBe('daily_reflection')
  })

  it('tags 不含 memory_rebuild 的普通任务 → conversation profile', () => {
    expect(resolveMemoryToolProfile({ taskType: 'user_request', tags: ['builtin'] }))
      .toBe('conversation')
  })

  it('普通消息任务 → conversation profile', () => {
    expect(resolveMemoryToolProfile({ taskType: 'user_request' }))
      .toBe('conversation')
  })

  it('非反思/整理类任务（如 memory_maintenance）→ conversation profile', () => {
    expect(resolveMemoryToolProfile({ taskType: 'memory_maintenance' }))
      .toBe('conversation')
  })

  it('无任务上下文 → conversation profile', () => {
    expect(resolveMemoryToolProfile(null)).toBe('conversation')
  })
})

describe('filterMemoryToolsByProfile', () => {
  it('server 全量注册 18 个工具', () => {
    const tools = makeMemoryTools()
    expect(tools).toHaveLength(18)
    const names = tools.map((t) => t.name.replace('mcp__crab-memory__', ''))
    for (const n of [...GROUP_A, ...GROUP_B]) {
      expect(names).toContain(n)
    }
  })

  it('conversation profile → 仅 A 组 6 个', () => {
    const filtered = filterMemoryToolsByProfile(makeMemoryTools(), 'conversation')
    expect(filtered).toHaveLength(6)
    const names = filtered.map((t) => t.name)
    for (const n of GROUP_A) {
      expect(names).toContain(`mcp__crab-memory__${n}`)
    }
    for (const n of GROUP_B) {
      expect(names).not.toContain(`mcp__crab-memory__${n}`)
    }
  })

  it('daily_reflection profile → 全量 18 个', () => {
    const filtered = filterMemoryToolsByProfile(makeMemoryTools(), 'daily_reflection')
    expect(filtered).toHaveLength(18)
  })

  it('A 组常量与 conversation 过滤结果一致', () => {
    const filtered = filterMemoryToolsByProfile(makeMemoryTools(), 'conversation')
    const names = new Set(filtered.map((t) => t.name.replace('mcp__crab-memory__', '')))
    expect(names).toEqual(CRAB_MEMORY_CONVERSATION_TOOLS)
  })
})

describe('daily_reflection 任务中 B 组工具功能正常', () => {
  it('quick_capture 透传 RPC', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ id: 'mem_1', status: 'inbox' })
    const tools = filterMemoryToolsByProfile(makeMemoryTools(rpcCall), 'daily_reflection')
    const tool = tools.find((t) => t.name === 'mcp__crab-memory__quick_capture')!
    const result = await tool.call(
      { type: 'lesson', brief: 'b', content: 'c' },
      {} as never,
    )
    expect(result.isError).toBe(false)
    expect(rpcCall).toHaveBeenCalledWith(
      3002,
      'quick_capture',
      expect.objectContaining({ type: 'lesson', brief: 'b', content: 'c' }),
      'agent-test',
    )
  })

  it('run_maintenance 透传 RPC', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ ok: true })
    const tools = filterMemoryToolsByProfile(makeMemoryTools(rpcCall), 'daily_reflection')
    const tool = tools.find((t) => t.name === 'mcp__crab-memory__run_maintenance')!
    const result = await tool.call({ scope: 'all' }, {} as never)
    expect(result.isError).toBe(false)
    expect(rpcCall).toHaveBeenCalledWith(
      3002,
      'run_maintenance',
      expect.objectContaining({ scope: 'all' }),
      'agent-test',
    )
  })
})
