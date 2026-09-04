/**
 * send_message 省略 channel_id 的确定性参数修复规则单测
 * （spec 2026-09-03-tool-input-repair）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createSendMessageChannelRepair } from '../../src/mcp/crab-messaging'

describe('createSendMessageChannelRepair', () => {
  it('唯一已登记归属 → 补全 channel_id 且不原地修改输入', async () => {
    const lookup = vi.fn(() => new Set(['bot']))
    const repair = createSendMessageChannelRepair(lookup, {
      channel_id: 'home',
      session_id: 'home-session',
    })
    const input = { session_id: 's1', content: 'hi', post_send_action: 'none' }

    expect(await repair(input)).toEqual({
      channel_id: 'bot',
      session_id: 's1',
      content: 'hi',
      post_send_action: 'none',
    })
    expect(input).not.toHaveProperty('channel_id')
    expect(lookup).toHaveBeenCalledOnce()
    expect(lookup).toHaveBeenCalledWith('s1')
  })

  it('多归属且当前 Manager Channel 在集合中 → 取当前 Channel', async () => {
    const repair = createSendMessageChannelRepair(
      () => new Set(['bot', 'telegram']),
      { channel_id: 'bot', session_id: 'home-session' },
    )

    expect(await repair({ session_id: 's1', content: 'x' })).toEqual({
      channel_id: 'bot',
      session_id: 's1',
      content: 'x',
    })
  })

  it('多归属但当前 Manager Channel 不在集合中 → 原样透传', async () => {
    const repair = createSendMessageChannelRepair(
      () => new Set(['a', 'b']),
      { channel_id: 'bot', session_id: 'home-session' },
    )
    const input = { session_id: 's1', content: 'x' }

    expect(await repair(input)).toBe(input)
  })

  it('无已登记归属 → 原样透传', async () => {
    const repair = createSendMessageChannelRepair(() => undefined, {
      channel_id: 'bot',
      session_id: 'home-session',
    })
    const input = { session_id: 's9', content: 'x' }

    expect(await repair(input)).toBe(input)
  })

  it('当前 Manager 自身 Session 直接补全，包括 admin-web，且不查索引', async () => {
    const lookup = vi.fn(() => new Set(['wrong']))
    const repair = createSendMessageChannelRepair(lookup, {
      channel_id: 'admin-web',
      session_id: 'admin-chat',
    })

    expect(await repair({ session_id: 'admin-chat', content: 'x' })).toEqual({
      channel_id: 'admin-web',
      session_id: 'admin-chat',
      content: 'x',
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('索引读取抛错 → 原样透传', async () => {
    const repair = createSendMessageChannelRepair(() => {
      throw new Error('index unavailable')
    })
    const input = { session_id: 's1', content: 'x' }

    expect(await repair(input)).toBe(input)
  })

  it('显式 channel_id 时零介入', async () => {
    const lookup = vi.fn(() => new Set(['other']))
    const repair = createSendMessageChannelRepair(lookup, {
      channel_id: 'bot',
      session_id: 'home-session',
    })
    const input = { channel_id: 'bot', session_id: 's1', content: 'x' }

    expect(await repair(input)).toBe(input)
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each([
    [{ content: 'x' }],
    [{ session_id: 123, content: 'x' }],
    [{ session_id: '', content: 'x' }],
  ])('缺少有效 session_id 时零介入：%o', async (input) => {
    const lookup = vi.fn(() => new Set(['bot']))
    const repair = createSendMessageChannelRepair(lookup, {
      channel_id: 'bot',
      session_id: 'home-session',
    })

    expect(await repair(input)).toBe(input)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('无当前 Manager 目标时，唯一归属补全、多归属透传', async () => {
    const single = createSendMessageChannelRepair(() => new Set(['a']))
    expect(await single({ session_id: 's1', content: 'x' })).toEqual({
      channel_id: 'a',
      session_id: 's1',
      content: 'x',
    })

    const multi = createSendMessageChannelRepair(() => new Set(['a', 'b']))
    const input = { session_id: 's1', content: 'x' }
    expect(await multi(input)).toBe(input)
  })
})
