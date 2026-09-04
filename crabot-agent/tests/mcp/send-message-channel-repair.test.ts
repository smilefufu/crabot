/**
 * send_message 省略 channel_id 的确定性参数修复规则单测
 * （spec 2026-09-03-tool-input-repair）。
 *
 * 覆盖：
 * - 唯一命中 → 补全 channel_id，其余入参原样保留
 * - 多命中且 manager 归属渠道在列 → 取归属渠道
 * - 多命中但归属渠道不在列（归属渠道不可用/不存在）→ 不猜，透传
 * - 零命中 / 双参全缺 / channel_id 已提供 / session_id 非字符串 → 透传
 * - 修复路径自身失败（admin 列表 RPC 抛错）→ 透传
 * - 零介入：channel_id 已提供时不发生任何 RPC
 */
import { describe, it, expect } from 'vitest'
import { RpcCallError } from 'crabot-shared'
import { createSendMessageChannelRepair } from '../../src/mcp/crab-messaging'

interface RepairOptions {
  channels: Record<string, string[]>
  pageSize?: number
  deadPorts?: string[]
  unavailablePorts?: string[]
  brokenSessions?: Record<string, string>
  breakList?: boolean
  malformedList?: boolean
  malformedSessions?: string[]
}

function makeDeps(opts: RepairOptions) {
  const calls: Array<{ method: string; params: unknown }> = []
  const ids = Object.keys(opts.channels)
  const portOf = new Map(ids.map((id, i) => [id, 10_000 + i]))
  const pageSize = opts.pageSize ?? 50
  const deps = {
    moduleId: 'test-agent',
    getAdminPort: async () => 1,
    resolveChannelPort: async (channelId: string) => {
      if (opts.deadPorts?.includes(channelId)) throw new Error('channel down')
      if (opts.unavailablePorts?.includes(channelId)) return 0
      return portOf.get(channelId) ?? 0
    },
    rpcClient: {
      call: async <P, R>(_port: number, method: string, params: P, _source?: string): Promise<R> => {
        calls.push({ method, params })
        if (opts.breakList && method === 'list_channel_instances') throw new Error('admin unreachable')
        if (method === 'list_channel_instances') {
          if (opts.malformedList) return { nope: true } as R
          const { page = 1, page_size = pageSize } = params as { page?: number; page_size?: number }
          const start = (page - 1) * page_size
          return {
            items: ids.slice(start, start + page_size).map((id) => ({ id })),
            pagination: {
              page,
              page_size,
              total_items: ids.length,
              total_pages: Math.max(1, Math.ceil(ids.length / page_size)),
            },
          } as R
        }
        if (method === 'get_session') {
          const session = (params as { session_id: string }).session_id
          const channelId = ids.find((id) => portOf.get(id) === _port)
          if (!channelId) throw new Error('unknown channel port')
          if (opts.brokenSessions?.[channelId]) {
            throw new RpcCallError(opts.brokenSessions[channelId], 'session probe failed')
          }
          if (opts.malformedSessions?.includes(channelId)) return { nope: true } as R
          if (opts.channels[channelId]?.includes(session)) {
            return { session: { id: session } } as R
          }
          throw new RpcCallError('NOT_FOUND', 'Session not found')
        }
        throw new Error(`unexpected method: ${method}`)
      },
    },
  }
  return { deps, calls }
}

describe('createSendMessageChannelRepair', () => {
  it('唯一命中 → 补全 channel_id 且保留其余入参', async () => {
    const { deps } = makeDeps({ channels: { bot: ['s1'], other: ['s2'] } })
    const repair = createSendMessageChannelRepair(deps, { channel_id: 'bot', session_id: 'home-session' })
    const input = { session_id: 's1', content: 'hi', post_send_action: 'none' }
    expect(await repair(input)).toEqual({ channel_id: 'bot', session_id: 's1', content: 'hi', post_send_action: 'none' })
    // 入参对象本身不被改写
    expect(input).not.toHaveProperty('channel_id')
  })

  it('多命中且归属渠道在列 → 取归属渠道', async () => {
    const { deps } = makeDeps({ channels: { bot: ['s1'], tg: ['s1'] } })
    const repair = createSendMessageChannelRepair(deps, { channel_id: 'bot', session_id: 'home-session' })
    expect(await repair({ session_id: 's1', content: 'x' })).toEqual({ channel_id: 'bot', session_id: 's1', content: 'x' })
  })

  it('多命中但归属渠道不在列 → 透传', async () => {
    const { deps } = makeDeps({ channels: { a: ['s1'], b: ['s1'] } })
    const repair = createSendMessageChannelRepair(deps, { channel_id: 'bot', session_id: 'home-session' })
    expect(await repair({ session_id: 's1', content: 'x' })).toEqual({ session_id: 's1', content: 'x' })
  })

  it('零命中 → 透传', async () => {
    const { deps } = makeDeps({ channels: { bot: ['s2'] } })
    const repair = createSendMessageChannelRepair(deps, { channel_id: 'bot', session_id: 'home-session' })
    expect(await repair({ session_id: 's9', content: 'x' })).toEqual({ session_id: 's9', content: 'x' })
  })

  it('channel_id 已提供 → 透传且不发生任何 RPC（零介入）', async () => {
    const { deps, calls } = makeDeps({ channels: { bot: ['s1'] } })
    const repair = createSendMessageChannelRepair(deps, { channel_id: 'bot', session_id: 'home-session' })
    const input = { channel_id: 'bot', session_id: 's1', content: 'x' }
    expect(await repair(input)).toBe(input)
    expect(calls).toHaveLength(0)
  })

  it('双参全缺 / session_id 非字符串 → 透传且不发生任何 RPC', async () => {
    const { deps, calls } = makeDeps({ channels: { bot: ['s1'] } })
    const repair = createSendMessageChannelRepair(deps, { channel_id: 'bot', session_id: 'home-session' })
    expect(await repair({ content: 'x' })).toEqual({ content: 'x' })
    expect(await repair({ session_id: 123, content: 'x' })).toEqual({ session_id: 123, content: 'x' })
    expect(calls).toHaveLength(0)
  })

  it('admin 列表 RPC 失败 → 透传', async () => {
    const { deps } = makeDeps({ channels: { bot: ['s1'] }, breakList: true })
    const repair = createSendMessageChannelRepair(deps, { channel_id: 'bot', session_id: 'home-session' })
    expect(await repair({ session_id: 's1', content: 'x' })).toEqual({ session_id: 's1', content: 'x' })
  })

  it.each([
    ['resolveChannelPort 抛错', { deadPorts: ['bot'] }],
    ['resolveChannelPort 返回不可用端口', { unavailablePorts: ['bot'] }],
    ['get_session 返回非 NOT_FOUND 错误', { brokenSessions: { bot: 'INTERNAL_ERROR' } }],
  ])('%s 时规则失败并原样透传，不用剩余局部结果猜目标', async (_label, failure) => {
    const { deps } = makeDeps({
      channels: { bot: ['s1'], tg: ['s1'] },
      ...failure,
    })
    const repair = createSendMessageChannelRepair(deps, { channel_id: 'bot', session_id: 'home-session' })
    const input = { session_id: 's1', content: 'x' }
    expect(await repair(input)).toBe(input)
  })

  it('只有明确 NOT_FOUND 才继续扫描，普通 Error 视为规则失败', async () => {
    const { deps } = makeDeps({ channels: { bot: [], tg: ['s1'] } })
    const call = deps.rpcClient.call
    deps.rpcClient.call = (async <P, R>(port: number, method: string, params: P, source?: string): Promise<R> => {
      if (method === 'get_session' && port === 10_000) throw new Error('Session not found')
      return call(port, method, params, source)
    }) as typeof deps.rpcClient.call
    const repair = createSendMessageChannelRepair(deps, { channel_id: 'bot', session_id: 'home-session' })
    const input = { session_id: 's1', content: 'x' }
    expect(await repair(input)).toBe(input)
  })

  it('当前 manager 自己的 session 直接补归属 channel，Admin Web 也不探测 RPC', async () => {
    const { deps, calls } = makeDeps({ channels: {} })
    const repair = createSendMessageChannelRepair(deps, { channel_id: 'admin-web', session_id: 'admin-chat' })
    const input = { session_id: 'admin-chat', content: 'x' }
    expect(await repair(input)).toEqual({ channel_id: 'admin-web', session_id: 'admin-chat', content: 'x' })
    expect(calls).toHaveLength(0)
  })

  it('遍历所有分页并使用平铺 page/page_size 参数', async () => {
    const channels = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [
      `ch-${index + 1}`,
      index === 50 ? ['target'] : [],
    ]))
    const { deps, calls } = makeDeps({ channels })
    const repair = createSendMessageChannelRepair(deps)
    expect(await repair({ session_id: 'target', content: 'x' })).toEqual({
      channel_id: 'ch-51',
      session_id: 'target',
      content: 'x',
    })
    expect(calls.filter((call) => call.method === 'list_channel_instances').map((call) => call.params)).toEqual([
      { page: 1, page_size: 50 },
      { page: 2, page_size: 50 },
    ])
  })

  it('跨页多命中时不误判为唯一命中', async () => {
    const channels = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [
      `ch-${index + 1}`,
      index === 0 || index === 50 ? ['target'] : [],
    ]))
    const { deps } = makeDeps({ channels })
    const repair = createSendMessageChannelRepair(deps)
    const input = { session_id: 'target', content: 'x' }
    expect(await repair(input)).toBe(input)
  })

  it('未注册的归属 channel 不被盲目探测或用于多命中决策', async () => {
    const { deps, calls } = makeDeps({ channels: { a: ['s1'], b: ['s1'] } })
    const repair = createSendMessageChannelRepair(deps, { channel_id: 'bot', session_id: 'home-session' })
    const input = { session_id: 's1', content: 'x' }
    expect(await repair(input)).toBe(input)
    expect(calls.filter((call) => call.method === 'get_session')).toHaveLength(2)
  })

  it.each([
    ['列表响应格式错误', { malformedList: true }],
    ['session 响应格式错误', { malformedSessions: ['bot'] }],
  ])('%s 时规则失败并原样透传', async (_label, failure) => {
    const { deps } = makeDeps({ channels: { bot: ['s1'] }, ...failure })
    const repair = createSendMessageChannelRepair(deps, { channel_id: 'bot', session_id: 'home-session' })
    const input = { session_id: 's1', content: 'x' }
    expect(await repair(input)).toBe(input)
  })

  it('空字符串 session_id 零介入', async () => {
    const { deps, calls } = makeDeps({ channels: { bot: [] } })
    const repair = createSendMessageChannelRepair(deps, { channel_id: 'bot', session_id: 'home-session' })
    const input = { session_id: '', content: 'x' }
    expect(await repair(input)).toBe(input)
    expect(calls).toHaveLength(0)
  })

  it('无归属目标信息时，多命中透传、唯一命中补全', async () => {
    const multi = makeDeps({ channels: { a: ['s1'], b: ['s1'] } })
    const repairMulti = createSendMessageChannelRepair(multi.deps)
    expect(await repairMulti({ session_id: 's1', content: 'x' })).toEqual({ session_id: 's1', content: 'x' })

    const single = makeDeps({ channels: { a: ['s1'], b: ['s2'] } })
    const repairSingle = createSendMessageChannelRepair(single.deps)
    expect(await repairSingle({ session_id: 's2', content: 'x' })).toEqual({ channel_id: 'b', session_id: 's2', content: 'x' })
  })
})
