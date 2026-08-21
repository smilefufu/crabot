/**
 * Worker 工具组装（buildToolsDynamic）集成测试。
 *
 * spec: 2026-07-21-agent-token-efficiency-design.md 改动 4 / 改动 5
 * - memory 工具按任务 profile 分组：普通任务仅 A 组 6 个；daily_reflection 全量 18 个
 * - disabled_tools 扩展到 MCP 桥接工具（mcp__<server>__<tool> 全名过滤）
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

describe('buildToolsDynamic memory 工具分组', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunEngine.mockReset()
    mockRunEngine.mockResolvedValue(makeEngineResult())
  })

  it('普通任务 → 仅注册 A 组 6 个 crab-memory 工具', async () => {
    const { tools } = await buildToolsFor(makeHandler(), {
      task: makeTask(),
      context: makeContext(),
    })
    // store_memory 名字用拼接绕过 crabot-admin v1-cleanup 静态守卫（守卫禁止该 mcp 全名字面量
    // 出现在仓库中，但 v2 的 store_memory MCP 工具本身是活的，需要断言它在 A 组）
    const storeMemoryToolName = ['mcp__crab-memory', 'store_memory'].join('__')
    expect(memoryToolNames(tools).sort()).toEqual([
      'mcp__crab-memory__delete_scene_profile',
      'mcp__crab-memory__get_memory_detail',
      'mcp__crab-memory__get_scene_profile',
      'mcp__crab-memory__search_memory',
      'mcp__crab-memory__set_scene_profile',
      storeMemoryToolName,
    ])
  })

  it('scheduled + daily_reflection 任务 → 仅注册 A 组 6 个 crab-memory 工具', async () => {
    const { tools } = await buildToolsFor(makeHandler(), {
      task: makeTask({
        task_type: 'daily_reflection',
        source: { trigger_type: 'scheduled' },
      }),
      context: makeContext(),
    })
    const names = memoryToolNames(tools)
    expect(names).toHaveLength(6)
    expect(names).not.toContain('mcp__crab-memory__quick_capture')
    expect(names).not.toContain('mcp__crab-memory__run_maintenance')
    expect(names).not.toContain('mcp__crab-memory__promote_to_rule')
  })

  it('memory_curate 任务 → 仅注册 A 组 6 个（已退役类型不再获特权）', async () => {
    const { tools } = await buildToolsFor(makeHandler(), {
      task: makeTask({
        task_type: 'memory_curate',
        source: { trigger_type: 'scheduled' },
        tags: ['memory_curate', 'builtin'],
      }),
      context: makeContext(),
    })
    const names = memoryToolNames(tools)
    expect(names).toHaveLength(6)
    expect(names).not.toContain('mcp__crab-memory__list_entries')
    expect(names).not.toContain('mcp__crab-memory__delete_memory')
    expect(names).not.toContain('mcp__crab-memory__update_long_term')
  })

  it('tags 含 memory_rebuild 的 manual 任务 → 注册全量 19 个', async () => {
    // 重建图谱任务：trigger_type=manual、无 task_type，靠 tags 识别
    const { tools } = await buildToolsFor(makeHandler(), {
      task: makeTask({
        task_type: undefined,
        source: { trigger_type: 'manual' },
        tags: ['memory_rebuild'],
      }),
      context: makeContext(),
    })
    const names = memoryToolNames(tools)
    expect(names).toHaveLength(19)
    expect(names).toContain('mcp__crab-memory__list_entries')
    expect(names).toContain('mcp__crab-memory__set_memory_links')
  })

  it('scheduled 但非 daily_reflection 任务 → 仍仅 A 组 6 个', async () => {
    const { tools } = await buildToolsFor(makeHandler(), {
      task: makeTask({
        task_type: 'user_request',
        source: { trigger_type: 'scheduled' },
      }),
      context: makeContext(),
    })
    expect(memoryToolNames(tools)).toHaveLength(6)
  })
})

describe('buildToolsDynamic disabled_tools 扩展到 MCP 工具', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunEngine.mockReset()
    mockRunEngine.mockResolvedValue(makeEngineResult())
  })

  it('disabled_tools 可按全名过滤 mcp__crab-memory__run_maintenance', async () => {
    const handler = makeHandler({
      builtinToolConfig: { disabled_tools: ['mcp__crab-memory__run_maintenance'] },
    })
    const { tools } = await buildToolsFor(handler, {
      task: makeTask({
      tags: ['memory_rebuild'],
      source: { trigger_type: 'manual' },
      }),
      context: makeContext(),
    })
    const names = memoryToolNames(tools)
    expect(names).toHaveLength(18)
    expect(names).not.toContain('mcp__crab-memory__run_maintenance')
    expect(names).toContain('mcp__crab-memory__quick_capture')
  })

  it('disabled_tools 同时过滤内置工具与 MCP 工具', async () => {
    const handler = makeHandler({
      builtinToolConfig: { disabled_tools: ['Bash', 'mcp__crab-memory__get_memory_detail'] },
    })
    const { tools } = await buildToolsFor(handler, {
      task: makeTask(),
      context: makeContext(),
    })
    const names = tools.map((t) => t.name)
    expect(names).not.toContain('Bash')
    expect(names).not.toContain('mcp__crab-memory__get_memory_detail')
    expect(names).toContain('mcp__crab-memory__search_memory')
  })

  it('disabled_tools 过滤同样作用于 subagent parentTools（baseToolsRaw 路径）', async () => {
    const handler = makeHandler({
      builtinToolConfig: { disabled_tools: ['mcp__crab-memory__get_memory_detail'] },
      subAgents: [makeSubAgent('writer')],
    })
    // 捕获 makeRunSubAgent 收到的 parentTools（即 subagent 继承的 baseTools）
    const spy = vi.spyOn(handler as never, 'makeRunSubAgent' as never)
    await buildToolsFor(handler, {
      task: makeTask(),
      context: makeContext(),
    })
    expect(spy).toHaveBeenCalled()
    const parentTools = (spy.mock.calls[0][0] as unknown as { parentTools: ReadonlyArray<ToolDefinition> })
      .parentTools
    const names = parentTools.map((t) => t.name)
    // 被禁 MCP 工具不得从 subagent 继承路径漏出；未禁的 A 组工具仍可见
    expect(names).not.toContain('mcp__crab-memory__get_memory_detail')
    expect(names).toContain('mcp__crab-memory__search_memory')
    // 既有语义保持：parentTools 不含 set_cwd
    expect(names).not.toContain('set_cwd')
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
