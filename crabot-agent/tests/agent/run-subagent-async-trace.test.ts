/**
 * runSubAgentAsync —— 异步 delegate_task 子 agent 必须建自己的 sub_agent_call 子 trace。
 *
 * 与 audit 同一回归：异步路径走 spawnPersistentAgent，若不传 subTrace 配置，
 * 子 agent 就不在 Admin Traces 页显示。这里在模块边界 mock spawnPersistentAgent，
 * 验证 runSubAgentAsync 把 traceConfig 转成 subTrace 透传下去。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { spawnSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn(async (_opts: Record<string, unknown>) => 'agent_async123'),
}))
vi.mock('../../src/engine/bg-entities/bg-agent.js', () => ({
  spawnPersistentAgent: spawnSpy,
}))

import { AgentHandler } from '../../src/agent/agent-handler.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import type { SubAgentConfig } from '../../src/types.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter.js'

function makeSubagent(): SubAgentConfig {
  return {
    id: 'builtin-research',
    name: 'research_collector',
    description: 'General investigator',
    when_to_use: '需要调查时',
    role: 'researcher',
    workflow: 'investigate',
    deliverables: 'report',
    model: {
      endpoint: 'https://example.test',
      apikey: 'test-key',
      model_id: 'test-model',
      format: 'anthropic',
    },
    builtin_capabilities: {
      file_system: true,
      shell: false,
      task_intel: false,
      crab_memory: false,
      crab_messaging: false,
    },
    allowed_mcp_server_ids: [],
    allowed_skill_ids: [],
    max_turns: 20,
  }
}

function makeHandler(): AgentHandler {
  return new AgentHandler(
    { modelId: 'test-model', format: 'anthropic' as const, env: {} },
    { systemPrompt: 'worker' },
    {
      deps: {
        rpcClient: { call: vi.fn() } as unknown as import('crabot-shared').RpcClient,
        moduleId: 'agent-test',
        resolveChannelPort: async () => 3003,
        getMemoryPort: async () => 3002,
        getAdminPort: async () => 19000,
      },
      subAgents: [makeSubagent()],
    },
  )
}

function fakeAdapter(): LLMAdapter {
  return { async *stream() {}, updateConfig() {} } as unknown as LLMAdapter
}

describe('runSubAgentAsync child trace', () => {
  beforeEach(() => { spawnSpy.mockClear() })

  it('forwards subTrace built from traceConfig so async delegate shows in Traces 页 (regression)', async () => {
    const handler = makeHandler()
    await (handler as unknown as {
      runSubAgentAsync: (s: SubAgentConfig, i: unknown, a: unknown, d: unknown) => Promise<unknown>
    }).runSubAgentAsync(
      makeSubagent(),
      { task: 'investigate X' },
      { owner: { friend_id: 'f-1', session_id: 's-1' }, adapter: fakeAdapter() },
      {
        parentTools: [],
        parentTaskId: 'task-9',
        humanQueue: new HumanMessageQueue(),
        traceConfig: {
          traceStore: {} as never,
          parentTraceId: 'parent-trace-9',
          relatedTaskId: 'task-9',
        },
      },
    )

    expect(spawnSpy).toHaveBeenCalledOnce()
    const opts = spawnSpy.mock.calls[0][0] as Record<string, unknown>
    const subTrace = opts.subTrace as Record<string, unknown> | undefined
    expect(subTrace).toBeDefined()
    expect(subTrace!.parentTraceId).toBe('parent-trace-9')
    expect(subTrace!.relatedTaskId).toBe('task-9')
    expect(subTrace!.summaryPrefix).toBe('[research_collector]')
  })

  it('no traceConfig → no subTrace (透明，不强建 trace)', async () => {
    const handler = makeHandler()
    await (handler as unknown as {
      runSubAgentAsync: (s: SubAgentConfig, i: unknown, a: unknown, d: unknown) => Promise<unknown>
    }).runSubAgentAsync(
      makeSubagent(),
      { task: 'investigate X' },
      { owner: { friend_id: 'f-1', session_id: 's-1' }, adapter: fakeAdapter() },
      {
        parentTools: [],
        parentTaskId: 'task-9',
        humanQueue: new HumanMessageQueue(),
      },
    )

    expect(spawnSpy).toHaveBeenCalledOnce()
    const opts = spawnSpy.mock.calls[0][0] as Record<string, unknown>
    expect(opts.subTrace).toBeUndefined()
  })
})
