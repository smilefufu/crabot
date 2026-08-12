import { describe, it, expect, vi } from 'vitest'
import type { RpcClient } from 'crabot-shared'
import { ConfigLoader } from '../../src/core/config-loader.js'

/**
 * 回归：convertAdminConfigToLocal 是个白名单字段映射，曾漏掉 tmp_page_base_url，
 * 导致 admin 注入了、agent 收到了，但转成 this.agentConfig 时被筛掉 → worker
 * 拿不到对外 base / task_id → 满世界 grep 自查 + meta.owner_task_id 写错 → 唤醒断链。
 * 这里锁住该字段必须从 adminConfig 流到 agent_config。
 */
describe('ConfigLoader.convertAdminConfigToLocal — tmp_page_base_url 透传', () => {
  const baseAdminConfig = {
    instance_id: 'crabot-agent',
    role: 'worker' as const,
    system_prompt: '',
    model_config: {},
  }

  it('admin 下发的 tmp_page_base_url 必须带进 agent_config', () => {
    const local = (ConfigLoader as unknown as {
      convertAdminConfigToLocal: (c: unknown, id: string) => { agent_config: { tmp_page_base_url?: string } }
    }).convertAdminConfigToLocal(
      { ...baseAdminConfig, tmp_page_base_url: 'http://localhost:3000' },
      'crabot-agent',
    )
    expect(local.agent_config.tmp_page_base_url).toBe('http://localhost:3000')
  })

  it('admin 未下发时 agent_config 不带该字段（条件展开，不塞 undefined）', () => {
    const local = (ConfigLoader as unknown as {
      convertAdminConfigToLocal: (c: unknown, id: string) => { agent_config: { tmp_page_base_url?: string } }
    }).convertAdminConfigToLocal(baseAdminConfig, 'crabot-agent')
    expect(local.agent_config.tmp_page_base_url).toBeUndefined()
  })
})

/**
 * 回归：冷启动竞态。MM 按 start_priority 串行 spawn（admin=10 / agent=20），间隔仅 1s 且无依赖
 * 声明，而 admin 要跑完整个 onStart() 才 listen —— agent 启动时那一下 pull 必然 ECONNREFUSED。
 * 旧实现只 pull 一次就落 unconfigured，而 admin 侧的 push 兜底又要求 agent 已 register，
 * 双向死锁，生产上每次冷启动必现，只能 kill -9 agent 才能救活。
 *
 * 这里锁住：pull 失败要退避重试到 admin 就绪（拿到的是**完整**配置，含 system_prompt /
 * mcp_servers，push 路径给不了这两个字段）；重试耗尽仍要落 unconfigured 兜底，不能让 agent 起不来。
 */
describe('ConfigLoader.loadWithRetry — 启动期拉配置退避重试', () => {
  const realAdminConfig = {
    instance_id: 'crabot-agent',
    role: 'worker' as const,
    system_prompt: '你是 crabot',
    model_config: { default: { endpoint: 'https://api.anthropic.com', apikey: 'sk-x', model_id: 'claude', format: 'anthropic' } },
    mcp_servers: [{ name: 'fs', command: 'node', args: [] }],
  }

  /** admin 未 listen 时 Node 22 happy-eyeballs 抛的就是这个：message 为空字符串 */
  function connRefused(): Error {
    return new AggregateError(
      [new Error('connect ECONNREFUSED ::1:19002'), new Error('connect ECONNREFUSED 127.0.0.1:19002')],
      ''
    )
  }

  function fakeRpcClient(failTimes: number, result: unknown = { config_revision: 1, config: realAdminConfig }) {
    let calls = 0
    const callSensitive = vi.fn(async () => {
      calls += 1
      if (calls <= failTimes) throw connRefused()
      return result
    })
    return { client: { callSensitive } as unknown as RpcClient, calls: () => calls }
  }

  it('admin 前 N 次不可达、之后可达 → 最终拿到真配置（而不是 unconfigured）', async () => {
    const { client, calls } = fakeRpcClient(3)

    const config = await ConfigLoader.loadWithRetry(client, 'http://localhost:19002', {
      budgetMs: 5_000,
      initialDelayMs: 1,
      maxDelayMs: 2,
    })

    expect(calls()).toBe(4)
    expect(config.agent_config?.system_prompt).toBe('你是 crabot')
    expect(config.agent_config?.model_config).toHaveProperty('default')
    expect(config.agent_config?.mcp_servers).toHaveLength(1)
  })

  it('admin 始终不可达 → 重试耗尽后 fail closed', async () => {
    const { client, calls } = fakeRpcClient(Number.POSITIVE_INFINITY)

    await expect(ConfigLoader.loadWithRetry(client, 'http://localhost:19002', {
      budgetMs: 40,
      initialDelayMs: 5,
      maxDelayMs: 5,
    })).rejects.toThrow('Admin config pull failed permanently')
    expect(calls()).toBeGreaterThan(1)
  })

  it('adminEndpoint 未配置属环境问题 → fail closed，不空转重试', async () => {
    const { client, calls } = fakeRpcClient(0)

    await expect(ConfigLoader.loadWithRetry(client, undefined, {
      budgetMs: 60_000,
      initialDelayMs: 1,
      maxDelayMs: 2,
    })).rejects.toThrow('Admin config pull failed permanently')
    expect(calls()).toBe(0)
  })
})
