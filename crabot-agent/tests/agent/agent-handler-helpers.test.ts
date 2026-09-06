import { describe, it, expect } from 'vitest'
import { extractLaunchedSubagentId, summarizeRunningEntities } from '../../src/agent/agent-handler.js'
import type { BgEntityRecord } from '../../src/engine/bg-entities/types.js'


describe('extractLaunchedSubagentId', () => {
  it('从 delegate_task 异步路径 JSON 输出抓 agent_id', () => {
    const output = JSON.stringify({
      agent_id: 'agent_abc123',
      status: 'launched',
      output_file: null,
    })
    expect(extractLaunchedSubagentId(output)).toBe('agent_abc123')
  })

  it('status 不是 launched 的旧结果返回 undefined', () => {
    const output = JSON.stringify({
      output: 'sync subagent text result',
      outcome: 'completed',
    })
    expect(extractLaunchedSubagentId(output)).toBeUndefined()
  })

  it('agent_id 为空 / 非字符串返回 undefined', () => {
    expect(extractLaunchedSubagentId(JSON.stringify({ status: 'launched', agent_id: '' }))).toBeUndefined()
    expect(extractLaunchedSubagentId(JSON.stringify({ status: 'launched', agent_id: 123 }))).toBeUndefined()
    expect(extractLaunchedSubagentId(JSON.stringify({ status: 'launched' }))).toBeUndefined()
  })

  it('非 JSON 字符串返回 undefined（不抛错）', () => {
    expect(extractLaunchedSubagentId('plain text from old subagent result')).toBeUndefined()
  })

  it('output 是 undefined / 空串时返回 undefined', () => {
    expect(extractLaunchedSubagentId(undefined)).toBeUndefined()
    expect(extractLaunchedSubagentId('')).toBeUndefined()
  })
})

describe('summarizeRunningEntities（唤醒快照数据源，spec 2026-07-16 §6）', () => {
  const NOW = Date.parse('2026-07-16T10:10:00.000Z')

  function shellRec(id: string, taskId: string, spawnedAt: string): BgEntityRecord {
    return {
      entity_id: id,
      type: 'shell',
      status: 'running',
      owner: { friend_id: 'f1' },
      spawned_by_task_id: taskId,
      spawned_at: spawnedAt,
      exit_code: null,
      ended_at: null,
      last_activity_at: spawnedAt,
      command: 'pnpm test --watch',
      log_file: '/tmp/x.log',
      pid: 1,
      pgid: 1,
      process_started_at: spawnedAt,
    }
  }

  function agentRec(id: string, taskId: string, spawnedAt: string): BgEntityRecord {
    return {
      entity_id: id,
      type: 'agent',
      status: 'running',
      owner: { friend_id: 'f1' },
      spawned_by_task_id: taskId,
      spawned_at: spawnedAt,
      exit_code: null,
      ended_at: null,
      last_activity_at: spawnedAt,
      task_description: 'research something',
      messages_log_file: '/tmp/m.jsonl',
      result_file: null,
    }
  }

  it('按 task 过滤 + 排除指定 entity + kind 映射 + runtime 计算', () => {
    const records = [
      agentRec('agent_done', 'task-1', '2026-07-16T10:00:00.000Z'),   // 即将退出的（排除）
      agentRec('agent_live', 'task-1', '2026-07-16T10:05:00.000Z'),
      shellRec('shell_live', 'task-1', '2026-07-16T10:08:00.000Z'),
      shellRec('shell_other_task', 'task-2', '2026-07-16T10:00:00.000Z'),
    ]
    const items = summarizeRunningEntities(records, 'task-1', ['agent_done'], NOW)
    expect(items.map((i) => i.id).sort()).toEqual(['agent_live', 'shell_live'])
    const agent = items.find((i) => i.id === 'agent_live')!
    expect(agent.kind).toBe('subagent')
    expect(agent.runtime_ms).toBe(5 * 60_000)
    expect(agent.description).toBe('research something')
    const shell = items.find((i) => i.id === 'shell_live')!
    expect(shell.kind).toBe('bg_entity')
    expect(shell.description).toBe('pnpm test --watch')
  })

  it('在跑的 goal-audit subagent 被排除——不向 agent 泄漏 audit 存在（PR #31 review）', () => {
    // audit subagent 也以 spawned_by_task_id=parentTaskId 注册 registry（audit-spawn.ts），
    // 快照若包含它 = 重新引入"教 agent 等 audit"的污染源 + 与 targets 准入自相矛盾。
    const records = [
      agentRec('agent_audit', 'task-1', '2026-07-16T10:09:00.000Z'),  // 在跑的 audit
      shellRec('shell_live', 'task-1', '2026-07-16T10:08:00.000Z'),
    ]
    const items = summarizeRunningEntities(records, 'task-1', ['shell_exiting', 'agent_audit'], NOW)
    expect(items.map((i) => i.id)).toEqual(['shell_live'])
  })

  it('无在跑对象 → 空数组', () => {
    expect(summarizeRunningEntities([], 'task-1', [], NOW)).toEqual([])
  })
})
