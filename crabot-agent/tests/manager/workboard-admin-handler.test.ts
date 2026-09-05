import { afterEach, describe, expect, it, vi } from 'vitest'

import { RpcError, sha256CanonicalJson } from 'crabot-shared'
import { UnifiedAgent } from '../../src/unified-agent.js'
import type { ManagerStack } from '../../src/manager/bootstrap.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { ResolvedPermissions } from '../../src/types.js'
import { makeAgentConfig, useTmpDataDir, type DataDirGuard } from '../inbound/harness.js'

const KEY = 'feishu::cotton-candy' as ManagerKey
const ITEM = {
  title: '核查上下文',
  status: 'in_progress' as const,
  objective: '确认 Manager 的上下文状态',
  acceptance: ['能说明发生过的事情'],
  current_state: '等待核查',
  next_action: '读取调用记录',
  blockers: [],
}
const PERMISSIONS: ResolvedPermissions = {
  tool_access: {
    memory: true, messaging: true, task: true, mcp_skill: true, file_io: true,
    browser: true, shell: true, remote_exec: true, desktop: true,
  },
  cli_access: {
    provider: 'write', agent: 'write', mcp: 'write', skill: 'write', schedule: 'write',
    channel: 'write', friend: 'write', permission: 'write', config: 'write', undo: 'write',
  },
  storage: null,
  memory_scopes: [],
}

interface AgentInternals {
  managerStack: ManagerStack
  attentionScheduler: { stopAll(): void }
  requireKnownManagerKey(raw: unknown): Promise<ManagerKey>
  getAdminPort(): Promise<number>
  dispatchWorkboardAdminNotice(key: ManagerKey): void
  handleChangeWorkboardAdmin(params: Record<string, unknown>): Promise<unknown>
  rpcClient: {
    callSensitive: ReturnType<typeof vi.fn>
  }
}

describe('UnifiedAgent task-board Admin handler', () => {
  let dataDir: DataDirGuard | undefined
  let agent: AgentInternals | undefined

  afterEach(async () => {
    agent?.attentionScheduler.stopAll()
    await agent?.managerStack.dispose()
    await dataDir?.restore()
    agent = undefined
    dataDir = undefined
  })

  async function boot(stubDispatch = true): Promise<AgentInternals> {
    dataDir = await useTmpDataDir('workboard-admin-handler-')
    agent = new UnifiedAgent(makeAgentConfig({
      configured: true,
      moduleId: 'workboard-admin-handler-test',
      port: 19991,
    })) as unknown as AgentInternals
    agent.requireKnownManagerKey = vi.fn().mockResolvedValue(KEY)
    agent.getAdminPort = vi.fn().mockResolvedValue(19001)
    if (stubDispatch) agent.dispatchWorkboardAdminNotice = vi.fn()
    return agent
  }

  it('仅在 assertion 精确核销后写入任务板并安排系统唤醒', async () => {
    const current = await boot()
    current.rpcClient.callSensitive = vi.fn().mockResolvedValue({
      consumed: true,
      expires_at: '2026-09-05T00:01:00.000Z',
      principal_permissions: PERMISSIONS,
    })

    await expect(current.handleChangeWorkboardAdmin({
      manager_key: KEY,
      action: 'create',
      item: ITEM,
      expected_revision: 0,
      assertion: 'opaque-assertion',
    })).resolves.toMatchObject({ revision: 1, manager_notification: 'pending' })

    expect(current.rpcClient.callSensitive).toHaveBeenCalledWith(
      19001,
      'consume_workboard_admin_assertion',
      expect.objectContaining({
        assertion: 'opaque-assertion',
        expected: {
          manager_key: KEY,
          action: 'create',
          expected_revision: 0,
          payload_sha256: sha256CanonicalJson({ action: 'create', item: ITEM }),
        },
      }),
      'workboard-admin-handler-test',
      expect.any(Object),
    )
    await expect(current.managerStack.workboard.loadAdmin(KEY)).resolves.toMatchObject({
      revision: 1,
      active: [{ title: ITEM.title }],
    })
    await expect(current.managerStack.workboard.pendingAdminNotice(KEY)).resolves.toMatchObject({
      revision: 1,
      principal_permissions: PERMISSIONS,
    })
    expect(current.dispatchWorkboardAdminNotice).toHaveBeenCalledWith(KEY)
  })

  it('核销失败时不写入任务板，也不安排系统唤醒', async () => {
    const current = await boot()
    current.rpcClient.callSensitive = vi.fn().mockRejectedValue(new RpcError('FORBIDDEN', 'assertion 无效'))

    await expect(current.handleChangeWorkboardAdmin({
      manager_key: KEY,
      action: 'create',
      item: ITEM,
      expected_revision: 0,
      assertion: 'invalid-assertion',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(current.managerStack.workboard.loadAdmin(KEY)).resolves.toMatchObject({ revision: 0, active: [] })
    await expect(current.managerStack.workboard.pendingAdminNotice(KEY)).resolves.toBeUndefined()
    expect(current.dispatchWorkboardAdminNotice).not.toHaveBeenCalled()
  })

  it('宿主 episode 的成功结束不能替代任务板系统输入消费来清除 notice', async () => {
    const current = await boot(false)
    const result = {
      episodeId: 'host-episode', outcome: 'completed' as const, turns: 1, consumedEvents: true,
      repliedToHuman: false, successfulSendMessageTargets: [],
    }
    const route = vi.spyOn(current.managerStack.registry, 'routeWorkboardAdminUpdate').mockImplementation(async ({ onSettled }) => {
      onSettled?.(result)
      return result
    })
    await current.managerStack.workboard.adminCreate(KEY, 0, ITEM, PERMISSIONS)

    current.dispatchWorkboardAdminNotice(KEY)

    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1))
    await expect(current.managerStack.workboard.pendingAdminNotice(KEY)).resolves.toMatchObject({ revision: 1 })
  })

  it('旧 notice 结算与新保存交错时，释放派发去重后仍会投递新版', async () => {
    const current = await boot(false)
    const completed = {
      episodeId: 'episode', outcome: 'completed' as const, turns: 1, consumedEvents: true,
      repliedToHuman: false, successfulSendMessageTargets: [] as never[],
    }
    let settleFirst!: (result: typeof completed) => void
    const firstResult = new Promise<typeof completed>((resolve) => { settleFirst = resolve })
    const route = vi.spyOn(current.managerStack.registry, 'routeWorkboardAdminUpdate')
      .mockImplementationOnce(async () => firstResult)
      .mockResolvedValue(completed)
    await current.managerStack.workboard.adminCreate(KEY, 0, ITEM, PERMISSIONS)

    current.dispatchWorkboardAdminNotice(KEY)
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1))
    await current.managerStack.workboard.clearAdminNoticeIfCurrent(KEY, 1)
    await current.managerStack.workboard.adminCreate(KEY, 1, { ...ITEM, title: '核查新版上下文' }, PERMISSIONS)
    current.dispatchWorkboardAdminNotice(KEY)

    settleFirst(completed)
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(2))
    expect(route.mock.calls[1][0]).toMatchObject({ noticeRevision: 2 })
  })
})
