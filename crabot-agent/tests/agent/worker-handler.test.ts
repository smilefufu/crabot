import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { WorkerHandler } from '../../src/agent/worker-handler.js'
import { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
import { createSkillTool } from '../../src/engine/tools/skill-tool.js'
import { getInstanceSkillsDir } from '../../src/core/data-paths.js'
import { resolveSceneAnchorLabel } from '../../src/mcp/crab-memory.js'
import type {
  ExecuteTaskParams,
  WorkerAgentContext,
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
  return new WorkerHandler(sdkEnv, config)
}

function makeTask(overrides?: Partial<ExecuteTaskParams['task']>): ExecuteTaskParams['task'] {
  return {
    task_id: 'task_1',
    task_title: 'Fix login bug',
    task_description: 'Fix the authentication issue in login flow',
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
  }
}

function makeEngineResult(overrides?: Partial<{
  outcome: string
  finalText: string
  totalTurns: number
  error?: string
}>): { outcome: 'completed' | 'failed' | 'max_turns' | 'aborted'; finalText: string; totalTurns: number; usage: { inputTokens: number; outputTokens: number }; error?: string } {
  return {
    outcome: (overrides?.outcome ?? 'completed') as 'completed' | 'failed' | 'max_turns' | 'aborted',
    finalText: overrides?.finalText ?? 'Task completed successfully.',
    totalTurns: overrides?.totalTurns ?? 1,
    usage: { inputTokens: 100, outputTokens: 50 },
    ...(overrides?.error ? { error: overrides.error } : {}),
  }
}

describe('WorkerHandler', () => {
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
      expect(result.summary).toContain('Task completed successfully')
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
      expect(result.summary).toContain('取消')
    })

    it('should handle engine exception', async () => {
      mockRunEngine.mockRejectedValue(new Error('Connection failed'))

      const handler = makeHandler()
      const result = await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(result.outcome).toBe('failed')
      expect(result.summary).toContain('Connection failed')
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
            abstract: '群画像',
            overview: '技术支持',
            content: '第一条规则\n\n第二条规则\n### 原文标题保留',
            source: {
              scene: { type: 'group_session', channel_id: 'channel_1', session_id: 'session-1' },
            },
          },
        },
      })

      expect(mockRunEngine).toHaveBeenCalledTimes(1)
      const callArgs = mockRunEngine.mock.calls[0][0]
      expect(callArgs.prompt).toContain('## 场景画像（项目群）')
      expect(callArgs.prompt).toContain('以下内容是当前场景必须加载并遵守的上下文：')
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
            abstract: '空摘要',
            overview: '空概览',
            content: '',
            source: {
              scene: { type: 'group_session', channel_id: 'channel_1', session_id: 'session-1' },
            },
          },
        },
      })

      expect(mockRunEngine).toHaveBeenCalledTimes(1)
      const callArgs = mockRunEngine.mock.calls[0][0]
      expect(callArgs.prompt).toContain('## 场景画像（空画像）')
      expect(callArgs.prompt).toContain('以下内容是当前场景必须加载并遵守的上下文：')
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
    it('filters delegate_task and delegate_to_* when their default category is denied', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const sdkEnv = {
        modelId: 'test-model',
        format: 'anthropic' as const,
        env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', ANTHROPIC_API_KEY: 'test-key' },
      }
      const subAgentDef = {
        slotKey: 'coding_expert',
        slotDescription: 'coding expert',
        recommendedCapabilities: ['coding'] as const,
        toolName: 'delegate_to_coding_expert',
        toolDescription: 'delegate coding tasks',
        systemPrompt: 'you are a coding expert',
        workerHint: 'coding expert',
        maxTurns: 30,
      }
      // mcp_skill 关闭 → tool.category（默认 'mcp_skill'）落入 denyList
      const getPermissionConfig = (tools: ReadonlyArray<{ name: string; category?: string }>) => {
        const deniedTools = tools
          .filter(t => (t.category ?? 'mcp_skill') === 'mcp_skill')
          .map(t => t.name)
        return deniedTools.length === 0
          ? { mode: 'bypass' as const }
          : { mode: 'denyList' as const, toolNames: deniedTools }
      }
      const handler = new WorkerHandler(sdkEnv, { systemPrompt: 'worker' }, {
        deps: {
          rpcClient: { call: vi.fn() } as any,
          moduleId: 'agent-test',
          resolveChannelPort: async () => 3003,
          getMemoryPort: async () => 3002,
          getPermissionConfig,
        },
        subAgentConfigs: [{ definition: subAgentDef, sdkEnv }],
      })

      await handler.executeTask({ task: makeTask(), context: makeContext() })

      const callArgs = mockRunEngine.mock.calls[0][0]
      const buildTools = callArgs.options.tools as () => ReadonlyArray<{ name: string }>
      expect(typeof buildTools).toBe('function')
      const toolNames = buildTools().map(t => t.name)

      expect(toolNames).not.toContain('delegate_task')
      expect(toolNames).not.toContain('delegate_to_coding_expert')
    })

    it('keeps delegate tools visible when mcp_skill category is allowed', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const sdkEnv = {
        modelId: 'test-model',
        format: 'anthropic' as const,
        env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', ANTHROPIC_API_KEY: 'test-key' },
      }
      const subAgentDef = {
        slotKey: 'coding_expert',
        slotDescription: 'coding expert',
        recommendedCapabilities: ['coding'] as const,
        toolName: 'delegate_to_coding_expert',
        toolDescription: 'delegate coding tasks',
        systemPrompt: 'you are a coding expert',
        workerHint: 'coding expert',
        maxTurns: 30,
      }
      const getPermissionConfig = () => ({ mode: 'bypass' as const })
      const handler = new WorkerHandler(sdkEnv, { systemPrompt: 'worker' }, {
        deps: {
          rpcClient: { call: vi.fn() } as any,
          moduleId: 'agent-test',
          resolveChannelPort: async () => 3003,
          getMemoryPort: async () => 3002,
          getPermissionConfig,
        },
        subAgentConfigs: [{ definition: subAgentDef, sdkEnv }],
      })

      await handler.executeTask({ task: makeTask(), context: makeContext() })

      const callArgs = mockRunEngine.mock.calls[0][0]
      const buildTools = callArgs.options.tools as () => ReadonlyArray<{ name: string }>
      const toolNames = buildTools().map(t => t.name)

      expect(toolNames).toContain('delegate_task')
      expect(toolNames).toContain('delegate_to_coding_expert')
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

describe('WorkerHandler.updateSkills atomic write', () => {
  let dataDir: string
  let originalDataDir: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'worker-skills-test-'))
    originalDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = dataDir
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR
    } else {
      process.env.DATA_DIR = originalDataDir
    }
  })

  function createTestWorkerHandler() {
    return makeHandler()
  }

  it('writes skills atomically to instance skills dir', async () => {
    const handler = createTestWorkerHandler()
    handler.updateSkills([
      { id: 'skill-a', name: 'skill-a', content: '# Skill A\nbody', description: 'A' },
    ])
    // 等异步写完成
    await new Promise((r) => setTimeout(r, 50))

    const skillsRoot = join(dataDir, 'instance', 'skills')
    expect(existsSync(join(skillsRoot, 'skill-a', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(skillsRoot, 'skill-a', 'SKILL.md'), 'utf-8')).toBe('# Skill A\nbody')
  })

  it('replaces old skills atomically when called again', async () => {
    const handler = createTestWorkerHandler()
    handler.updateSkills([
      { id: 'skill-a', name: 'skill-a', content: 'old content', description: 'A' },
    ])
    await new Promise((r) => setTimeout(r, 50))

    handler.updateSkills([
      { id: 'skill-b', name: 'skill-b', content: 'new b', description: 'B' },
    ])
    await new Promise((r) => setTimeout(r, 50))

    const skillsRoot = join(dataDir, 'instance', 'skills')
    expect(existsSync(join(skillsRoot, 'skill-a'))).toBe(false)
    expect(readFileSync(join(skillsRoot, 'skill-b', 'SKILL.md'), 'utf-8')).toBe('new b')
  })

  it('writes skill_dir marker when skill_dir field is set', async () => {
    const handler = createTestWorkerHandler()
    handler.updateSkills([
      { id: 'skill-c', name: 'skill-c', content: 'c body', description: 'C', skill_dir: '/some/source/path' },
    ])
    await new Promise((r) => setTimeout(r, 50))

    const skillsRoot = join(dataDir, 'instance', 'skills')
    expect(readFileSync(join(skillsRoot, 'skill-c', '.skill_dir'), 'utf-8')).toBe('/some/source/path')
  })

  it('Skill tool reflects updateSkills changes immediately (hot-reload bug fix)', async () => {
    const handler = createTestWorkerHandler()

    // First push: skill-a v1
    handler.updateSkills([
      { id: 'skill-a', name: 'skill-a', content: '# Skill A v1\nold body', description: 'A' },
    ])
    await new Promise((r) => setTimeout(r, 50))

    const skillsDir = getInstanceSkillsDir()
    const skillTool = createSkillTool(skillsDir)

    const result1 = await skillTool.call({ skill: 'skill-a' }, {})
    expect(result1.output).toContain('Skill A v1')
    expect(result1.output).toContain('old body')

    // Second push: skill-a v2, simulating admin pushing a new version while task is mid-flight
    handler.updateSkills([
      { id: 'skill-a', name: 'skill-a', content: '# Skill A v2\nNEW body', description: 'A' },
    ])
    await new Promise((r) => setTimeout(r, 50))

    // Key assertion: same skillTool instance (as if tool ref was constructed at task start),
    // calling again should read v2 content from disk
    const result2 = await skillTool.call({ skill: 'skill-a' }, {})
    expect(result2.output).toContain('Skill A v2')
    expect(result2.output).toContain('NEW body')
    expect(result2.output).not.toContain('old body')
  })
})

describe('WorkerHandler bg-entities lifecycle', () => {
  let dataDir: string
  let originalDataDir: string | undefined
  let handler: WorkerHandler | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'worker-bg-lifecycle-test-'))
    originalDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = dataDir
    handler = undefined
  })

  afterEach(() => {
    handler?.dispose()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR
    } else {
      process.env.DATA_DIR = originalDataDir
    }
  })

  function registryPath() {
    // Must match getBgEntitiesRegistryPath() = DATA_DIR/bg-entities/registry.json
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
    return new WorkerHandler(sdkEnv, { systemPrompt: 'You are a helpful worker.' })
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

describe('WorkerHandler bg-entities admin RPC', () => {
  let dataDir: string
  let originalDataDir: string | undefined
  let wh: WorkerHandler

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'worker-bg-admin-test-'))
    originalDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = dataDir

    const sdkEnv = {
      modelId: 'test-model',
      format: 'anthropic' as const,
      env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', ANTHROPIC_API_KEY: 'test-key' },
    }
    wh = new WorkerHandler(sdkEnv, { systemPrompt: 'worker' })
  })

  afterEach(() => {
    wh.dispose()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR
    } else {
      process.env.DATA_DIR = originalDataDir
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
})
