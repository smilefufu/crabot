import { describe, it, expect } from 'vitest'

import { filterMcpServersForWorker, mcpCategoryFor } from '../../src/agent/mcp-connector.js'
import { UnifiedAgent } from '../../src/unified-agent.js'
import type { AgentLayerConfig, MCPServerConfig, ResolvedPermissions } from '../../src/types.js'
import type { ManagerStack } from '../../src/manager/bootstrap.js'
import type {
  AdapterCapabilities,
  CapabilityBundle,
  DetectResult,
  IncarnationHandle,
  IncarnationRef,
  SpawnSpec,
  WorkerAdapter,
  WorkerContractState,
  WorkerImplId,
  Workspace,
} from '../../src/workers/types.js'
import { makeAgentConfig, useTmpDataDir } from '../inbound/harness.js'
import { TMP_PAGE_BRIDGE_ENV, TMP_PAGE_MCP_SERVER_NAME } from '../../src/workers/capability-policy.js'

const servers: MCPServerConfig[] = [
  { name: 'git', command: 'git-mcp', env: { GIT_MCP_TOKEN: 'secret' } },
  { name: 'computer-use', command: 'computer-use-mcp' },
]

const mainlineSkills = [
  { id: 'tmp-page', name: 'tmp-page', description: 'tmp page', skill_dir: '/tmp/skills/tmp-page' },
  {
    id: 'workspace-context-maintenance',
    name: 'workspace-context-maintenance',
    description: 'workspace context',
    skill_dir: '/tmp/skills/workspace-context-maintenance',
  },
]

function permissions(overrides: Partial<ResolvedPermissions['tool_access']>): ResolvedPermissions {
  return {
    tool_access: { memory: true, messaging: false, task: false, mcp_skill: true, file_io: true, browser: true, shell: true, remote_exec: false, desktop: false, ...overrides },
    cli_access: { provider: 'none', agent: 'none', mcp: 'none', skill: 'none', schedule: 'none', channel: 'none', friend: 'none', permission: 'none', config: 'none', undo: 'none' },
    storage: null,
    memory_scopes: [],
  }
}

/** 只替换 adapter 载体；capability provider、bootstrap、harness 与 workspace/ledger 均走生产真件。 */
class RecordingAdapter implements WorkerAdapter {
  readonly provisionCalls: Array<{ ws: Workspace; caps: CapabilityBundle }> = []
  readonly spawnCalls: SpawnSpec[] = []
  private readonly stoppedWorkers = new Set<string>()

  constructor(readonly implId: WorkerImplId) {}

  async detect(): Promise<DetectResult> {
    return { installed: true, activated: true }
  }

  async provision(ws: Workspace, caps: CapabilityBundle): Promise<void> {
    this.provisionCalls.push({ ws, caps })
  }

  async spawn(spec: SpawnSpec): Promise<IncarnationHandle> {
    this.spawnCalls.push(spec)
    return { worker_id: spec.worker_id, seq: 1, impl: this.implId, session_ref: `${this.implId}-${spec.worker_id}` }
  }

  async resume(_prev: IncarnationRef, _wakeInput: string): Promise<IncarnationHandle> {
    throw new Error('not used')
  }

  async fork(_prev: IncarnationRef, _forkInput: string): Promise<IncarnationHandle> {
    throw new Error('not used')
  }

  async sendInput(_h: IncarnationHandle, _text: string): Promise<void> {}

  async readTerminal() {
    return { kind: 'unavailable' as const, unavailable_reason: 'headless_without_text' }
  }

  async state(h: IncarnationHandle): Promise<WorkerContractState> {
    return this.stoppedWorkers.has(h.worker_id) ? 'exited' : 'running'
  }

  async inspectSupervisionActivity(_h: IncarnationHandle, cursor?: { offset: number }) {
    return { kind: 'unknown' as const, next_cursor: cursor ?? { offset: 0 } }
  }

  async kill(h: IncarnationHandle): Promise<void> {
    this.stoppedWorkers.add(h.worker_id)
  }

  capabilities(): AdapterCapabilities {
    return { fork: false, revive: true, goalMode: false, subagent: false, structuredTrace: false }
  }
}

describe('worker MCP server permission filter', () => {
  it('keeps ordinary MCP and excludes computer-use when desktop=false', () => {
    expect(filterMcpServersForWorker(servers, permissions({ desktop: false }))).toEqual([servers[0]])
  })

  it('excludes every server when mcp_skill=false and desktop=false', () => {
    expect(filterMcpServersForWorker(servers, permissions({ mcp_skill: false, desktop: false }))).toEqual([])
  })

  it('uses the existing category mapping and preserves allowed descriptors in input order', () => {
    const allowed = filterMcpServersForWorker(servers, permissions({ desktop: true }))
    expect(mcpCategoryFor('computer-use')).toBe('desktop')
    expect(mcpCategoryFor('git')).toBe('mcp_skill')
    expect(allowed).toEqual(servers)
  })
})

describe('UnifiedAgent worker capability production wiring', () => {
  it('真实装配经 spawn/handoff 把当前 MCP 配置按固定 principal 快照送到目标 provision', async () => {
    const dataDir = await useTmpDataDir('worker-mcp-capability-')
    const agent = new UnifiedAgent(makeAgentConfig({
      configured: true,
      moduleId: 'worker-mcp-capability-test',
      port: 19992,
    }))
    const internals = agent as unknown as {
      agentConfig?: AgentLayerConfig
      managerStack: ManagerStack
      attentionScheduler: { stopAll(): void }
    }

    try {
      const builtin = new RecordingAdapter('builtin')
      const claude = new RecordingAdapter('claude-code')
      const codex = new RecordingAdapter('codex')
      internals.managerStack.adapters.set('builtin', builtin)
      internals.managerStack.adapters.set('claude-code', claude)
      internals.managerStack.adapters.set('codex', codex)
      internals.agentConfig = {
        ...internals.agentConfig!,
        mcp_servers: servers,
        skills: mainlineSkills,
        tmp_page_base_url: 'https://crabot.example',
      }
      // 本用例验收 MCP capability 快照投递，不验收 P6-B activation gate；
      // gate 覆盖在 activation-registry.test.ts（显式 impl not-ready 拒绝）。
      ;(internals.managerStack.harness.deps as { assertWorkerImplReady?: unknown }).assertWorkerImplReady = undefined
      // P6-C：选择器同样旁路（ RecordingAdapter 不在 registry 的 ready 集合里）。
      ;(internals.managerStack.harness.deps as { selectWorkerImpl?: unknown }).selectWorkerImpl = undefined
      ;(internals.managerStack.harness.deps as { acquireWorkerFence?: unknown }).acquireWorkerFence = undefined

      const common = {
        title: 'MCP production wiring',
        prompt: 'work',
        origin: { spawned_by_episode: 'wechat::mcp-test', trigger_type: 'message' as const },
        report_to: { channel_id: 'wechat', session_id: 'mcp-test' },
      }

      const lowPrincipal = permissions({ mcp_skill: false, desktop: true })
      await internals.managerStack.harness.spawnWorker({
        ...common,
        managerKey: (`test::${'mcp-low'}` as ManagerKey),
        impl: 'claude-code',
        principal_permissions: lowPrincipal,
      })
      expect(claude.provisionCalls[0].caps.skills).toEqual(mainlineSkills)
      expect(claude.provisionCalls[0].caps.mcp_servers).toEqual([
        expect.objectContaining({
          name: TMP_PAGE_MCP_SERVER_NAME,
          transport: 'stdio',
          env: expect.objectContaining({
            [TMP_PAGE_BRIDGE_ENV.workerId]: expect.any(String),
            [TMP_PAGE_BRIDGE_ENV.baseUrl]: 'https://crabot.example',
          }),
        }),
      ])

      const allowedPrincipal = permissions({ mcp_skill: true, desktop: true })
      const builtinWorker = await internals.managerStack.harness.spawnWorker({
        ...common,
        managerKey: (`test::${'mcp-allowed'}` as ManagerKey),
        impl: 'builtin',
        principal_permissions: allowedPrincipal,
      })
      expect(builtin.provisionCalls[0].caps).toEqual({ skills: mainlineSkills, mcp_servers: [servers[0]] })

      const refreshedGit: MCPServerConfig = { name: 'git-v2', command: 'git-mcp-v2' }
      internals.agentConfig = { ...internals.agentConfig!, mcp_servers: [refreshedGit, servers[1]] }
      await internals.managerStack.harness.switchWorkerImpl(builtinWorker.worker_id, 'codex', 'switch to codex')

      expect(codex.provisionCalls[0].caps.skills).toEqual(mainlineSkills)
      expect(codex.provisionCalls[0].caps.mcp_servers).toEqual([
        refreshedGit,
        expect.objectContaining({ name: TMP_PAGE_MCP_SERVER_NAME, transport: 'stdio' }),
      ])
      expect(codex.spawnCalls[0].principal_permissions).toEqual(allowedPrincipal)
    } finally {
      internals.attentionScheduler.stopAll()
      await dataDir.restore()
    }
  })
})
