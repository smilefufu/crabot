/**
 * subagent model 热生效（delegate 时实时解析）测试。
 *
 * spec: 2026-07-19-subagent-model-hot-reload-design.md
 *
 * 语义不变量：
 * 1. in-flight worker loop 内，updateSubagents（admin push model_config）后，
 *    delegate_task 派发用 live 列表里的新 model 建 adapter —— 不重启、不等下个 loop。
 * 2. delegate_task 的 enum（subagent 列表）仍是 loop 启动时快照 —— 列表一致性不受热更影响。
 * 3. loop 运行期间 subagent 被从 live 列表删除 → 派发回退用快照，不报错。
 * 4. 异步派发（spawnPersistentAgent）同样取 live model。
 * 5. goal_audit 的 buildSpawnDeps 每次 spawn 时取 live auditor model。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import type { SubAgentConfig, ExecuteTaskParams, WorkerAgentContext } from '../../src/types.js'

vi.mock('../../src/engine/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, runEngine: vi.fn() }
})

vi.mock('../../src/engine/sub-agent.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, forkEngine: vi.fn() }
})

vi.mock('../../src/engine/bg-entities/bg-agent.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, spawnPersistentAgent: vi.fn() }
})

vi.mock('../../src/agent/end-turn-gate.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, createAsyncAuditEndTurnGate: vi.fn() }
})

import { runEngine } from '../../src/engine/index.js'
import { forkEngine } from '../../src/engine/sub-agent.js'
import { spawnPersistentAgent } from '../../src/engine/bg-entities/bg-agent.js'
import { createAsyncAuditEndTurnGate } from '../../src/agent/end-turn-gate.js'

const mockRunEngine = vi.mocked(runEngine)
const mockForkEngine = vi.mocked(forkEngine)
const mockSpawnPersistentAgent = vi.mocked(spawnPersistentAgent)
const mockCreateGate = vi.mocked(createAsyncAuditEndTurnGate)

function makeSdkEnv() {
  return {
    modelId: 'test-model',
    format: 'anthropic' as const,
    env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', ANTHROPIC_API_KEY: 'k' },
  }
}

function makeSubAgent(name: string, modelTag: 'old' | 'new'): SubAgentConfig {
  return {
    id: `id-${name}`,
    name,
    description: `desc ${name}`,
    when_to_use: `use ${name}`,
    role: 'r',
    workflow: 'w',
    deliverables: 'd',
    model: {
      model_id: `${modelTag}-model`,
      endpoint: `https://${modelTag}.example.com`,
      apikey: `${modelTag}-key`,
      format: 'anthropic',
    } as never,
    builtin_capabilities: { file_system: true, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
    allowed_mcp_server_ids: [],
    allowed_skill_ids: [],
    max_turns: 10,
  }
}

function makeTask(): ExecuteTaskParams['task'] {
  return {
    task_id: 't1', task_title: 'demo', task_description: 'demo', task_type: 'user_request', priority: 'normal',
  }
}

function makeContext(): WorkerAgentContext {
  return {
    admin_endpoint: { module_id: 'admin', port: 1 },
    memory_endpoint: { module_id: 'memory', port: 2 },
    channel_endpoints: [{ module_id: 'channel', port: 3 }],
    short_term_memories: [], long_term_memories: [], available_tools: [],
    time_windows: { recent_messages_window_hours: 4, short_term_memory_window_hours: 12 },
  }
}

function getDelegateTool(options: any) {
  const tools = (options.tools as () => ReadonlyArray<any>)()
  return tools.find((t) => t.name === 'delegate_task')
}

/** forkEngine 收到的 adapter 是 AnthropicAdapter，私有字段 config 存了 endpoint/apikey。 */
function adapterEndpoint(call: any): { endpoint: string; apikey: string } {
  const cfg = (call.adapter as any).config
  return { endpoint: cfg.endpoint, apikey: cfg.apikey }
}

describe('subagent model 热生效（delegate 时实时解析）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockForkEngine.mockImplementation(async () => ({
      outcome: 'completed', output: 'ok', totalTurns: 1,
    }) as never)
  })

  it('in-flight loop 内 updateSubagents 后，delegate_task 用新 model 建 adapter；enum 仍是快照', async () => {
    const handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'sys' }, {
      subAgents: [makeSubAgent('code_writer', 'old')],
    })

    mockRunEngine.mockImplementation(async (params: any) => {
      const dt = getDelegateTool(params.options)
      const enumBefore = dt.inputSchema.properties.subagent_type.enum

      // 第一次派发：loop 快照里的旧 model
      await dt.call({ subagent_type: 'code_writer', task: 'first' }, {})

      // 模拟 admin push model_config 热更（同 id/name，换 provider）
      handler.updateSubagents([makeSubAgent('code_writer', 'new')])

      const enumAfter = getDelegateTool(params.options).inputSchema.properties.subagent_type.enum
      // 列表不变量：enum 仍来自 loop 启动时快照
      expect(enumBefore).toEqual(['code_writer'])
      expect(enumAfter).toEqual(['code_writer'])

      // 第二次派发：应取 live 的新 model
      await dt.call({ subagent_type: 'code_writer', task: 'second' }, {})

      return {
        outcome: 'completed', finalText: 'ok', totalTurns: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        finalMessages: [],
      } as never
    })

    await handler.executeTask({ task: makeTask(), context: makeContext() })

    expect(mockForkEngine).toHaveBeenCalledTimes(2)
    const first = mockForkEngine.mock.calls[0][0] as any
    const second = mockForkEngine.mock.calls[1][0] as any
    expect(first.model).toBe('old-model')
    expect(adapterEndpoint(first)).toEqual({ endpoint: 'https://old.example.com', apikey: 'old-key' })
    // 核心语义断言：第二次派发用新 provider 的 model/endpoint/apikey
    expect(second.model).toBe('new-model')
    expect(adapterEndpoint(second)).toEqual({ endpoint: 'https://new.example.com', apikey: 'new-key' })
  })

  it('loop 运行期间 subagent 被删除 → 派发回退用快照，不报错', async () => {
    const handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'sys' }, {
      subAgents: [makeSubAgent('code_writer', 'old')],
    })

    mockRunEngine.mockImplementation(async (params: any) => {
      // admin 把 code_writer 从 subagents 里删了
      handler.updateSubagents([])

      const dt = getDelegateTool(params.options)
      // enum 快照里还有 code_writer，LLM 仍可能派发它
      const result = await dt.call({ subagent_type: 'code_writer', task: 'still works' }, {})
      expect(result.isError).not.toBe(true)

      return {
        outcome: 'completed', finalText: 'ok', totalTurns: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        finalMessages: [],
      } as never
    })

    await handler.executeTask({ task: makeTask(), context: makeContext() })

    expect(mockForkEngine).toHaveBeenCalledTimes(1)
    const call = mockForkEngine.mock.calls[0][0] as any
    expect(call.model).toBe('old-model')
    expect(adapterEndpoint(call).endpoint).toBe('https://old.example.com')
  })

  it('loop 运行期间同名 subagent 被删除再重建（新 id）→ 派发用重建后的新配置', async () => {
    const handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'sys' }, {
      subAgents: [makeSubAgent('code_writer', 'old')],
    })

    mockRunEngine.mockImplementation(async (params: any) => {
      // admin 删除再重建同名 subagent：id 变了（重建），配置也换了
      const recreated = { ...makeSubAgent('code_writer', 'new'), id: 'id-code_writer-recreated' }
      handler.updateSubagents([recreated])

      const dt = getDelegateTool(params.options)
      await dt.call({ subagent_type: 'code_writer', task: 'after recreate' }, {})

      return {
        outcome: 'completed', finalText: 'ok', totalTurns: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        finalMessages: [],
      } as never
    })

    await handler.executeTask({ task: makeTask(), context: makeContext() })

    // name 匹配语义：同名重建视为同一 subagent 换配置，派发用新配置而非静默回退旧快照
    expect(mockForkEngine).toHaveBeenCalledTimes(1)
    const call = mockForkEngine.mock.calls[0][0] as any
    expect(call.model).toBe('new-model')
    expect(adapterEndpoint(call).endpoint).toBe('https://new.example.com')
  })

  it('异步派发（spawnPersistentAgent）同样取 live model', async () => {
    const snapshotEntry = makeSubAgent('code_writer', 'old')
    const handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'sys' }, {
      subAgents: [snapshotEntry],
    })
    handler.updateSubagents([makeSubAgent('code_writer', 'new')])

    mockSpawnPersistentAgent.mockImplementation(async () => 'agent_test1' as never)

    const runSubAgent = (handler as any).makeRunSubAgent({
      parentTools: [],
      parentTaskId: 't1',
      callerLabel: 'test',
      humanQueue: new HumanMessageQueue(),
      asyncEnabled: true,
      asyncCtx: { owner: { friend_id: 'f1', session_id: 's1' } },
    })
    // delegate_task 闭包传进来的是 loop 快照里的旧 entry
    await runSubAgent(snapshotEntry, { task: 'async job' }, {})

    expect(mockSpawnPersistentAgent).toHaveBeenCalledTimes(1)
    const spawnOpts = mockSpawnPersistentAgent.mock.calls[0][0] as any
    expect(spawnOpts.model).toBe('new-model')
    expect((spawnOpts.adapter as any).config.endpoint).toBe('https://new.example.com')
    expect((spawnOpts.adapter as any).config.apikey).toBe('new-key')
  })

  it('goal_audit buildSpawnDeps 每次 spawn 时取 live auditor model', async () => {
    const auditorOld = { ...makeSubAgent('goal_auditor', 'old'), id: 'builtin-goal-auditor', system_only: true }
    const auditorNew = { ...makeSubAgent('goal_auditor', 'new'), id: 'builtin-goal-auditor', system_only: true }

    const handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'sys' }, {
      subAgents: [auditorOld],
      deps: {
        rpcClient: {} as never,
        moduleId: 'agent',
        resolveChannelPort: async () => 1,
        getMemoryPort: async () => 2,
        getAdminPort: async () => 1,
      },
    })

    let capturedDeps: any
    mockCreateGate.mockImplementation(((deps: any) => {
      capturedDeps = deps
      return async () => null
    }) as never)

    ;(handler as any).buildAsyncAuditEndTurnGate({
      goalModeEnabled: true,
      goalSetCacheGetter: () => true,
      taskId: 't1',
      taskState: {} as never,
      subAgents: [auditorOld], // loop 启动时快照
      getAuditBaseTools: () => [],
      getAuditPermissionConfig: () => undefined,
      humanQueue: new HumanMessageQueue(),
      cwd: '/tmp',
      owner: { friend_id: 'f1', session_id: 's1' },
      getConversationLog: () => [],
    })

    const goal = { objective: 'obj', acceptance_criteria: [] }

    const firstSpawn = capturedDeps.buildSpawnDeps(goal)
    expect((firstSpawn.adapter as any).config.endpoint).toBe('https://old.example.com')

    // admin push 热更 auditor model 后再 spawn audit → 用新配置
    handler.updateSubagents([auditorNew])
    const secondSpawn = capturedDeps.buildSpawnDeps(goal)
    expect((secondSpawn.adapter as any).config.endpoint).toBe('https://new.example.com')
    expect((secondSpawn.adapter as any).config.apikey).toBe('new-key')
    expect(secondSpawn.auditor.model.model_id).toBe('new-model')
  })
})
