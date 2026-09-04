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
import { createSendMessageChannelRepair } from '../../src/mcp/crab-messaging'

/** channelId → 该渠道上存在的 session_id 集合；值含义见 makeDeps 的 failPorts / breakList。 */
function makeDeps(opts: {
  channels: Record<string, string[]>
  home?: string
  /** 这些 channel 的 resolveChannelPort 抛错（渠道不可用） */
  deadPorts?: string[]
  /** list_channel_instances RPC 抛错（admin 不可达） */
  breakList?: boolean
}) {
  const calls: Array<{ method: string; params: unknown }> = []
  const ids = Object.keys(opts.channels)
  const portOf = new Map(ids.map((id, i) => [id, 10_000 + i]))
  const deps = {
    moduleId: 'test-agent',
    getAdminPort: async () => 1,
    resolveChannelPort: async (channelId: string) => {
      if (opts.deadPorts?.includes(channelId)) throw new Error('channel down')
      return portOf.get(channelId) ?? 0
    },
    rpcClient: {
      call: async <P, R>(_port: number, method: string, params: P, _source?: string): Promise<R> => {
        calls.push({ method, params })
        if (opts.breakList) throw new Error('admin unreachable')
        if (method === 'list_channel_instances') {
          return {
            items: Object.keys(opts.channels).map((id) => ({ id })),
          } as R
        }
        if (method === 'get_session') {
          const session = (params as { session_id: string }).session_id
          // 按 port 反查渠道：portOf 是确定性的（10_000 + index）
          const channelId = ids.find((id) => portOf.get(id) === _port)
          if (channelId && opts.channels[channelId]?.includes(session)) {
            return { session: { id: session } } as R
          }
          throw new Error('Session not found')
        }
        throw new Error(`unexpected method: ${method}`)
      },
    },
  }
  return { deps, calls }
}

describe('createSendMessageChannelRepair', () => {
  it('唯一命中 → 补全 channel_id 且保留其余入参', async () => {
    const { deps } = makeDeps({ channels: { bot: ['s1'], other: ['s2'] }, home: 'bot' })
    const repair = createSendMessageChannelRepair(deps, 'bot')
    const input = { session_id: 's1', content: 'hi', post_send_action: 'none' }
    expect(await repair(input)).toEqual({ channel_id: 'bot', session_id: 's1', content: 'hi', post_send_action: 'none' })
    // 入参对象本身不被改写
    expect(input).not.toHaveProperty('channel_id')
  })

  it('多命中且归属渠道在列 → 取归属渠道', async () => {
    const { deps } = makeDeps({ channels: { bot: ['s1'], tg: ['s1'] }, home: 'bot' })
    const repair = createSendMessageChannelRepair(deps, 'bot')
    expect(await repair({ session_id: 's1', content: 'x' })).toEqual({ channel_id: 'bot', session_id: 's1', content: 'x' })
  })

  it('多命中但归属渠道不在列 → 透传', async () => {
    const { deps } = makeDeps({ channels: { a: ['s1'], b: ['s1'] }, home: 'bot' })
    const repair = createSendMessageChannelRepair(deps, 'bot')
    expect(await repair({ session_id: 's1', content: 'x' })).toEqual({ session_id: 's1', content: 'x' })
  })

  it('零命中 → 透传', async () => {
    const { deps } = makeDeps({ channels: { bot: ['s2'] }, home: 'bot' })
    const repair = createSendMessageChannelRepair(deps, 'bot')
    expect(await repair({ session_id: 's9', content: 'x' })).toEqual({ session_id: 's9', content: 'x' })
  })

  it('channel_id 已提供 → 透传且不发生任何 RPC（零介入）', async () => {
    const { deps, calls } = makeDeps({ channels: { bot: ['s1'] }, home: 'bot' })
    const repair = createSendMessageChannelRepair(deps, 'bot')
    const input = { channel_id: 'bot', session_id: 's1', content: 'x' }
    expect(await repair(input)).toBe(input)
    expect(calls).toHaveLength(0)
  })

  it('双参全缺 / session_id 非字符串 → 透传且不发生任何 RPC', async () => {
    const { deps, calls } = makeDeps({ channels: { bot: ['s1'] }, home: 'bot' })
    const repair = createSendMessageChannelRepair(deps, 'bot')
    expect(await repair({ content: 'x' })).toEqual({ content: 'x' })
    expect(await repair({ session_id: 123, content: 'x' })).toEqual({ session_id: 123, content: 'x' })
    expect(calls).toHaveLength(0)
  })

  it('admin 列表 RPC 失败 → 透传', async () => {
    const { deps } = makeDeps({ channels: { bot: ['s1'] }, home: 'bot', breakList: true })
    const repair = createSendMessageChannelRepair(deps, 'bot')
    expect(await repair({ session_id: 's1', content: 'x' })).toEqual({ session_id: 's1', content: 'x' })
  })

  it('归属渠道不可用时按其余渠道的唯一命中补全', async () => {
    const { deps } = makeDeps({ channels: { bot: ['s1'], tg: ['s1'] }, home: 'bot', deadPorts: ['bot'] })
    const repair = createSendMessageChannelRepair(deps, 'bot')
    expect(await repair({ session_id: 's1', content: 'x' })).toEqual({ channel_id: 'tg', session_id: 's1', content: 'x' })
  })

  it('无归属渠道信息时（homeChannelId 缺省），多命中透传、唯一命中补全', async () => {
    const multi = makeDeps({ channels: { a: ['s1'], b: ['s1'] } })
    const repairMulti = createSendMessageChannelRepair(multi.deps)
    expect(await repairMulti({ session_id: 's1', content: 'x' })).toEqual({ session_id: 's1', content: 'x' })

    const single = makeDeps({ channels: { a: ['s1'], b: ['s2'] } })
    const repairSingle = createSendMessageChannelRepair(single.deps)
    expect(await repairSingle({ session_id: 's2', content: 'x' })).toEqual({ channel_id: 'b', session_id: 's2', content: 'x' })
  })
})
