import { afterEach, describe, expect, it, vi } from 'vitest'

import { RpcError, sha256CanonicalJson } from 'crabot-shared'
import { UnifiedAgent } from '../../src/unified-agent.js'
import type { ManagerStack } from '../../src/manager/bootstrap.js'
import type { ManagerKey } from '../../src/manager/types.js'
import { makeAgentConfig, useTmpDataDir, type DataDirGuard } from '../inbound/harness.js'

const KEY = 'feishu::cotton-candy' as ManagerKey
const OBJECTIVE = {
  title: '确认 Manager 的上下文状态',
  completion_criteria: ['能说明发生过的事情'],
}
const ITEM = {
  title: '核查上下文',
  status: 'in_progress' as const,
  current_judgement: '等待核查',
  next_action: '读取调用记录',
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
    })

    await expect(current.handleChangeWorkboardAdmin({
      manager_key: KEY,
      action: 'create_objective',
      objective: OBJECTIVE,
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
          action: 'create_objective',
          expected_revision: 0,
          payload_sha256: sha256CanonicalJson({ action: 'create_objective', objective: OBJECTIVE }),
        },
      }),
      'workboard-admin-handler-test',
      expect.any(Object),
    )
    await expect(current.managerStack.workboard.loadAdmin(KEY)).resolves.toMatchObject({
      revision: 1,
      objectives: [{ title: OBJECTIVE.title }],
    })
    await expect(current.managerStack.workboard.pendingAdminNotice(KEY)).resolves.toMatchObject({
      revision: 1,
    })
    expect(await current.managerStack.workboard.pendingAdminNotice(KEY)).not.toHaveProperty('principal_permissions')
    expect(current.dispatchWorkboardAdminNotice).toHaveBeenCalledWith(KEY)
  })

  it('核销失败时不写入任务板，也不安排系统唤醒', async () => {
    const current = await boot()
    current.rpcClient.callSensitive = vi.fn().mockRejectedValue(new RpcError('FORBIDDEN', 'assertion 无效'))

    await expect(current.handleChangeWorkboardAdmin({
      manager_key: KEY,
      action: 'create_objective',
      objective: OBJECTIVE,
      expected_revision: 0,
      assertion: 'invalid-assertion',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(current.managerStack.workboard.loadAdmin(KEY)).resolves.toMatchObject({ revision: 0, objectives: [] })
    await expect(current.managerStack.workboard.pendingAdminNotice(KEY)).resolves.toBeUndefined()
    expect(current.dispatchWorkboardAdminNotice).not.toHaveBeenCalled()
  })

  it('任务项内容校验失败时返回 INVALID_PARAMS，不写入也不安排系统唤醒', async () => {
    const current = await boot()
    current.rpcClient.callSensitive = vi.fn().mockResolvedValue({
      consumed: true,
      expires_at: '2026-09-05T00:01:00.000Z',
    })
    await current.managerStack.workboard.createObjective(KEY, OBJECTIVE)

    await expect(current.handleChangeWorkboardAdmin({
      manager_key: KEY,
      action: 'create_work_item',
      objective_title: OBJECTIVE.title,
      work_item: { ...ITEM, status: 'blocked' },
      expected_revision: 1,
      assertion: 'opaque-assertion',
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: 'blocked 事项必须包含 blocker' })

    await expect(current.managerStack.workboard.loadAdmin(KEY)).resolves.toMatchObject({
      revision: 1,
      objectives: [{ work_items: [] }],
    })
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
    await current.managerStack.workboard.adminCreateObjective(KEY, 0, OBJECTIVE)

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
    await current.managerStack.workboard.adminCreateObjective(KEY, 0, OBJECTIVE)

    current.dispatchWorkboardAdminNotice(KEY)
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1))
    await current.managerStack.workboard.clearAdminNoticeIfCurrent(KEY, 1)
    await current.managerStack.workboard.adminCreateObjective(KEY, 1, {
      title: '确认新版上下文状态',
      completion_criteria: ['能按新版要求说明发生过的事情'],
    })
    current.dispatchWorkboardAdminNotice(KEY)

    settleFirst(completed)
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(2))
    expect(route.mock.calls[1][0]).toMatchObject({ noticeRevision: 2 })
  })
})
