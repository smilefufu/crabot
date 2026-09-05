import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BuiltinSubagentRunner } from '../../src/workers/builtin/subagent-runner.js'
import { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
import type { TraceStore } from '../../src/core/trace-store.js'
import type { LSPManager } from '../../src/lsp/lsp-manager.js'
import type { SkillConfig, SubAgentConfig } from '../../src/types.js'
import type { ToolDefinition } from '../../src/engine/types.js'
import { checkToolPermission } from '../../src/engine/permission-checker.js'
import { BUILTIN_WORKER_PERMISSIONS } from '../../src/workers/builtin/runtime.js'

const { createAdapter, spawnPersistentAgent } = vi.hoisted(() => ({
  createAdapter: vi.fn(),
  spawnPersistentAgent: vi.fn(),
}))

vi.mock('../../src/engine/llm-adapter.js', () => ({ createAdapter }))
vi.mock('../../src/engine/bg-entities/bg-agent.js', () => ({ spawnPersistentAgent }))

function testSubagent(overrides: Partial<SubAgentConfig> = {}): SubAgentConfig {
  return {
    id: 'code-writer',
    name: 'code_writer',
    description: '编写代码',
    when_to_use: '需要实现时使用',
    model: { endpoint: 'https://example.test', apikey: 'test', model_id: 'test-model', format: 'openai' },
    max_turns: 3,
    builtin_capabilities: { file_system: true, shell: true, task_intel: false, crab_memory: false, crab_messaging: false },
    allowed_mcp_server_ids: [],
    allowed_skill_ids: [],
    hook_preset: 'lsp_diagnostics',
    ...overrides,
  } as SubAgentConfig
}

const AVAILABLE_SKILLS: SkillConfig[] = [
  { id: 'skill-a', name: 'skill-a', description: 'A', skill_dir: '/skills/a' },
  { id: 'skill-b', name: 'skill-b', description: 'B', skill_dir: '/skills/b' },
  {
    id: 'builtin-systematic-debugging',
    name: 'systematic-debugging',
    description: 'Debugging',
    skill_dir: '/skills/systematic-debugging',
  },
]

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    call: async () => ({ output: name, isError: false }),
  }
}

function executionContext(availableSkills: ReadonlyArray<SkillConfig> = []) {
  return {
    permissionConfig: { mode: 'bypass' as const },
    resolvedPermissions: BUILTIN_WORKER_PERMISSIONS,
    availableSkills,
    getCwd: () => '/workspace',
  }
}

describe('BuiltinSubagentRunner execution boundary', () => {
  let dir: string
  let registry: BgEntityRegistry
  const lspManager = {} as LSPManager

  beforeEach(async () => {
    vi.clearAllMocks()
    dir = await fs.mkdtemp(join(tmpdir(), 'builtin-subagent-runner-'))
    process.env.DATA_DIR = dir
    registry = new BgEntityRegistry(join(dir, 'registry.json'))
    createAdapter.mockReturnValue({})
  })

  afterEach(async () => {
    delete process.env.DATA_DIR
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('拒绝在 AgentHandler 注入共享 registry 前运行', async () => {
    const runner = new BuiltinSubagentRunner({} as TraceStore, lspManager)
    await expect(runner.recoverAfterRestart()).rejects.toThrow('registry is unavailable')
  })

  it('异步 child 继承 Worker 权限和完整执行 hooks', async () => {
    spawnPersistentAgent.mockResolvedValue('agent-child')
    const runner = new BuiltinSubagentRunner({} as TraceStore, lspManager, undefined, registry)

    await runner.run(
      testSubagent({
        builtin_capabilities: { ...testSubagent().builtin_capabilities, crab_memory: true },
        allowed_skill_ids: ['skill-b'],
      }),
      { task: '运行测试' },
      { worker_subagent: { worker_id: 'worker-1', parent_trace_id: 'trace-parent' } },
      [fakeTool('Skill'), fakeTool('mcp__crab-memory__search_memory')],
      executionContext(AVAILABLE_SKILLS),
    )

    const options = spawnPersistentAgent.mock.calls[0][0]
    expect(options.permissionConfig).toEqual(executionContext().permissionConfig)
    expect(options.resolvedPermissions).toEqual(BUILTIN_WORKER_PERMISSIONS)
    expect(options.senderIsMaster).toBe(false)
    expect(options.lspManager).toBe(lspManager)
    expect(options.tools.map((tool: ToolDefinition) => tool.name)).toEqual(['Skill'])
    expect(options.systemPrompt).toContain('<name>skill-b</name>')
    expect(options.systemPrompt).not.toContain('<name>skill-a</name>')
    expect(options.hookRegistry.getMatching('PreToolUse', { toolName: 'Bash', toolInput: { command: 'crabot config get' } })).toHaveLength(1)
    expect(options.hookRegistry.getMatching('PreToolUse', { toolName: 'Write', toolInput: {} })).toHaveLength(1)
    expect(options.hookRegistry.getMatching('PostToolUse', { toolName: 'Write', toolInput: {} })).toHaveLength(1)
  })

  it('旧输入额外携带 sync=true 也只异步派发，并继承 Worker 权限和完整执行 hooks', async () => {
    spawnPersistentAgent.mockResolvedValue('agent-child')
    const runner = new BuiltinSubagentRunner({} as TraceStore, lspManager, undefined, registry)

    await runner.run(
      testSubagent({
        builtin_capabilities: { ...testSubagent().builtin_capabilities, crab_memory: true },
        allowed_skill_ids: ['skill-a'],
      }),
      { task: '运行测试', context: '保留父上下文', sync: true } as never,
      { worker_subagent: { worker_id: 'worker-1', parent_trace_id: 'trace-parent' } },
      [fakeTool('Skill'), fakeTool('mcp__crab-memory__search_memory')],
      executionContext(AVAILABLE_SKILLS),
    )

    const options = spawnPersistentAgent.mock.calls[0][0]
    expect(options.prompt).toBe('## Parent Context\n保留父上下文\n\n## Your Task\n运行测试')
    expect(options.permissionConfig).toEqual(executionContext().permissionConfig)
    expect(options.resolvedPermissions).toEqual(BUILTIN_WORKER_PERMISSIONS)
    expect(options.senderIsMaster).toBe(false)
    expect(options.lspManager).toBe(lspManager)
    expect(options.tools.map((tool: ToolDefinition) => tool.name)).toEqual(['Skill'])
    expect(options.systemPrompt).toContain('<name>skill-a</name>')
    expect(options.systemPrompt).not.toContain('<name>skill-b</name>')
    expect(options.hookRegistry.getMatching('PreToolUse', { toolName: 'Bash', toolInput: { command: 'crabot config get' } })).toHaveLength(1)
    expect(options.hookRegistry.getMatching('PreToolUse', { toolName: 'Write', toolInput: {} })).toHaveLength(1)
    expect(options.hookRegistry.getMatching('PostToolUse', { toolName: 'Write', toolInput: {} })).toHaveLength(1)
    expect(spawnPersistentAgent).toHaveBeenCalledOnce()
  })

  it('发起人关闭第三方 Skill 时，profile 内置 Skill 仍能在执行期调用', async () => {
    spawnPersistentAgent.mockResolvedValue('agent-child')
    const runner = new BuiltinSubagentRunner({} as TraceStore, lspManager, undefined, registry)
    const restrictedPermissions = {
      ...BUILTIN_WORKER_PERMISSIONS,
      tool_access: { ...BUILTIN_WORKER_PERMISSIONS.tool_access, mcp_skill: false },
    }

    await runner.run(
      testSubagent({ allowed_skill_ids: ['skill-a', 'builtin-systematic-debugging'] }),
      { task: '运行测试' },
      { worker_subagent: { worker_id: 'worker-1', parent_trace_id: 'trace-parent' } },
      [fakeTool('Skill')],
      {
        permissionConfig: { mode: 'denyList', toolNames: ['Skill'] },
        resolvedPermissions: restrictedPermissions,
        availableSkills: AVAILABLE_SKILLS,
        getCwd: () => '/workspace',
      },
    )

    const options = spawnPersistentAgent.mock.calls[0][0]
    const skillTool = options.tools.find((tool: ToolDefinition) => tool.name === 'Skill')
    expect(options.systemPrompt).toContain('<name>systematic-debugging</name>')
    expect(options.systemPrompt).not.toContain('<name>skill-a</name>')
    await expect(checkToolPermission(
      'Skill',
      { skill: 'systematic-debugging' },
      skillTool,
      options.permissionConfig,
    )).resolves.toEqual({ allowed: true })
  })

  it('常规输入与旧 sync 输入都告警并跳过当前不可用的 allowed Skill', async () => {
    spawnPersistentAgent.mockResolvedValue('agent-child')
    const runner = new BuiltinSubagentRunner({} as TraceStore, lspManager, undefined, registry)
    const subagent = testSubagent({ allowed_skill_ids: ['missing-skill'] })
    const context = { worker_subagent: { worker_id: 'worker-1', parent_trace_id: 'trace-parent' } }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(runner.run(
        subagent,
        { task: '异步' },
        context,
        [fakeTool('Skill')],
        executionContext(AVAILABLE_SKILLS),
      )).resolves.toMatchObject({ isError: false })
      await expect(runner.run(
        subagent,
        { task: '旧输入', sync: true } as never,
        context,
        [fakeTool('Skill')],
        executionContext(AVAILABLE_SKILLS),
      )).resolves.toMatchObject({ isError: false })

      expect(spawnPersistentAgent.mock.calls[0][0].tools).toEqual([])
      expect(spawnPersistentAgent.mock.calls[1][0].tools).toEqual([])
      expect(warn).toHaveBeenCalledTimes(2)
      for (const [message] of warn.mock.calls) {
        expect(String(message)).toContain('missing-skill')
      }
    } finally {
      warn.mockRestore()
    }
  })
})

describe('BuiltinSubagentRunner restart recovery', () => {
  it('child trace 用追加式 call/result 保证增量 cursor 不漏结果', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'builtin-subagent-trace-'))
    try {
      const registry = new BgEntityRegistry(join(dir, 'registry.json'))
      await registry.register({
        entity_id: 'agent-child', type: 'agent', status: 'running', trace_id: 'trace-child',
        task_description: '读取文件', messages_log_file: join(dir, 'child.jsonl'), result_file: null,
        owner: { friend_id: '__builtin_worker__', worker_id: 'worker-1' }, spawned_by_task_id: 'worker-1',
        spawned_at: '2026-08-22T00:00:00.000Z', exit_code: null, ended_at: null, last_activity_at: '2026-08-22T00:00:00.000Z',
      })
      const trace = {
        spans: [{
          type: 'tool_call', started_at: '2026-08-22T00:00:01.000Z',
          details: { call_id: 'engine-call', tool_use_id: 'provider-call', tool_name: 'Read', input_summary: '{"path":"a"}' },
        }],
      }
      const traceStore = { getFullTrace: vi.fn(async () => trace) } as unknown as TraceStore
      const runner = new BuiltinSubagentRunner(traceStore, {} as LSPManager, undefined, registry)

      const first = await runner.readTrace('worker-1', 'agent-child')
      expect(first).toMatchObject({
        events: [{
          kind: 'tool_call',
          detail: { call_id: 'engine-call', tool_use_id: 'provider-call', name: 'Read', input: '{"path":"a"}' },
        }],
        nextCursor: { offset: 1 },
      })
      trace.spans.push({
        type: 'tool_result', started_at: '2026-08-22T00:00:02.000Z',
        details: { call_id: 'engine-call', tool_use_id: 'provider-call', output_summary: 'done' },
      })

      await expect(runner.readTrace('worker-1', 'agent-child', first.nextCursor)).resolves.toMatchObject({
        events: [{ kind: 'tool_result', detail: { call_id: 'engine-call', tool_use_id: 'provider-call' } }],
        nextCursor: { offset: 2 },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('marks only Worker-owned running children as interrupted after an Agent restart', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'builtin-subagent-recovery-'))
    try {
      const registry = new BgEntityRegistry(join(dir, 'registry.json'))
      await registry.register({
        entity_id: 'agent-worker-child', type: 'agent', status: 'running',
        subagent_type: 'code_writer', trace_id: 'trace-child', task_description: '实现变更',
        messages_log_file: join(dir, 'child.jsonl'), result_file: null,
        owner: { friend_id: '__builtin_worker__', worker_id: 'worker-1' }, spawned_by_task_id: 'worker-1',
        spawned_at: '2026-08-22T00:00:00.000Z', exit_code: null, ended_at: null, last_activity_at: '2026-08-22T00:00:00.000Z',
      })
      await registry.register({
        entity_id: 'agent-other-owner', type: 'agent', status: 'running',
        task_description: '不属于 Worker', messages_log_file: join(dir, 'other.jsonl'), result_file: null,
        owner: { friend_id: 'friend-1' }, spawned_by_task_id: 'task-1',
        spawned_at: '2026-08-22T00:00:00.000Z', exit_code: null, ended_at: null, last_activity_at: '2026-08-22T00:00:00.000Z',
      })
      const runner = new BuiltinSubagentRunner({} as TraceStore, {} as LSPManager, undefined, registry)

      await expect(runner.recoverAfterRestart()).resolves.toBe(1)
      await expect(runner.list('worker-1')).resolves.toMatchObject([{ subagent_id: 'agent-worker-child', status: 'interrupted' }])
      await expect(registry.get('agent-other-owner')).resolves.toMatchObject({ status: 'running' })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
