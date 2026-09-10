import { describe, it, expect, vi } from 'vitest'
import { prefetchQuotedMessages, type PrefetchQuotedDeps } from '../../src/utils/quoted-message-prefetcher.js'
import type { ChannelMessage } from '../../src/types.js'
import type { SenderIdentity } from '../../src/utils/sender-identity.js'

function makeMsg(id: string, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    platform_message_id: id,
    session: { session_id: 's-1', channel_id: 'ch-1', type: 'private' },
    sender: { platform_user_id: 'u-1', platform_display_name: 'Alice' },
    content: { type: 'text', text: 'hi' },
    features: { is_mention_crab: false },
    platform_timestamp: '2026-06-01T03:00:00Z',
    ...overrides,
  } as ChannelMessage
}

const identityResolver = (_msg: ChannelMessage): SenderIdentity => 'master'

describe('prefetchQuotedMessages', () => {
  it('无 reply_to / quote 时返回空 map，不调 RPC', async () => {
    const rpcCall = vi.fn()
    const deps: PrefetchQuotedDeps = {
      rpcClient: { call: rpcCall } as never,
      moduleId: 'agent',
      resolveChannelPort: vi.fn(),
    }
    const result = await prefetchQuotedMessages(
      [makeMsg('m1')],
      [],
      'ch-1',
      's-1',
      'private',
      deps,
      identityResolver,
    )
    expect(result.size).toBe(0)
    expect(rpcCall).not.toHaveBeenCalled()
  })

  it('引用命中 alreadyKnown 时直接 fold，不调 RPC', async () => {
    const rpcCall = vi.fn()
    const deps: PrefetchQuotedDeps = {
      rpcClient: { call: rpcCall } as never,
      moduleId: 'agent',
      resolveChannelPort: vi.fn(),
    }
    const parent = makeMsg('parent')
    const current = makeMsg('m1', {
      features: { is_mention_crab: false, reply_to_message_id: 'parent' },
    })
    const result = await prefetchQuotedMessages(
      [current],
      [parent],
      'ch-1',
      's-1',
      'private',
      deps,
      identityResolver,
    )
    expect(result.size).toBe(1)
    expect(result.get('parent')?.msg).toBe(parent)
    expect(rpcCall).not.toHaveBeenCalled()
  })

  it('引用未命中本地时通过 RPC 拉，封装回 ChannelMessage', async () => {
    const rpcCall = vi.fn().mockResolvedValueOnce({
      platform_message_id: 'parent-remote',
      sender: { platform_user_id: 'u-remote', platform_display_name: 'Remote' },
      content: { type: 'text', text: '远端原话' },
      features: { is_mention_crab: false },
      platform_timestamp: '2026-05-31T10:00:00Z',
    })
    const deps: PrefetchQuotedDeps = {
      rpcClient: { call: rpcCall } as never,
      moduleId: 'agent',
      resolveChannelPort: vi.fn().mockResolvedValue(19101),
    }
    const current = makeMsg('m1', {
      features: { is_mention_crab: false, reply_to_message_id: 'parent-remote' },
    })
    const result = await prefetchQuotedMessages(
      [current],
      [],
      'ch-1',
      's-1',
      'private',
      deps,
      identityResolver,
    )
    expect(rpcCall).toHaveBeenCalledTimes(1)
    expect(rpcCall).toHaveBeenCalledWith(19101, 'get_message', {
      session_id: 's-1',
      platform_message_id: 'parent-remote',
    }, 'agent')
    expect(result.get('parent-remote')?.msg.content.text).toBe('远端原话')
    expect(result.get('parent-remote')?.identity).toBe('master')
  })

  it('部分 RPC 失败时不阻塞，仅丢失败那条', async () => {
    const rpcCall = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockResolvedValueOnce({
        platform_message_id: 'ok',
        sender: { platform_user_id: 'u-2', platform_display_name: 'B' },
        content: { type: 'text', text: '没事' },
        features: { is_mention_crab: false },
        platform_timestamp: '2026-05-31T03:00:00Z',
      })
    const deps: PrefetchQuotedDeps = {
      rpcClient: { call: rpcCall } as never,
      moduleId: 'agent',
      resolveChannelPort: vi.fn().mockResolvedValue(19101),
    }
    const a = makeMsg('a', { features: { is_mention_crab: false, reply_to_message_id: 'fail' } })
    const b = makeMsg('b', { features: { is_mention_crab: false, reply_to_message_id: 'ok' } })
    const result = await prefetchQuotedMessages(
      [a, b],
      [],
      'ch-1',
      's-1',
      'private',
      deps,
      identityResolver,
    )
    expect(rpcCall).toHaveBeenCalledTimes(2)
    expect(result.has('fail')).toBe(false)
    expect(result.has('ok')).toBe(true)
  })

  it('resolveChannelPort 抛错时只丢 RPC 路径，已命中本地的还能用', async () => {
    const rpcCall = vi.fn()
    const deps: PrefetchQuotedDeps = {
      rpcClient: { call: rpcCall } as never,
      moduleId: 'agent',
      resolveChannelPort: vi.fn().mockRejectedValue(new Error('no port')),
    }
    const parent = makeMsg('local-parent')
    const current = makeMsg('m1', {
      features: { is_mention_crab: false, reply_to_message_id: 'local-parent' },
    })
    const remote = makeMsg('m2', {
      features: { is_mention_crab: false, reply_to_message_id: 'remote-only' },
    })
    const result = await prefetchQuotedMessages(
      [current, remote],
      [parent],
      'ch-1',
      's-1',
      'private',
      deps,
      identityResolver,
    )
    // 本地命中保留；远端那条 channel 不可用直接跳过
    expect(result.has('local-parent')).toBe(true)
    expect(result.has('remote-only')).toBe(false)
    expect(rpcCall).not.toHaveBeenCalled()
  })

  it('reply_to 和 quote_message_id 都收集，不重复拉', async () => {
    const rpcCall = vi.fn()
    const deps: PrefetchQuotedDeps = {
      rpcClient: { call: rpcCall } as never,
      moduleId: 'agent',
      resolveChannelPort: vi.fn(),
    }
    const parent = makeMsg('same')
    const a = makeMsg('a', { features: { is_mention_crab: false, reply_to_message_id: 'same' } })
    const b = makeMsg('b', { features: { is_mention_crab: false, quote_message_id: 'same' } })
    const result = await prefetchQuotedMessages(
      [a, b],
      [parent],
      'ch-1',
      's-1',
      'private',
      deps,
      identityResolver,
    )
    expect(result.size).toBe(1)
    expect(rpcCall).not.toHaveBeenCalled()
  })
})
