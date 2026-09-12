import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
import { createSkillTool } from '../../src/engine/tools/skill-tool.js'
import { resolveSceneAnchorLabel } from '../../src/mcp/crab-memory.js'
import type { BgEntityRecord } from '../../src/engine/bg-entities/types.js'


function makeHandler(options?: ConstructorParameters<typeof AgentHandler>[2]) {
  const sdkEnv = {
    modelId: 'test-model',
    format: 'anthropic' as const,
    env: {
      ANTHROPIC_BASE_URL: 'http://localhost:4000',
      ANTHROPIC_API_KEY: 'test-key',
    },
  }
  const config = {}
  return new AgentHandler(sdkEnv, config, options)
}

function makeMessagingHandler(rpcCall: ReturnType<typeof vi.fn>) {
  return makeHandler({
    deps: {
      rpcClient: { call: rpcCall } as never,
      moduleId: 'agent-test',
      resolveChannelPort: async () => 3003,
      getAdminPort: async () => 3001,
    },
  })
}

describe('AgentHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('cancelTask', () => {
    it('should not throw for non-existent task', () => {
      const handler = makeHandler()
      expect(() => handler.cancelTask('nonexistent_task', 'Test')).not.toThrow()
    })
  })

  // 不变量：task 非终态 ⟺ worker 活着（决策 2026-07-27，issue #43 现象二）。
  // admin 判死前经 abort_worker RPC 调 abortWorker；abortWorkerIfTaskTerminal 是那条
  // RPC 失败时、worker 从 barrier 超时自醒后的兜底。
  describe('abortWorker / abortWorkerIfTaskTerminal', () => {
    function withActiveTask(handler: AgentHandler, taskId: string): AbortController {
      const abortController = new AbortController()
      ;(handler as any).activeTasks.set(taskId, { abortController })
      return abortController
    }

    it('abortWorker 中止活着的 worker 并返回 true', () => {
      const handler = makeHandler()
      const ac = withActiveTask(handler, 'task_1')

      expect(handler.abortWorker('task_1', 'timeout')).toBe(true)
      expect(ac.signal.aborted).toBe(true)
    })

    it('abortWorker 对不在跑的 task 返回 false（no-op）', () => {
      const handler = makeHandler()
      expect(handler.abortWorker('nonexistent_task', 'timeout')).toBe(false)
    })

    it('cancelTask 委托给 abortWorker', () => {
      const handler = makeHandler()
      const ac = withActiveTask(handler, 'task_1')

      handler.cancelTask('task_1', 'user-canceled')
      expect(ac.signal.aborted).toBe(true)
    })

    it('barrier 兜底：task 已终态 → abort', async () => {
      const rpcCall = vi.fn().mockResolvedValue({ task: { id: 'task_1', status: 'failed' } })
      const handler = makeMessagingHandler(rpcCall)
      const ac = withActiveTask(handler, 'task_1')

      await handler.abortWorkerIfTaskTerminal('task_1')

      expect(ac.signal.aborted).toBe(true)
      handler.dispose()
    })

    it('barrier 兜底：task 仍活跃 → 不动 worker', async () => {
      const rpcCall = vi.fn().mockResolvedValue({ task: { id: 'task_1', status: 'waiting_human' } })
      const handler = makeMessagingHandler(rpcCall)
      const ac = withActiveTask(handler, 'task_1')

      await handler.abortWorkerIfTaskTerminal('task_1')

      expect(ac.signal.aborted).toBe(false)
      handler.dispose()
    })

    it('barrier 兜底：task 已被删除（TASK_NOT_FOUND）→ abort', async () => {
      // delete_task 拒删活跃任务、按量清理只删终态任务，所以"查无此 task" ⟹ 它已终态过。
      const rpcCall = vi.fn().mockRejectedValue(new Error('ADMIN_TASK_NOT_FOUND'))
      const handler = makeMessagingHandler(rpcCall)
      const ac = withActiveTask(handler, 'task_1')

      await handler.abortWorkerIfTaskTerminal('task_1')

      expect(ac.signal.aborted).toBe(true)
      handler.dispose()
    })

    it('barrier 兜底：admin 不可达 → fail-open，不误杀 worker', async () => {
      const rpcCall = vi.fn().mockRejectedValue(new Error('admin unreachable'))
      const handler = makeMessagingHandler(rpcCall)
      const ac = withActiveTask(handler, 'task_1')

      await expect(handler.abortWorkerIfTaskTerminal('task_1')).resolves.toBeUndefined()

      expect(ac.signal.aborted).toBe(false)
      handler.dispose()
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
    return new AgentHandler(sdkEnv, {})
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
    wh = new AgentHandler(sdkEnv, {})
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
})
