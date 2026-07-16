import { describe, it, expect } from 'vitest'
import {
  extractLaunchedSubagentId,
  maybeCreateWaitForSignalTool,
  summarizeRunningEntities,
} from '../../src/agent/agent-handler.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
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

  it('status 不是 launched（同步路径文字结果）返回 undefined', () => {
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
    expect(extractLaunchedSubagentId('plain text from sync subagent')).toBeUndefined()
  })

  it('output 是 undefined / 空串时返回 undefined', () => {
    expect(extractLaunchedSubagentId(undefined)).toBeUndefined()
    expect(extractLaunchedSubagentId('')).toBeUndefined()
  })
})

describe('maybeCreateWaitForSignalTool', () => {
  const stubDeps = {
    humanQueue: new HumanMessageQueue(),
    listActiveAsyncSubagentIds: () => [] as string[],
    listRunningBgEntities: async () => [],
  }

  it('goalMode + async 都开 → 注入', () => {
    const tool = maybeCreateWaitForSignalTool(
      { goalModeEnabled: true, asyncEnabled: true },
      stubDeps,
    )
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('wait_for_signal')
  })

  it('仅 goalMode 开 → 注入', () => {
    const tool = maybeCreateWaitForSignalTool(
      { goalModeEnabled: true, asyncEnabled: false },
      stubDeps,
    )
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('wait_for_signal')
  })

  it('仅 async 开 → 注入', () => {
    const tool = maybeCreateWaitForSignalTool(
      { goalModeEnabled: false, asyncEnabled: true },
      stubDeps,
    )
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('wait_for_signal')
  })

  it('两者都关 → 仍然注入（门槛已放开，总是注入）', () => {
    const tool = maybeCreateWaitForSignalTool(
      { goalModeEnabled: false, asyncEnabled: false },
      stubDeps,
    )
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('wait_for_signal')
  })

  it('注入的工具透传 deps（listActiveAsyncSubagentIds 真正被调）', async () => {
    let callCount = 0
    const tool = maybeCreateWaitForSignalTool(
      { goalModeEnabled: false, asyncEnabled: true },
      {
        ...stubDeps,
        listActiveAsyncSubagentIds: () => {
          callCount += 1
          return ['agent_x']
        },
      },
    )
    expect(tool).toBeDefined()
    // 触发 tool.call —— 应该看到 listActiveAsyncSubagentIds 被调用
    await tool!.call({ reason: 'test', targets: [{ kind: 'subagent' }] }, {} as never)
    expect(callCount).toBeGreaterThan(0)
    // 清理 barrier（目标存在时 tool.call 会 setBarrier(24h)，否则会泄露 setTimeout）
    stubDeps.humanQueue.clearBarrier()
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
    const items = summarizeRunningEntities(records, 'task-1', 'agent_done', NOW)
    expect(items.map((i) => i.id).sort()).toEqual(['agent_live', 'shell_live'])
    const agent = items.find((i) => i.id === 'agent_live')!
    expect(agent.kind).toBe('subagent')
    expect(agent.runtime_ms).toBe(5 * 60_000)
    expect(agent.description).toBe('research something')
    const shell = items.find((i) => i.id === 'shell_live')!
    expect(shell.kind).toBe('bg_entity')
    expect(shell.description).toBe('pnpm test --watch')
  })

  it('无在跑对象 → 空数组', () => {
    expect(summarizeRunningEntities([], 'task-1', undefined, NOW)).toEqual([])
  })
})
