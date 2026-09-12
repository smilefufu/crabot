/**
 * 任务权限热刷新回归测试
 *
 * Spec: 2026-07-20-task-permission-hot-refresh-design.md
 *
 * 覆盖：
 * 1. AgentHandler：updateTaskPermissions 热替换、原发起人身份和任务权限隔离
 * 2. UnifiedAgent.refreshTaskPermissions（supplement 触发点）：原身份重新解析 + fail-soft
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import { UnifiedAgent } from '../../src/unified-agent.js'
import type { Friend, ResolvedPermissions } from '../../src/types.js'

const FULL_TOOL_ACCESS = {
  memory: true, messaging: true, task: true,
  mcp_skill: true, file_io: true, browser: true,
  shell: true, remote_exec: true, desktop: true,
}
const NONE_CLI_ACCESS = {
  provider: 'none' as const, agent: 'none' as const, mcp: 'none' as const,
  skill: 'none' as const, schedule: 'none' as const, channel: 'none' as const,
  friend: 'none' as const, permission: 'none' as const, config: 'none' as const,
  undo: 'none' as const,
}

const OLD_PERMS: ResolvedPermissions = {
  tool_access: { ...FULL_TOOL_ACCESS },
  cli_access: { ...NONE_CLI_ACCESS },
  storage: null,
  memory_scopes: ['s1'],
}
const FRESH_PERMS: ResolvedPermissions = {
  tool_access: { ...FULL_TOOL_ACCESS },
  cli_access: { ...NONE_CLI_ACCESS, provider: 'read' },
  storage: null,
  memory_scopes: ['s1'],
}

function makeFriend(id: string): Friend {
  return {
    id,
    display_name: id,
    permission: 'normal',
    channel_identities: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function makeSdkEnv() {
  return {
    modelId: 'test-model',
    format: 'anthropic' as const,
    env: {
      ANTHROPIC_BASE_URL: 'http://localhost:4000',
      ANTHROPIC_API_KEY: 'test-key',
    },
  }
}

function makeHandler(): AgentHandler {
  return new AgentHandler(
    makeSdkEnv(),
    {},
    {
      deps: {
        rpcClient: { call: vi.fn().mockResolvedValue({}) } as never,
        moduleId: 'test-agent',
        resolveChannelPort: async () => 3003,
        getAdminPort: async () => 0,
      },
    },
  )
}

type HandlerInternals = {
  activeTasks: Map<string, {
    resolvedPermissions?: ResolvedPermissions
    resumeWorkerContext?: { resolved_permissions?: ResolvedPermissions }
  }>
}

function internalsOf(handler: AgentHandler): HandlerInternals {
  return handler as unknown as HandlerInternals
}

/** 保留旧任务权限辅助接口的隔离验证，不再启动已退役的 Agent 循环。 */
function seedTask(handler: AgentHandler, sessionId = 's1') {
  const taskId = `task-${sessionId}`
  internalsOf(handler).activeTasks.set(taskId, {
    triggerType: 'message',
    resolvedPermissions: OLD_PERMS,
    resumeWorkerContext: {
      resolved_permissions: OLD_PERMS,
      sender_friend: makeFriend('f1'),
      task_origin: { channel_id: 'c1', session_id: sessionId, session_type: 'private' },
    },
  } as never)
  return { taskId }
}

describe('AgentHandler 任务权限持有者', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('updateTaskPermissions 热替换持有者 + resumeWorkerContext 快照', async () => {
    const h = makeHandler()
    const { taskId } = await seedTask(h)

    h.updateTaskPermissions(taskId, FRESH_PERMS)

    const ts = internalsOf(h).activeTasks.get(taskId)
    expect(ts?.resolvedPermissions).toEqual(FRESH_PERMS)
    expect(ts?.resumeWorkerContext?.resolved_permissions).toEqual(FRESH_PERMS)
    h.dispose()
  })

  it('getTaskPrincipal 返回任务原发起人身份（用于按原身份重新解析）', async () => {
    const h = makeHandler()
    const { taskId } = await seedTask(h)

    const principal = h.getTaskPrincipal(taskId)
    expect(principal).toEqual({
      senderFriend: expect.objectContaining({ id: 'f1' }),
      channelId: 'c1',
      sessionId: 's1',
      sessionType: 'private',
    })
    expect(h.getTaskPrincipal('task-not-exist')).toBeNull()
    h.dispose()
  })

  it('per-task 隔离：刷新 A 任务不影响 B 任务', async () => {
    const h = makeHandler()
    const a = await seedTask(h, 'sa')
    const b = await seedTask(h, 'sb')

    h.updateTaskPermissions(a.taskId, FRESH_PERMS)

    expect(internalsOf(h).activeTasks.get(a.taskId)?.resolvedPermissions).toEqual(FRESH_PERMS)
    expect(internalsOf(h).activeTasks.get(b.taskId)?.resolvedPermissions).toEqual(OLD_PERMS)
    h.dispose()
  })

  it('对不存在的任务调用 updateTaskPermissions 静默 no-op', () => {
    const h = makeHandler()
    expect(() => h.updateTaskPermissions('nope', FRESH_PERMS)).not.toThrow()
    h.dispose()
  })

  it('scheduled 任务（带 target_session、无 sender_friend）不返回 principal（review #38 回归）', () => {
    const h = makeHandler()
    internalsOf(h).activeTasks.set('sched-1', {
      resolvedPermissions: OLD_PERMS,
      resumeWorkerContext: {
        resolved_permissions: OLD_PERMS,
        // 带 target_session 的 scheduled 任务也有 task_origin —— 只判 session 会误判
        task_origin: { channel_id: 'c1', session_id: 'group-s1', session_type: 'group' },
      },
      triggerType: 'scheduled',
    } as never)

    expect(h.getTaskPrincipal('sched-1')).toBeNull()
    h.dispose()
  })
})

// ---------------------------------------------------------------------------
// UnifiedAgent 触发点（Object.create 轻量 harness，同 resolve-principal.test.ts）
// ---------------------------------------------------------------------------

type RefreshFn = (taskId: string) => Promise<void>

function buildAgentStub(rpcCall: ReturnType<typeof vi.fn>) {
  const agent = Object.create(UnifiedAgent.prototype) as Record<string, unknown>
  agent.config = { moduleId: 'test-agent' }
  agent.rpcClient = { call: rpcCall }
  agent.getAdminPort = async () => 19001
  return agent
}

describe('UnifiedAgent.refreshTaskPermissions（supplement 触发点）', () => {
  it('用任务原发起人身份重新解析并热替换', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ resolved: FRESH_PERMS, sources: {} })
    const agent = buildAgentStub(rpcCall)
    const updateTaskPermissions = vi.fn()
    agent.agentHandler = {
      getTaskPrincipal: () => ({
        senderFriend: makeFriend('original-sender'),
        sessionId: 'group-s1',
        sessionType: 'group',
      }),
      updateTaskPermissions,
    }

    await (agent as { refreshTaskPermissions: RefreshFn }).refreshTaskPermissions('task-1')

    expect(rpcCall).toHaveBeenCalledWith(
      19001,
      'resolve_principal_permissions',
      { sender_friend_id: 'original-sender', session_id: 'group-s1', session_type: 'group' },
      'test-agent',
    )
    expect(updateTaskPermissions).toHaveBeenCalledWith('task-1', FRESH_PERMS)
  })

  it('解析失败（admin 不可达）→ 保留当前权限，不抛错', async () => {
    const rpcCall = vi.fn().mockRejectedValue(new Error('admin down'))
    const agent = buildAgentStub(rpcCall)
    const updateTaskPermissions = vi.fn()
    agent.agentHandler = {
      getTaskPrincipal: () => ({ senderFriend: makeFriend('f1'), sessionId: 's1', sessionType: 'private' }),
      updateTaskPermissions,
    }

    await expect(
      (agent as { refreshTaskPermissions: RefreshFn }).refreshTaskPermissions('task-1'),
    ).resolves.toBeUndefined()
    expect(updateTaskPermissions).not.toHaveBeenCalled()
  })

  it('非消息触发任务（无 principal）→ 不发起解析', async () => {
    const rpcCall = vi.fn()
    const agent = buildAgentStub(rpcCall)
    agent.agentHandler = {
      getTaskPrincipal: () => null,
      updateTaskPermissions: vi.fn(),
    }

    await (agent as { refreshTaskPermissions: RefreshFn }).refreshTaskPermissions('task-1')
    expect(rpcCall).not.toHaveBeenCalled()
  })
})
