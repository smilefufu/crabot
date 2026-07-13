/**
 * 集成测：runWorkerLoop in-flight 期间调 updateSubagents，loop 内的
 * systemPrompt callback 仍用 loop 启动时 snapshot 的 subagents。
 *
 * 这是 FuFu 2026-05-21 提出的"in-flight 用旧配置直到结束"期望的核心保证：
 * - admin 改 subagents → handler.updateSubagents(new) 改 this.subAgents
 * - 但已经在跑的 worker loop 不感知，每轮 LLM call 重建 system prompt 时
 *   读的是 loop 启动时 snapshot 的旧 list
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import type { SubAgentConfig, ExecuteTaskParams, WorkerAgentContext } from '../../src/types.js'

vi.mock('../../src/engine/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, runEngine: vi.fn() }
})

import { runEngine } from '../../src/engine/index.js'
const mockRunEngine = vi.mocked(runEngine)

function makeSdkEnv() {
  return {
    modelId: 'test-model',
    format: 'anthropic' as const,
    env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', ANTHROPIC_API_KEY: 'k' },
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

/** 从 mock runEngine 拿到的 options 里抽 delegate_task 工具的 subagent_type.enum */
function getDelegateEnums(options: any): string[] {
  const tools = (options.tools as () => ReadonlyArray<{ name: string; inputSchema: any }>)()
  const dt = tools.find((t) => t.name === 'delegate_task')
  if (!dt) return []
  return (dt.inputSchema?.properties?.subagent_type?.enum ?? []) as string[]
}

describe('updateSubagents during in-flight worker loop', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('loop 启动后 updateSubagents，loop 内 delegate_task enum 仍只看到旧 subagents', async () => {
    const handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'sys' }, {
      subAgents: [makeSubAgent('old_writer')],
    })

    let firstEnums: string[] = []
    let secondEnums: string[] = []

    mockRunEngine.mockImplementation(async (params: any) => {
      firstEnums = getDelegateEnums(params.options)                  // 启动时第一轮 build
      handler.updateSubagents([makeSubAgent('new_writer')])           // 模拟 admin push
      secondEnums = getDelegateEnums(params.options)                  // 第二轮 LLM call 前重新 build
      return {
        outcome: 'completed', finalText: 'ok', totalTurns: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        finalMessages: [],
      } as never
    })

    await handler.executeTask({ task: makeTask(), context: makeContext() })

    // 关键断言：两次都拿到 snapshot 的旧 list
    expect(firstEnums).toEqual(['old_writer'])
    expect(secondEnums).toEqual(['old_writer'])
  })

  it('updateSubagents 后启动的新 loop 用新 subagents', async () => {
    const handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'sys' }, {
      subAgents: [makeSubAgent('old_writer')],
    })

    let capturedEnums: string[] = []
    mockRunEngine.mockImplementation(async (params: any) => {
      capturedEnums = getDelegateEnums(params.options)
      return {
        outcome: 'completed', finalText: 'ok', totalTurns: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        finalMessages: [],
      } as never
    })

    handler.updateSubagents([makeSubAgent('new_writer'), makeSubAgent('researcher')])
    await handler.executeTask({ task: makeTask(), context: makeContext() })

    expect(capturedEnums).toEqual(['new_writer', 'researcher'])
  })

  it('updateSdkEnv 后启动的新 loop 用新 modelId', async () => {
    const handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'sys' })

    handler.updateSdkEnv({
      modelId: 'new-model',
      format: 'anthropic',
      env: { ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_API_KEY: 'k' },
    })

    let capturedModel = ''
    mockRunEngine.mockImplementation(async (params: any) => {
      capturedModel = String(params.options.model)
      return {
        outcome: 'completed', finalText: 'ok', totalTurns: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        finalMessages: [],
      } as never
    })

    await handler.executeTask({ task: makeTask(), context: makeContext() })
    expect(capturedModel).toBe('new-model')
  })

  it('updateTmpPageBaseUrl 后启动的新 loop 把地址注入 system prompt', async () => {
    const handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'sys' })
    handler.updateTmpPageBaseUrl('https://pages.example.com')

    let capturedPrompt = ''
    mockRunEngine.mockImplementation(async (params: any) => {
      const systemPrompt = params.options.systemPrompt
      capturedPrompt = typeof systemPrompt === 'function' ? systemPrompt() : String(systemPrompt)
      return {
        outcome: 'completed', finalText: 'ok', totalTurns: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        finalMessages: [],
      } as never
    })

    await handler.executeTask({ task: makeTask(), context: makeContext() })

    expect(capturedPrompt).toContain('临时页面对外地址: https://pages.example.com')
    expect(capturedPrompt).toContain('你的 task_id: t1')
  })
})
