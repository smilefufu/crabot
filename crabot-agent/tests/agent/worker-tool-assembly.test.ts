/**
 * Worker 工具组装（buildToolsDynamic）集成测试。
 *
 * spec: 2026-08-27-worker-capability-ownership-design.md §6
 * - 所有 legacy Worker 与 direct child 均不装配 crab-memory
 * - scene profile 只在首条 task message 注入，不再进 system prompt
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import type { ExecuteTaskParams, SubAgentConfig, WorkerAgentContext } from '../../src/types.js'
import type { ToolDefinition } from '../../src/engine/types.js'

// Mock the engine's runEngine function
vi.mock('../../src/engine/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    runEngine: vi.fn(),
  }
})

import { runEngine } from '../../src/engine/index.js'
const mockRunEngine = vi.mocked(runEngine)

function makeHandler(options?: ConstructorParameters<typeof AgentHandler>[2]) {
  return new AgentHandler(
    {
      modelId: 'test-model',
      format: 'anthropic' as const,
      env: {
        ANTHROPIC_BASE_URL: 'http://localhost:4000',
        ANTHROPIC_API_KEY: 'test-key',
      },
    },
    { systemPrompt: 'You are a helpful worker.' },
    {
      deps: {
        rpcClient: { call: vi.fn().mockResolvedValue({}) } as never,
        moduleId: 'agent-test',
        resolveChannelPort: async () => 3003,
        getAdminPort: async () => 3001,
        getMemoryPort: async () => 3002,
      },
      ...options,
    },
  )
}

function makeTask(overrides?: Partial<ExecuteTaskParams['task']>): ExecuteTaskParams['task'] {
  return {
    task_id: 'task_1',
    task_title: 'Fix login bug',
    task_type: 'user_request',
    priority: 'high',
    ...overrides,
  }
}

function makeSubAgent(name: string): SubAgentConfig {
  return {
    id: `id-${name}`,
    name,
    description: `desc ${name}`,
    when_to_use: `use ${name}`,
    role: 'r',
    workflow: 'w',
    deliverables: 'd',
    model: { model_id: 'm', endpoint: 'https://x', apikey: 'k', format: 'anthropic' } as never,
    builtin_capabilities: { file_system: true, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
    allowed_mcp_server_ids: [],
    allowed_skill_ids: [],
    max_turns: 10,
  }
}

function makeContext(overrides?: Partial<WorkerAgentContext>): WorkerAgentContext {
  return {
    admin_endpoint: { module_id: 'admin_1', port: 3001 },
    memory_endpoint: { module_id: 'memory_1', port: 3002 },
    channel_endpoints: [{ module_id: 'channel_1', port: 3003 }],
    short_term_memories: [],
    long_term_memories: [],
    available_tools: [],
    time_windows: {
      recent_messages_window_hours: 4,
      short_term_memory_window_hours: 12,
    },
    ...overrides,
  }
}

function makeEngineResult() {
  return {
    outcome: 'completed' as const,
    finalText: 'done',
    totalTurns: 1,
    usage: { inputTokens: 100, outputTokens: 50 },
    finalMessages: [],
    tool_call_count: 0,
    wrote_memory_or_scene: false,
  }
}

async function buildToolsFor(
  handler: AgentHandler,
  params: ExecuteTaskParams,
): Promise<{ tools: ReadonlyArray<ToolDefinition>; systemPrompt: string; prompt: unknown }> {
  await handler.executeTask(params)
  expect(mockRunEngine).toHaveBeenCalledTimes(1)
  const callArgs = mockRunEngine.mock.calls[0][0]
  const tools = (callArgs.options.tools as () => ReadonlyArray<ToolDefinition>)()
  const systemPrompt = (callArgs.options.systemPrompt as () => string)()
  return { tools, systemPrompt, prompt: callArgs.prompt }
}

function memoryToolNames(tools: ReadonlyArray<ToolDefinition>): string[] {
  return tools.filter((t) => t.name.startsWith('mcp__crab-memory__')).map((t) => t.name)
}

describe('buildToolsDynamic 不向 Worker 装配 Memory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunEngine.mockReset()
    mockRunEngine.mockResolvedValue(makeEngineResult())
  })

  const taskCases: Array<[string, Partial<ExecuteTaskParams['task']>]> = [
    ['普通任务', {}],
    ['daily_reflection', { task_type: 'daily_reflection', source: { trigger_type: 'scheduled' } }],
    ['已退役 memory_curate', { task_type: 'memory_curate', tags: ['memory_curate', 'builtin'] }],
    ['memory_rebuild tag', { task_type: undefined, source: { trigger_type: 'manual' }, tags: ['memory_rebuild'] }],
  ]

  it.each(taskCases)('%s 的 Memory 工具集始终为空', async (_label, taskOverrides) => {
    const { tools } = await buildToolsFor(makeHandler(), {
      task: makeTask(taskOverrides),
      context: makeContext(),
    })
    expect(memoryToolNames(tools)).toEqual([])
  })

  it('direct child 的 parentTools 同样没有 Memory，即使旧 profile 仍声明 crab_memory=true', async () => {
    const subAgent = makeSubAgent('writer')
    subAgent.builtin_capabilities.crab_memory = true
    const handler = makeHandler({ subAgents: [subAgent] })
    const spy = vi.spyOn(handler as never, 'makeRunSubAgent' as never)
    await buildToolsFor(handler, {
      task: makeTask({ tags: ['memory_rebuild'] }),
      context: makeContext(),
    })
    expect(spy).toHaveBeenCalled()
    const parentTools = (spy.mock.calls[0][0] as unknown as { parentTools: ReadonlyArray<ToolDefinition> })
      .parentTools
    expect(memoryToolNames(parentTools)).toEqual([])
    expect(parentTools.map((tool) => tool.name)).not.toContain('set_cwd')
  })
})

describe('scene profile 只注入一次（task message）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunEngine.mockReset()
    mockRunEngine.mockResolvedValue(makeEngineResult())
  })

  it('task message 含 <scene_profile>，system prompt 不含', async () => {
    const { systemPrompt, prompt } = await buildToolsFor(makeHandler(), {
      task: makeTask(),
      context: makeContext({
        scene_profile: {
          label: '项目群',
          content: '第一条规则',
          source: {
            scene: { type: 'group_session', channel_id: 'channel_1', session_id: 'session-1' },
          },
        } as never,
      }),
    })
    expect(typeof prompt).toBe('string')
    const promptText = prompt as string
    expect(promptText).toContain('<scene_profile label="项目群">')
    // 只出现一次
    expect(promptText.split('<scene_profile').length - 1).toBe(1)
    // system prompt 不再注入场景画像
    expect(systemPrompt).not.toContain('<scene_profile')
    expect(systemPrompt).not.toContain('第一条规则')
  })
})
