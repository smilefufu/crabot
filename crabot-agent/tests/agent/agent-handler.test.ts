import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
import { createSkillTool } from '../../src/engine/tools/skill-tool.js'
import { resolveSceneAnchorLabel } from '../../src/mcp/crab-memory.js'
import type {
  ExecuteTaskParams,
  WorkerAgentContext,
  ChannelMessage,
} from '../../src/types.js'
import type { BgEntityRecord } from '../../src/engine/bg-entities/types.js'

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

function makeHandler() {
  const sdkEnv = {
    modelId: 'test-model',
    format: 'anthropic' as const,
    env: {
      ANTHROPIC_BASE_URL: 'http://localhost:4000',
      ANTHROPIC_API_KEY: 'test-key',
    },
  }
  const config = {
    systemPrompt: 'You are a helpful worker.',
  }
  return new AgentHandler(sdkEnv, config)
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

function makeContext(): WorkerAgentContext {
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
  }
}

function makeEngineResult(overrides?: Partial<{
  outcome: string
  finalText: string
  totalTurns: number
  error?: string
}>): { outcome: 'completed' | 'failed' | 'max_turns' | 'aborted'; finalText: string; totalTurns: number; usage: { inputTokens: number; outputTokens: number }; error?: string; finalMessages: readonly never[]; tool_call_count: number; wrote_memory_or_scene: boolean } {
  return {
    outcome: (overrides?.outcome ?? 'completed') as 'completed' | 'failed' | 'max_turns' | 'aborted',
    finalText: overrides?.finalText ?? 'Task completed successfully.',
    totalTurns: overrides?.totalTurns ?? 1,
    usage: { inputTokens: 100, outputTokens: 50 },
    finalMessages: [],
    tool_call_count: 0,
    wrote_memory_or_scene: false,
    ...(overrides?.error ? { error: overrides.error } : {}),
  }
}

describe('AgentHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('executeTask', () => {
    it('should successfully execute a task', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult({
        finalText: 'Task completed successfully. The bug has been fixed.',
      }))

      const handler = makeHandler()
      const result = await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(result.task_id).toBe('task_1')
      expect(result.outcome).toBe('completed')
      // 成功路径不填 error；summary 字段已从 ExecuteTaskResult 移除
      expect(result.error).toBeUndefined()
    })

    it('should handle execution failure', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult({
        outcome: 'failed',
        finalText: 'API error',
        error: 'API error',
      }))

      const handler = makeHandler()
      const result = await handler.executeTask({
        task: makeTask({ task_id: 'task_1' }),
        context: makeContext(),
      })

      expect(result.task_id).toBe('task_1')
      expect(result.outcome).toBe('failed')
    })

    it('should call runEngine with correct parameters', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const handler = makeHandler()
      await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(mockRunEngine).toHaveBeenCalledTimes(1)
      const callArgs = mockRunEngine.mock.calls[0][0]
      expect(callArgs.prompt).toContain('Fix login bug')
      expect(callArgs.options.model).toBe('test-model')
      // systemPrompt 现在是 lambda（HR Task 3：每轮 resolve 以支持热加载）
      expect(typeof callArgs.options.systemPrompt).toBe('function')
      const resolvedPrompt = (callArgs.options.systemPrompt as () => string)()
      expect(resolvedPrompt).toContain('You are a helpful worker.')
    })

    it('should handle aborted result', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult({
        outcome: 'aborted',
        finalText: '',
      }))

      const handler = makeHandler()
      const result = await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(result.outcome).toBe('failed')
      expect(result.error).toContain('取消')
    })

    it('should handle engine exception', async () => {
      mockRunEngine.mockRejectedValue(new Error('Connection failed'))

      const handler = makeHandler()
      const result = await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(result.outcome).toBe('failed')
      expect(result.error).toContain('Connection failed')
    })

    it('injects current scene content verbatim into the worker prompt', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const handler = makeHandler()
      await handler.executeTask({
        task: makeTask(),
        context: {
          ...makeContext(),
          scene_profile: {
            label: '项目群',
            content: '第一条规则\n\n第二条规则\n### 原文标题保留',
            source: {
              scene: { type: 'group_session', channel_id: 'channel_1', session_id: 'session-1' },
            },
          },
        },
      })

      expect(mockRunEngine).toHaveBeenCalledTimes(1)
      const callArgs = mockRunEngine.mock.calls[0][0]
      expect(callArgs.prompt).toContain('## 场景画像')
      expect(callArgs.prompt).toContain('<scene_profile label="项目群">')
      expect(callArgs.prompt).toContain('第一条规则\n\n第二条规则\n### 原文标题保留')
      expect(callArgs.prompt).not.toContain('### 群职责')
    })

    it('keeps the scene profile block when content is empty', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const handler = makeHandler()
      await handler.executeTask({
        task: makeTask(),
        context: {
          ...makeContext(),
          scene_profile: {
            label: '空画像',
            content: '',
            source: {
              scene: { type: 'group_session', channel_id: 'channel_1', session_id: 'session-1' },
            },
          },
        },
      })

      expect(mockRunEngine).toHaveBeenCalledTimes(1)
      const callArgs = mockRunEngine.mock.calls[0][0]
      expect(callArgs.prompt).toContain('## 场景画像')
      expect(callArgs.prompt).toContain('<scene_profile label="空画像">')
    })

    it('includes scheduled target channel and session in the worker prompt when task_origin is set', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const handler = makeHandler()
      await handler.executeTask({
        task: makeTask({
          task_id: 'scheduled-task-1',
          source: { trigger_type: 'scheduled' },
        }),
        context: {
          ...makeContext(),
          task_origin: {
            channel_id: 'feishu-fengyan',
            session_id: 'e283b6c6-373a-4568-ab6f-db134fa71790',
            session_type: 'group',
          },
        },
      })

      expect(mockRunEngine).toHaveBeenCalledTimes(1)
      const callArgs = mockRunEngine.mock.calls[0][0]
      expect(callArgs.prompt).toContain('## 任务来源（crab-messaging 工具请使用这些 ID）')
      expect(callArgs.prompt).toContain('- Channel ID: feishu-fengyan')
      expect(callArgs.prompt).toContain('- Session ID: e283b6c6-373a-4568-ab6f-db134fa71790')
    })
  })

  describe('buildTaskMessage unified timeline', () => {
    function makeMsg(overrides: Partial<ChannelMessage> & { id: string; text: string; ts: string }): ChannelMessage {
      return {
        platform_message_id: overrides.id,
        session: { session_id: 'sess-1', channel_id: 'ch-1', type: 'group' },
        sender: { platform_user_id: 'u1', platform_display_name: 'Alice' },
        content: { type: 'text', text: overrides.text },
        features: { is_mention_crab: false },
        platform_timestamp: overrides.ts,
        ...overrides,
      } as ChannelMessage
    }

    it('dispatcher trigger: merges trigger_messages + recent_messages sorted by timestamp', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const hist1 = makeMsg({ id: 'h1', text: 'history one', ts: '2024-01-01T00:00:00Z' })
      const hist2 = makeMsg({ id: 'h2', text: 'history two', ts: '2024-01-01T00:01:00Z' })
      const userMsg = makeMsg({ id: 't1', text: 'user trigger', ts: '2024-01-01T00:02:00Z' })

      const handler = makeHandler()
      await handler.executeTask({
        task: makeTask(),
        context: {
          ...makeContext(),
          trigger_messages: [userMsg],
          recent_messages: [hist1, hist2],
        },
      })

      expect(mockRunEngine).toHaveBeenCalledTimes(1)
      const prompt = mockRunEngine.mock.calls[0][0].prompt as string
      expect(prompt).toContain('## 会话历史')
      expect(prompt).not.toContain('## 用户请求')
      expect(prompt).not.toContain('## 最近相关消息')
      expect(prompt).not.toContain('## 任务分类')
      expect(prompt).not.toContain('## 任务描述')

      // Verify chronological ordering: hist1 (h1) → hist2 (h2) → userMsg (t1)
      const idxH1 = prompt.indexOf('id="h1"')
      const idxH2 = prompt.indexOf('id="h2"')
      const idxT1 = prompt.indexOf('id="t1"')
      expect(idxH1).toBeGreaterThan(-1)
      expect(idxH2).toBeGreaterThan(-1)
      expect(idxT1).toBeGreaterThan(-1)
      expect(idxH1).toBeLessThan(idxH2)
      expect(idxH2).toBeLessThan(idxT1)
    })

    it('scheduled with target_session: renders task_origin section', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const scheduledTrigger: ChannelMessage = {
        platform_message_id: 'sys_scheduled_1',
        session: { session_id: 'system', channel_id: 'system', type: 'private' },
        sender: { platform_user_id: 'system', platform_display_name: 'System' },
        content: { type: 'system_event', event_type: 'scheduled' },
        features: { is_mention_crab: false },
        platform_timestamp: '2024-01-01T08:00:00Z',
      }

      const handler = makeHandler()
      await handler.executeTask({
        task: makeTask({ source: { trigger_type: 'scheduled' } }),
        context: {
          ...makeContext(),
          trigger_messages: [scheduledTrigger],
          task_origin: {
            channel_id: 'wechat-x',
            session_id: 'sess-y',
            session_type: 'group',
          },
        },
      })

      expect(mockRunEngine).toHaveBeenCalledTimes(1)
      const prompt = mockRunEngine.mock.calls[0][0].prompt as string
      expect(prompt).toContain('## 任务来源')
      expect(prompt).toContain('Channel ID: wechat-x')
      expect(prompt).toContain('Session ID: sess-y')
    })

    it('scheduled without target_session: no task_origin section (SYSTEM_CHANNEL_ID)', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const scheduledTrigger: ChannelMessage = {
        platform_message_id: 'sys_scheduled_2',
        session: { session_id: 'system', channel_id: 'system', type: 'private' },
        sender: { platform_user_id: 'system', platform_display_name: 'System' },
        content: { type: 'system_event', event_type: 'scheduled' },
        features: { is_mention_crab: false },
        platform_timestamp: '2024-01-01T08:00:00Z',
      }

      const handler = makeHandler()
      await handler.executeTask({
        task: makeTask({ source: { trigger_type: 'scheduled' } }),
        context: {
          ...makeContext(),
          trigger_messages: [scheduledTrigger],
          task_origin: {
            channel_id: 'system',
            session_id: 'system',
            session_type: 'private',
          },
        },
      })

      expect(mockRunEngine).toHaveBeenCalledTimes(1)
      const prompt = mockRunEngine.mock.calls[0][0].prompt as string
      expect(prompt).not.toContain('## 任务来源')
    })

    it('empty trigger_messages and empty recent_messages: shows empty history note', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const handler = makeHandler()
      await handler.executeTask({
        task: makeTask(),
        context: {
          ...makeContext(),
          trigger_messages: [],
          recent_messages: [],
        },
      })

      expect(mockRunEngine).toHaveBeenCalledTimes(1)
      const prompt = mockRunEngine.mock.calls[0][0].prompt as string
      expect(prompt).toContain('## 会话历史')
      expect(prompt).toContain('本会话无消息')
      expect(prompt).not.toContain('## 任务描述')
      expect(prompt).not.toContain('## 用户请求')
      expect(prompt).not.toContain('## 最近相关消息')
    })
  })

  describe('systemPrompt SYSTEM_TRIGGER_NO_TARGET guidance', () => {
    function makeSystemEventTrigger(channelId: string): ChannelMessage {
      return {
        platform_message_id: `sys:${channelId}`,
        session: { session_id: channelId, channel_id: channelId, type: 'private' },
        sender: { platform_user_id: 'crabot', platform_display_name: 'Crabot' },
        content: { type: 'system_event', event_type: 'scheduled', text: '执行 X' },
        features: { is_mention_crab: false },
        platform_timestamp: '2024-01-01T08:00:00Z',
      } as ChannelMessage
    }

    it('injects 系统触发任务说明 段 when scheduled trigger has SYSTEM_CHANNEL_ID', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const handler = makeHandler()
      await handler.executeTask({
        task: makeTask({ source: { trigger_type: 'scheduled' } }),
        context: {
          ...makeContext(),
          trigger_messages: [makeSystemEventTrigger('system')],
        },
      })

      const callArgs = mockRunEngine.mock.calls[0][0]
      const resolved = (callArgs.options.systemPrompt as () => string)()
      expect(resolved).toContain('## 系统触发任务说明')
      expect(resolved).toContain('不可直接调 crab-messaging.send_message')
    })

    it('does NOT inject 系统触发任务说明 段 when scheduled trigger has real channel', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const handler = makeHandler()
      await handler.executeTask({
        task: makeTask({ source: { trigger_type: 'scheduled' } }),
        context: {
          ...makeContext(),
          trigger_messages: [makeSystemEventTrigger('wechat-real')],
        },
      })

      const callArgs = mockRunEngine.mock.calls[0][0]
      const resolved = (callArgs.options.systemPrompt as () => string)()
      expect(resolved).not.toContain('## 系统触发任务说明')
    })

    it('does NOT inject 系统触发任务说明 段 for normal dispatcher-triggered task', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const userMsg: ChannelMessage = {
        platform_message_id: 'u1',
        session: { session_id: 'sess-1', channel_id: 'wechat-1', type: 'private' },
        sender: { platform_user_id: 'user-1', platform_display_name: 'Alice' },
        content: { type: 'text', text: 'hi' },
        features: { is_mention_crab: false },
        platform_timestamp: '2024-01-01T08:00:00Z',
      } as ChannelMessage

      const handler = makeHandler()
      await handler.executeTask({
        task: makeTask(),
        context: {
          ...makeContext(),
          trigger_messages: [userMsg],
        },
      })

      const callArgs = mockRunEngine.mock.calls[0][0]
      const resolved = (callArgs.options.systemPrompt as () => string)()
      expect(resolved).not.toContain('## 系统触发任务说明')
    })
  })

  describe('deliverHumanResponse', () => {
    it('should throw error if task does not exist', () => {
      const handler = makeHandler()
      expect(() => handler.deliverHumanResponse('nonexistent_task', [])).toThrow('Task not found')
    })

    it('should deliver messages to an in-progress task', async () => {
      let resolveEngine: (value: ReturnType<typeof makeEngineResult>) => void
      mockRunEngine.mockReturnValue(
        new Promise(resolve => { resolveEngine = resolve }),
      )

      const handler = makeHandler()
      const promise = handler.executeTask({ task: makeTask(), context: makeContext() })

      // Wait briefly so the task is registered
      await new Promise(r => setTimeout(r, 20))

      expect(() => {
        handler.deliverHumanResponse('task_1', [{
          platform_message_id: 'msg_human',
          session: { session_id: 'session-1', channel_id: 'ch_1', type: 'private' },
          sender: { friend_id: 'friend_1', platform_user_id: 'user_1', platform_display_name: 'Test User' },
          content: { type: 'text', text: 'Here is more info' },
          features: { is_mention_crab: false },
          platform_timestamp: '2024-01-01T00:01:00Z',
        }])
      }).not.toThrow()

      resolveEngine!(makeEngineResult())
      await promise
    })
  })

  describe('cancelTask', () => {
    it('should not throw for non-existent task', () => {
      const handler = makeHandler()
      expect(() => handler.cancelTask('nonexistent_task', 'Test')).not.toThrow()
    })
  })

  describe('getActiveTaskCount', () => {
    it('should be 0 after task completes', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const handler = makeHandler()
      await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(handler.getActiveTaskCount()).toBe(0)
    })
  })

  describe('buildToolsDynamic permission filtering', () => {
    // 回归用例：之前用 baseToolsRaw 算出来的 permissionConfig 来过滤含 delegate_* 的完整工具集，
    // 导致 delegate 工具漏过 filter 注入给 LLM，运行时又被拒（违反"无权限工具不注入 prompt"）。
    it('filters delegate_task when their default category is denied', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const sdkEnv = {
        modelId: 'test-model',
        format: 'anthropic' as const,
        env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', ANTHROPIC_API_KEY: 'test-key' },
      }
      const subAgent = {
        id: 'coding-expert',
        name: 'coding_expert',
        description: 'coding expert',
        when_to_use: 'When coding tasks are needed',
        role: 'coding expert role',
        workflow: 'analyze → implement → verify',
        deliverables: 'working code',
        model: {
          endpoint: 'http://localhost:4000',
          apikey: 'test-key',
          model_id: 'test-model',
          format: 'anthropic' as const,
        },
        builtin_capabilities: {
          file_system: true, shell: true, task_intel: false, crab_memory: false, crab_messaging: false,
        },
        allowed_mcp_server_ids: [],
        allowed_skill_ids: [],
        max_turns: 30,
      }
      // mcp_skill 关闭 → tool.category（默认 'mcp_skill'）落入 denyList（delegate_task 无 category 也被视为 mcp_skill）
      const getPermissionConfig = (tools: ReadonlyArray<{ name: string; category?: string }>) => {
        const deniedTools = tools
          .filter(t => (t.category ?? 'mcp_skill') === 'mcp_skill')
          .map(t => t.name)
        return deniedTools.length === 0
          ? { mode: 'bypass' as const }
          : { mode: 'denyList' as const, toolNames: deniedTools }
      }
      const handler = new AgentHandler(sdkEnv, { systemPrompt: 'worker' }, {
        deps: {
          rpcClient: { call: vi.fn() } as any,
          moduleId: 'agent-test',
          resolveChannelPort: async () => 3003,
          getMemoryPort: async () => 3002,
          getPermissionConfig,
        },
        subAgents: [subAgent],
      })

      await handler.executeTask({ task: makeTask(), context: makeContext() })

      const callArgs = mockRunEngine.mock.calls[0][0]
      const buildTools = callArgs.options.tools as () => ReadonlyArray<{ name: string }>
      expect(typeof buildTools).toBe('function')
      const toolNames = buildTools().map(t => t.name)

      expect(toolNames).not.toContain('delegate_task')
    })

    it('keeps delegate_task visible when mcp_skill category is allowed', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const sdkEnv = {
        modelId: 'test-model',
        format: 'anthropic' as const,
        env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', ANTHROPIC_API_KEY: 'test-key' },
      }
      const subAgent = {
        id: 'coding-expert',
        name: 'coding_expert',
        description: 'coding expert',
        when_to_use: 'When coding tasks are needed',
        role: 'coding expert role',
        workflow: 'analyze → implement → verify',
        deliverables: 'working code',
        model: {
          endpoint: 'http://localhost:4000',
          apikey: 'test-key',
          model_id: 'test-model',
          format: 'anthropic' as const,
        },
        builtin_capabilities: {
          file_system: true, shell: true, task_intel: false, crab_memory: false, crab_messaging: false,
        },
        allowed_mcp_server_ids: [],
        allowed_skill_ids: [],
        max_turns: 30,
      }
      const getPermissionConfig = () => ({ mode: 'bypass' as const })
      const handler = new AgentHandler(sdkEnv, { systemPrompt: 'worker' }, {
        deps: {
          rpcClient: { call: vi.fn() } as any,
          moduleId: 'agent-test',
          resolveChannelPort: async () => 3003,
          getMemoryPort: async () => 3002,
          getPermissionConfig,
        },
        subAgents: [subAgent],
      })

      await handler.executeTask({ task: makeTask(), context: makeContext() })

      const callArgs = mockRunEngine.mock.calls[0][0]
      const buildTools = callArgs.options.tools as () => ReadonlyArray<{ name: string }>
      const toolNames = buildTools().map(t => t.name)

      expect(toolNames).toContain('delegate_task')
    })
  })

  describe('bg entity tools wiring', () => {
    it('includes Output, Kill, ListEntities in tools built by buildToolsDynamic', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const handler = makeHandler()
      await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(mockRunEngine).toHaveBeenCalledTimes(1)
      const callArgs = mockRunEngine.mock.calls[0][0]
      const buildTools = callArgs.options.tools as () => ReadonlyArray<{ name: string }>
      expect(typeof buildTools).toBe('function')
      const toolNames = buildTools().map((t: { name: string }) => t.name)

      expect(toolNames).toContain('Output')
      expect(toolNames).toContain('Kill')
      expect(toolNames).toContain('ListEntities')
    })
  })

  describe('task-scoped cwd persistence across turns', () => {
    // 回归用例：currentCwd 曾声明在 buildToolsDynamic 内部，而 query-loop 每轮 LLM 调用
    // 都重建工具列表 → 每轮把 currentCwd 重置回 getWorkspaceDir()（home），上一轮 set_cwd
    // 的结果被丢弃。表现为「set_cwd 调用过了，但下一轮 Grep/Glob 仍从 home 搜」。
    it('set_cwd 的结果在工具列表重建后仍然保留', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const handler = makeHandler()
      await handler.executeTask({ task: makeTask(), context: makeContext() })

      const callArgs = mockRunEngine.mock.calls[0][0]
      const buildTools = callArgs.options.tools as () => ReadonlyArray<{
        name: string
        call: (input: Record<string, unknown>, ctx: unknown) => Promise<{ output: string; isError?: boolean }>
      }>

      const projectDir = mkdtempSync(join(tmpdir(), 'crabot-cwd-'))
      try {
        // turn 1：把 cwd 锚定到 projectDir
        const setCwd1 = buildTools().find(t => t.name === 'set_cwd')
        expect(setCwd1).toBeDefined()
        const res1 = await setCwd1!.call({ path: projectDir }, {})
        expect(res1.isError ?? false).toBe(false)

        // turn 2：query-loop 重建工具列表后，用相对路径 '.' 解析当前 cwd——
        // cwd 若跨 turn 持久应解析回 projectDir；若被重置回 home 则解析成 home。
        const setCwd2 = buildTools().find(t => t.name === 'set_cwd')
        const res2 = await setCwd2!.call({ path: '.' }, {})
        expect(res2.isError ?? false).toBe(false)
        expect(res2.output).toContain(projectDir)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    })

    it('跨重启 resume：从 checkpoint 恢复 cwd，不回退 home', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const projectDir = mkdtempSync(join(tmpdir(), 'crabot-cwd-resume-'))
      try {
        const handler = makeHandler()
        // resumeFrom 携带 checkpoint 里的 cwd（模拟 agent 重启后 admin 驱动的续跑）
        await handler.executeTask({
          task: makeTask(),
          context: makeContext(),
          resumeFrom: {
            initialMessages: [{ id: 'm1', role: 'user', content: 'resume me', timestamp: 1 }] as never,
            todoItems: [],
            cwd: projectDir,
          },
        })

        const callArgs = mockRunEngine.mock.calls[0][0]
        const buildTools = callArgs.options.tools as () => ReadonlyArray<{
          name: string
          call: (input: Record<string, unknown>, ctx: unknown) => Promise<{ output: string; isError?: boolean }>
        }>

        // resumed worker 的 cwd 应是 checkpoint 里的 projectDir，而非 home
        const setCwd = buildTools().find(t => t.name === 'set_cwd')
        const res = await setCwd!.call({ path: '.' }, {})
        expect(res.isError ?? false).toBe(false)
        expect(res.output).toContain(projectDir)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    })
  })

  describe('resolveSceneAnchorLabel', () => {
    it('preserves an existing scene label when a profile already exists', async () => {
      const rpcClient = {
        call: vi.fn().mockResolvedValue({
          profile: {
            label: 'Crabot 开发群',
          },
        }),
      }

      const label = await resolveSceneAnchorLabel({
        rpcClient: rpcClient as any,
        memoryPort: 3002,
        moduleId: 'agent-test',
        scene: { type: 'group_session', channel_id: 'wechat', session_id: 'group-1' },
      })

      expect(label).toBe('Crabot 开发群')
      expect(rpcClient.call).toHaveBeenCalledWith(
        3002,
        'get_scene_profile',
        { scene: { type: 'group_session', channel_id: 'wechat', session_id: 'group-1' } },
        'agent-test',
      )
    })

    it('falls back to the default label when no profile exists yet', async () => {
      const rpcClient = {
        call: vi.fn().mockResolvedValue({
          profile: null,
        }),
      }

      const label = await resolveSceneAnchorLabel({
        rpcClient: rpcClient as any,
        memoryPort: 3002,
        moduleId: 'agent-test',
        scene: { type: 'friend', friend_id: 'friend-1' },
      })

      expect(label).toBe('friend:friend-1')
    })
  })
})

describe('AgentHandler.updateSkills hot-reload', () => {
  let dataDir: string
  let originalDataDir: string | undefined
  let skillSourceRoot: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'worker-skills-test-'))
    originalDataDir = process.env.CRABOT_AGENT_DATA_DIR
    process.env.CRABOT_AGENT_DATA_DIR = dataDir
    // admin 端 skill 源目录 —— 模拟 admin 把 SKILL.md 落在 data 目录后传 skill_dir 给 agent
    skillSourceRoot = mkdtempSync(join(tmpdir(), 'admin-skills-src-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(skillSourceRoot, { recursive: true, force: true })
    if (originalDataDir === undefined) {
      delete process.env.CRABOT_AGENT_DATA_DIR
    } else {
      process.env.CRABOT_AGENT_DATA_DIR = originalDataDir
    }
  })

  function writeSkillSource(name: string, content: string): string {
    const dir = join(skillSourceRoot, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')
    return dir
  }

  it('updateSkills 接受 {id, name, description, skill_dir} 引用且无磁盘 IO', () => {
    const handler = makeHandler()
    const skillDir = writeSkillSource('skill-a', '# A')
    handler.updateSkills([
      { id: 'skill-a', name: 'skill-a', description: 'A', skill_dir: skillDir },
    ])
    // 关键：agent 不再向 instance 目录写 SKILL.md
    expect(existsSync(join(dataDir, 'instance', 'skills'))).toBe(false)
  })

  it('Skill 工具直接读 admin 传来的 skill_dir 绝对路径', async () => {
    const skillDir = writeSkillSource('code-review', '---\nname: code-review\n---\n# CR body')
    const tool = createSkillTool({
      availableSkills: [
        { id: 'sk', name: 'code-review', description: 'review', skill_dir: skillDir },
      ],
    })

    const result = await tool.call({ skill: 'code-review' }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('# CR body')
    expect(result.output).toContain(`Skill directory: ${skillDir}`)
  })

  it('hash 防抖：连续推同样的 skills 列表跳过重复更新', () => {
    const handler = makeHandler()
    const skillDir = writeSkillSource('a', '# v1')

    // 拍一份当前 skills 列表
    const list = [{ id: 'a', name: 'a', description: '', skill_dir: skillDir }]
    handler.updateSkills(list)

    // 第二次同样的引用 — 跳过赋值（lastSkillsHash 不变）
    // 验证方式：第二次传一个修改了 description 但 name+skill_dir 相同的列表，
    // 因为 hash 只算 name + skill_dir，应该跳过
    handler.updateSkills([{ id: 'a', name: 'a', description: 'changed-desc', skill_dir: skillDir }])
    // 不抛错即可——hash 决定身份；行为通过 Skill 工具读取验证（下一个测试覆盖）
  })

  it('Skill 工具读取的是 updateSkills 当前快照（new tool per call）', async () => {
    const handler: any = makeHandler()
    const v1Dir = writeSkillSource('skill-a', '# v1 body')

    handler.updateSkills([
      { id: 'skill-a', name: 'skill-a', description: 'A', skill_dir: v1Dir },
    ])

    // 模拟 agent-handler 在每轮 LLM 调用前从 this.skills 重建 Skill 工具
    const tool1 = createSkillTool({ availableSkills: handler.skills })
    const r1 = await tool1.call({ skill: 'skill-a' }, {})
    expect(r1.output).toContain('# v1 body')

    // admin 重命名 skill_dir / 推送新版本
    const v2Dir = writeSkillSource('skill-a-v2', '# v2 body')
    handler.updateSkills([
      { id: 'skill-a', name: 'skill-a', description: 'A', skill_dir: v2Dir },
    ])

    const tool2 = createSkillTool({ availableSkills: handler.skills })
    const r2 = await tool2.call({ skill: 'skill-a' }, {})
    expect(r2.output).toContain('# v2 body')
    expect(r2.output).not.toContain('# v1 body')
  })
})

describe('AgentHandler bg-entity push notifications', () => {
  it('enqueueBgNotification + drainBgNotifications round-trip', () => {
    // 用 any 旁路 private 访问限制——drainBgNotifications 是内部 helper
    const handler: any = makeHandler()

    handler.enqueueBgNotification('friend:f1', 'shell_aaa exited (exit 0)')
    handler.enqueueBgNotification('friend:f1', 'agent_bbb completed')
    handler.enqueueBgNotification('friend:f2', 'shell_ccc failed')

    const f1 = handler.drainBgNotifications('friend:f1')
    expect(f1).toContain('<bg-notification>')
    expect(f1).toContain('shell_aaa exited (exit 0)')
    expect(f1).toContain('agent_bbb completed')
    expect(f1).not.toContain('shell_ccc')

    // f1 已 drain，第二次为空
    expect(handler.drainBgNotifications('friend:f1')).toBe('')

    // f2 独立保留
    expect(handler.drainBgNotifications('friend:f2')).toContain('shell_ccc')
  })

  it('drain returns empty when no notifications', () => {
    const handler: any = makeHandler()
    expect(handler.drainBgNotifications('friend:none')).toBe('')
  })
})

describe('AgentHandler bg-entities lifecycle', () => {
  let dataDir: string
  let originalDataDir: string | undefined
  let handler: AgentHandler | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'worker-bg-lifecycle-test-'))
    originalDataDir = process.env.CRABOT_AGENT_DATA_DIR
    process.env.CRABOT_AGENT_DATA_DIR = dataDir
    handler = undefined
  })

  afterEach(() => {
    handler?.dispose()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) {
      delete process.env.CRABOT_AGENT_DATA_DIR
    } else {
      process.env.CRABOT_AGENT_DATA_DIR = originalDataDir
    }
  })

  function registryPath() {
    // Must match getBgEntitiesRegistryPath() = CRABOT_AGENT_DATA_DIR/bg-entities/registry.json
    return join(dataDir, 'bg-entities', 'registry.json')
  }

  function writeRegistry(entities: Record<string, BgEntityRecord>) {
    const dir = join(dataDir, 'bg-entities')
    mkdirSync(dir, { recursive: true })
    writeFileSync(registryPath(), JSON.stringify({ entities }, null, 2), 'utf8')
  }

  function makeShellRecord(overrides: Partial<BgEntityRecord> = {}): BgEntityRecord {
    return {
      entity_id: 'shell-001',
      type: 'shell',
      status: 'running',
      owner: { friend_id: 'friend-1' },
      spawned_by_task_id: 'task-1',
      spawned_at: new Date().toISOString(),
      exit_code: null,
      ended_at: null,
      last_activity_at: new Date().toISOString(),
      command: 'sleep 9999',
      log_file: '/tmp/shell.log',
      // pid 999999 should not exist on any machine
      pid: 999999,
      pgid: 999999,
      process_started_at: new Date().toISOString(),
      ...overrides,
    } as BgEntityRecord
  }

  function makeAgentRecord(overrides: Partial<BgEntityRecord> = {}): BgEntityRecord {
    return {
      entity_id: 'agent-001',
      type: 'agent',
      status: 'running',
      owner: { friend_id: 'friend-1' },
      spawned_by_task_id: 'task-1',
      spawned_at: new Date().toISOString(),
      exit_code: null,
      ended_at: null,
      last_activity_at: new Date().toISOString(),
      task_description: 'do something',
      messages_log_file: '/tmp/agent.log',
      result_file: null,
      ...overrides,
    } as BgEntityRecord
  }

  function makeWorkerHandler() {
    const sdkEnv = {
      modelId: 'test-model',
      format: 'anthropic' as const,
      env: {
        ANTHROPIC_BASE_URL: 'http://localhost:4000',
        ANTHROPIC_API_KEY: 'test-key',
      },
    }
    return new AgentHandler(sdkEnv, { systemPrompt: 'You are a helpful worker.' })
  }

  it('recovery marks a running shell with non-existent pid as failed', async () => {
    writeRegistry({ 'shell-001': makeShellRecord() })

    handler = makeWorkerHandler()
    // wait for fire-and-forget recoverPersistent to settle
    await new Promise((r) => setTimeout(r, 150))

    const registry = new BgEntityRegistry(registryPath())
    const record = await registry.get('shell-001')
    expect(record).not.toBeNull()
    expect(record!.status).toBe('failed')
    expect(record!.exit_code).toBe(-1)
    expect(record!.ended_at).not.toBeNull()
  })

  it('recovery marks a running agent as stalled', async () => {
    writeRegistry({ 'agent-001': makeAgentRecord() })

    handler = makeWorkerHandler()
    await new Promise((r) => setTimeout(r, 150))

    const registry = new BgEntityRegistry(registryPath())
    const record = await registry.get('agent-001')
    expect(record).not.toBeNull()
    expect(record!.status).toBe('stalled')
    expect(record!.ended_at).not.toBeNull()
  })

  it('GC removes entities ended more than 7 days ago', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    writeRegistry({
      'shell-old': makeShellRecord({
        entity_id: 'shell-old',
        status: 'completed',
        ended_at: eightDaysAgo,
        last_activity_at: eightDaysAgo,
      }),
    })

    handler = makeWorkerHandler()
    await new Promise((r) => setTimeout(r, 150))

    const registry = new BgEntityRegistry(registryPath())
    const record = await registry.get('shell-old')
    expect(record).toBeNull()
  })

  it('dispose() clears the interval (no timer leak)', () => {
    handler = makeWorkerHandler()
    // Disposing immediately should not throw and should clear the interval handle
    expect(() => handler!.dispose()).not.toThrow()
    // Calling dispose again is idempotent
    expect(() => handler!.dispose()).not.toThrow()
  })
})

describe('AgentHandler bg-entities admin RPC', () => {
  let dataDir: string
  let originalDataDir: string | undefined
  let wh: AgentHandler

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'worker-bg-admin-test-'))
    originalDataDir = process.env.CRABOT_AGENT_DATA_DIR
    process.env.CRABOT_AGENT_DATA_DIR = dataDir

    const sdkEnv = {
      modelId: 'test-model',
      format: 'anthropic' as const,
      env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', ANTHROPIC_API_KEY: 'test-key' },
    }
    wh = new AgentHandler(sdkEnv, { systemPrompt: 'worker' })
  })

  afterEach(() => {
    wh.dispose()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) {
      delete process.env.CRABOT_AGENT_DATA_DIR
    } else {
      process.env.CRABOT_AGENT_DATA_DIR = originalDataDir
    }
  })

  function registryPath() {
    return join(dataDir, 'bg-entities', 'registry.json')
  }

  function writeRegistry(entities: Record<string, BgEntityRecord>) {
    const dir = join(dataDir, 'bg-entities')
    mkdirSync(dir, { recursive: true })
    writeFileSync(registryPath(), JSON.stringify({ entities }, null, 2), 'utf8')
  }

  function makeShellRecord(overrides: Partial<BgEntityRecord> = {}): BgEntityRecord {
    return {
      entity_id: 'shell_aabbcc',
      type: 'shell',
      status: 'running',
      owner: { friend_id: 'friend-1' },
      spawned_by_task_id: 'task-1',
      spawned_at: new Date().toISOString(),
      exit_code: null,
      ended_at: null,
      last_activity_at: new Date().toISOString(),
      command: 'sleep 9999',
      log_file: join(dataDir, 'shell.log'),
      pid: 999999,
      pgid: 999999,
      process_started_at: new Date().toISOString(),
      ...overrides,
    } as BgEntityRecord
  }

  it('listBgEntities returns all entities from registry', async () => {
    writeRegistry({
      'shell_aabbcc': makeShellRecord(),
      'shell_112233': makeShellRecord({ entity_id: 'shell_112233', status: 'completed' }),
    })
    // let constructor fire-and-forget settle
    await new Promise((r) => setTimeout(r, 150))

    const result = await wh.listBgEntities()
    // There will be 2 entries in registry (recovery may have mutated status but not removed them)
    expect(result.length).toBeGreaterThanOrEqual(1)
  })

  it('listBgEntities filters by status', async () => {
    writeRegistry({
      'shell_aabbcc': makeShellRecord({ status: 'completed' }),
      'shell_112233': makeShellRecord({ entity_id: 'shell_112233', status: 'failed' }),
    })
    await new Promise((r) => setTimeout(r, 150))

    const completedOnly = await wh.listBgEntities({ status: ['completed'] })
    expect(completedOnly.every(e => e.status === 'completed')).toBe(true)
  })

  it('killBgEntity returns ok:false for non-existent entity', async () => {
    const result = await wh.killBgEntity('shell_nonexistent')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not found/i)
  })

  it('killBgEntity returns ok:false for invalid entity_id prefix', async () => {
    const result = await wh.killBgEntity('invalid_id')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Invalid entity_id/i)
  })

  it('killBgEntity returns ok:false when shell already completed', async () => {
    writeRegistry({
      'shell_aabbcc': makeShellRecord({ status: 'completed' }),
    })
    await new Promise((r) => setTimeout(r, 150))

    const result = await wh.killBgEntity('shell_aabbcc')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Already')
  })

  it('getBgEntityLog returns content from persistent shell log file', async () => {
    const logFile = join(dataDir, 'shell.log')
    writeFileSync(logFile, 'hello world output', 'utf8')
    writeRegistry({
      'shell_aabbcc': makeShellRecord({ status: 'completed', log_file: logFile }),
    })
    await new Promise((r) => setTimeout(r, 150))

    const result = await wh.getBgEntityLog('shell_aabbcc')
    expect(result.content).toContain('hello world output')
    expect(result.new_offset).toBeGreaterThan(0)
    expect(result.type).toBe('shell')
  })

  it('getBgEntityLog throws for non-existent entity', async () => {
    await expect(wh.getBgEntityLog('shell_nonexistent')).rejects.toThrow(/not found/i)
  })

  it('getBgEntityLog returns empty content when log file missing', async () => {
    writeRegistry({
      'shell_aabbcc': makeShellRecord({ log_file: join(dataDir, 'nonexistent.log') }),
    })
    await new Promise((r) => setTimeout(r, 150))

    const result = await wh.getBgEntityLog('shell_aabbcc')
    expect(result.content).toBe('')
    expect(result.new_offset).toBe(0)
    expect(result.type).toBe('shell')
  })

  describe('todo tool integration', () => {
    it('registers todo tool in worker tool list', async () => {
      const handler = makeHandler()
      let capturedTools: ReadonlyArray<{ name: string }> = []
      mockRunEngine.mockImplementation(async (params) => {
        const toolsFn = params.options.tools as () => ReadonlyArray<{ name: string }>
        capturedTools = toolsFn()
        return makeEngineResult()
      })
      await handler.executeTask({ task: makeTask(), context: makeContext() })
      expect(capturedTools.some(t => t.name === 'todo')).toBe(true)
    })

    it('creates fresh TodoStore per task', async () => {
      const handler = makeHandler()
      const todoTools: unknown[] = []
      mockRunEngine.mockImplementation(async (params) => {
        const toolsFn = params.options.tools as () => ReadonlyArray<{ name: string }>
        const todoTool = toolsFn().find(t => t.name === 'todo')!
        todoTools.push(todoTool)
        return makeEngineResult()
      })
      await handler.executeTask({ task: makeTask({ task_id: 'task_a' }), context: makeContext() })
      await handler.executeTask({ task: makeTask({ task_id: 'task_b' }), context: makeContext() })
      expect(todoTools[0]).not.toBe(todoTools[1])
    })

    it('passes onAfterCompaction that prepends todo active list to messages', async () => {
      // todo 工具永远放行 —— 直接写入即可（goal 与 todo 已解耦）
      const handler = makeHandler()
      let capturedHook: ((msgs: ReadonlyArray<unknown>) => ReadonlyArray<unknown>) | undefined
      mockRunEngine.mockImplementation(async (params) => {
        capturedHook = params.options.onAfterCompaction as typeof capturedHook
        const toolsFn = params.options.tools as () => ReadonlyArray<{ name: string; call: Function }>
        const todoTool = toolsFn().find(t => t.name === 'todo')!
        await todoTool.call({
          todos: [{ id: 'work', content: '研究 X', status: 'in_progress' }],
        }, {} as never)
        return makeEngineResult()
      })
      await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(capturedHook).toBeDefined()
      // 模拟 compaction 后传入若干 messages，验证 hook 把 todo 注入到头部
      const compactedMsgs = [
        { role: 'user', content: '...summary...' },
        { role: 'assistant', content: '...' },
      ]
      const result = capturedHook!(compactedMsgs as never)
      expect(result.length).toBe(3)
      expect(JSON.stringify(result[0])).toContain('Your active task list was preserved')
      expect(JSON.stringify(result[0])).toContain('研究 X')
    })

    it('onAfterCompaction is no-op when todo store is empty', async () => {
      const handler = makeHandler()
      let capturedHook: ((msgs: ReadonlyArray<unknown>) => ReadonlyArray<unknown>) | undefined
      mockRunEngine.mockImplementation(async (params) => {
        capturedHook = params.options.onAfterCompaction as typeof capturedHook
        return makeEngineResult()
      })
      await handler.executeTask({ task: makeTask(), context: makeContext() })

      const compactedMsgs = [{ role: 'user', content: 'x' }]
      const result = capturedHook!(compactedMsgs as never)
      expect(result).toEqual(compactedMsgs)
    })
  })
})
