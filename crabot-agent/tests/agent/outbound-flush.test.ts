/**
 * outbound-flush helper 单测
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.5
 *
 * 覆盖 dispatchOutboundMessage 与 createOutboundFlush 的核心契约：
 * - file_path + sandbox path mapping 走主机路径转换（不再 silent drop）
 * - friend_id-only mention 走 admin get_friend 反查（不再 silent drop）
 * - flush 路径多 entry 之一失败时后续 entry 仍发（reviewer Important #2）
 * - flush 完后 buffer 已被 splice 清空
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createOutboundFlush,
  dispatchOutboundMessage,
  type OutboundBufferEntry,
  type OutboundDispatchDeps,
  type OutboundSendResult,
  type PathMapping,
} from '../../src/agent/outbound-flush.js'

function makeEntry(overrides: Partial<OutboundBufferEntry> = {}): OutboundBufferEntry {
  return {
    channel_id: 'wechat:bot:abc',
    session_id: 'session_a',
    content: 'hi',
    intent: 'info',
    sent_at_attempt_ms: Date.now(),
    ...overrides,
  }
}

describe('dispatchOutboundMessage', () => {
  it('file_path + sandbox mapping → 主机路径再发（不再 silent drop）', async () => {
    const captured: Array<{ method: string; payload: unknown }> = []
    const mappings: PathMapping[] = [
      { sandbox_path: '/sandbox/work', host_path: '/host/work', read_only: false },
    ]
    const deps: OutboundDispatchDeps = {
      rpcClient: {
        call: vi.fn(async (_port: number, method: string, payload: unknown) => {
          captured.push({ method, payload })
          if (method === 'send_message') {
            return { platform_message_id: 'm1', sent_at: '2026-06-08T00:00:00Z' }
          }
          return {}
        }),
      } as never,
      moduleId: 'm',
      resolveChannelPort: async () => 19009,
      getAdminPort: async () => 19001,
      sandboxPathMappingsRef: { current: mappings },
    }

    const entry = makeEntry({
      file_path: '/sandbox/work/output.png',
      filename: 'report.png',
      content_type: 'image',
    })

    const result = await dispatchOutboundMessage(entry, deps)
    expect(result.platform_message_id).toBe('m1')

    const sendCall = captured.find((c) => c.method === 'send_message')
    expect(sendCall).toBeDefined()
    const sendPayload = sendCall!.payload as { content: { type: string; file_path: string; filename: string } }
    expect(sendPayload.content.type).toBe('image')
    expect(sendPayload.content.file_path).toBe('/host/work/output.png') // ← 沙盒→主机
    expect(sendPayload.content.filename).toBe('report.png')
  })

  it('file_path 无 mapping 且绝对路径 → 直接用（本地 unified agent 路径）', async () => {
    const captured: Array<{ method: string; payload: unknown }> = []
    const deps: OutboundDispatchDeps = {
      rpcClient: {
        call: vi.fn(async (_port: number, method: string, payload: unknown) => {
          captured.push({ method, payload })
          if (method === 'send_message') return { platform_message_id: 'm2', sent_at: '' }
          return {}
        }),
      } as never,
      moduleId: 'm',
      resolveChannelPort: async () => 19009,
      getAdminPort: async () => 19001,
      // 不传 sandboxPathMappingsRef
    }

    const entry = makeEntry({ file_path: '/Users/me/file.txt' })
    await dispatchOutboundMessage(entry, deps)
    const sendCall = captured.find((c) => c.method === 'send_message')
    const sendPayload = sendCall!.payload as { content: { file_path: string } }
    expect(sendPayload.content.file_path).toBe('/Users/me/file.txt')
  })

  it('file_path 无 mapping 且相对路径 → 抛错（与 immediate-send 等价行为）', async () => {
    const deps: OutboundDispatchDeps = {
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'm',
      resolveChannelPort: async () => 19009,
      getAdminPort: async () => 19001,
    }
    await expect(
      dispatchOutboundMessage(makeEntry({ file_path: 'rel/path.txt' }), deps),
    ).rejects.toThrow('相对路径需要路径映射配置')
  })

  it('mention 通过 friend_id 反查 admin get_friend → platform_user_id（不再 silent drop）', async () => {
    const captured: Array<{ method: string; payload: unknown }> = []
    const deps: OutboundDispatchDeps = {
      rpcClient: {
        call: vi.fn(async (_port: number, method: string, payload: unknown) => {
          captured.push({ method, payload })
          if (method === 'get_friend') {
            return {
              friend: {
                id: 'f-abc',
                display_name: 'Alice',
                permission: 'normal',
                channel_identities: [
                  { channel_id: 'feishu-001', platform_user_id: 'ou_alice', platform_display_name: 'Alice' },
                ],
              },
            }
          }
          if (method === 'send_message') return { platform_message_id: 'm3', sent_at: '' }
          return {}
        }),
      } as never,
      moduleId: 'm',
      resolveChannelPort: async () => 19009,
      getAdminPort: async () => 19001,
    }

    const entry = makeEntry({
      channel_id: 'feishu-001',
      mentions: [
        { friend_id: 'f-abc', at_name: '@Alice' },
        { platform_user_id: 'ou_bob', at_name: '@Bob' }, // 直传也保留
      ],
    })

    await dispatchOutboundMessage(entry, deps)

    const sendCall = captured.find((c) => c.method === 'send_message')
    const sendPayload = sendCall!.payload as {
      features?: { mentions?: Array<{ platform_user_id: string; at_name?: string }> }
    }
    expect(sendPayload.features?.mentions).toEqual([
      { platform_user_id: 'ou_alice', at_name: '@Alice' }, // friend_id 已反查
      { platform_user_id: 'ou_bob', at_name: '@Bob' },
    ])
  })

  it('mention friend_id 在当前 channel 无 identity → 跳过该 mention（不挂全 entry）', async () => {
    const captured: Array<{ method: string; payload: unknown }> = []
    const deps: OutboundDispatchDeps = {
      rpcClient: {
        call: vi.fn(async (_port: number, method: string, payload: unknown) => {
          captured.push({ method, payload })
          if (method === 'get_friend') {
            return {
              friend: {
                id: 'f-only-wx',
                display_name: 'WxOnly',
                permission: 'normal',
                channel_identities: [
                  { channel_id: 'wechat-001', platform_user_id: 'wxid', platform_display_name: 'X' },
                ],
              },
            }
          }
          if (method === 'send_message') return { platform_message_id: 'm4', sent_at: '' }
          return {}
        }),
      } as never,
      moduleId: 'm',
      resolveChannelPort: async () => 19009,
      getAdminPort: async () => 19001,
    }

    const entry = makeEntry({
      channel_id: 'feishu-001',
      mentions: [{ friend_id: 'f-only-wx', at_name: '@X' }],
    })

    await dispatchOutboundMessage(entry, deps)
    const sendCall = captured.find((c) => c.method === 'send_message')
    const sendPayload = sendCall!.payload as { features?: unknown }
    // mention 全空 → features 不出现
    expect(sendPayload.features).toBeUndefined()
  })

  it('quote_message_id → features.quote_message_id', async () => {
    const captured: Array<{ method: string; payload: unknown }> = []
    const deps: OutboundDispatchDeps = {
      rpcClient: {
        call: vi.fn(async (_port: number, method: string, payload: unknown) => {
          captured.push({ method, payload })
          if (method === 'send_message') return { platform_message_id: 'm5', sent_at: '' }
          return {}
        }),
      } as never,
      moduleId: 'm',
      resolveChannelPort: async () => 19009,
      getAdminPort: async () => 19001,
    }

    await dispatchOutboundMessage(makeEntry({ quote_message_id: 'parent-msg-99' }), deps)
    const sendCall = captured.find((c) => c.method === 'send_message')
    const sendPayload = sendCall!.payload as { features?: { quote_message_id?: string } }
    expect(sendPayload.features?.quote_message_id).toBe('parent-msg-99')
  })

  it('resolveChannelPort 失败 → 抛错', async () => {
    const deps: OutboundDispatchDeps = {
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'm',
      resolveChannelPort: async () => {
        throw new Error('channel down')
      },
      getAdminPort: async () => 19001,
    }
    await expect(dispatchOutboundMessage(makeEntry(), deps)).rejects.toThrow('channel down')
  })
})

describe('createOutboundFlush', () => {
  it('多 entry 之一失败时后续 entry 仍发（reviewer Important #2）', async () => {
    const sentSessions: string[] = []
    let callIndex = 0
    const deps: OutboundDispatchDeps = {
      rpcClient: {
        call: vi.fn(async (_port: number, method: string, payload: unknown) => {
          if (method === 'send_message') {
            callIndex++
            const p = payload as { session_id: string }
            if (callIndex === 1) {
              throw new Error('first entry boom')
            }
            sentSessions.push(p.session_id)
            return { platform_message_id: `m-${callIndex}`, sent_at: '' }
          }
          return {}
        }),
      } as never,
      moduleId: 'm',
      resolveChannelPort: async () => 19009,
      getAdminPort: async () => 19001,
    }

    const buffer: OutboundBufferEntry[] = [
      makeEntry({ session_id: 'sess1', content: 'first' }),
      makeEntry({ session_id: 'sess2', content: 'second' }),
      makeEntry({ session_id: 'sess3', content: 'third' }),
    ]

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const flush = createOutboundFlush(buffer, deps)
    const failures = await flush()

    // 后续 2 个 entry 应该都已发出
    expect(sentSessions).toEqual(['sess2', 'sess3'])
    // buffer 已清空（splice 一次取完，失败的不放回）
    expect(buffer.length).toBe(0)
    // 错误已被 log
    expect(warnSpy).toHaveBeenCalled()
    const warnArgs = warnSpy.mock.calls.flat().map(String).join(' ')
    expect(warnArgs).toContain('first entry boom')
    // 失败 entry 的摘要+原因回传给 caller（不再静默吞掉）——engine 据此注入给 worker
    expect(failures).toHaveLength(1)
    expect(failures[0]!.error).toContain('first entry boom')
    expect(failures[0]!.summary).toContain('first')

    warnSpy.mockRestore()
  })

  it('空 buffer → 不调 rpc / 不报错', async () => {
    const callSpy = vi.fn()
    const deps: OutboundDispatchDeps = {
      rpcClient: { call: callSpy } as never,
      moduleId: 'm',
      resolveChannelPort: async () => 19009,
      getAdminPort: async () => 19001,
    }
    const flush = createOutboundFlush([], deps)
    await flush()
    expect(callSpy).not.toHaveBeenCalled()
  })

  it('所有 entry 成功 → buffer 清空', async () => {
    const deps: OutboundDispatchDeps = {
      rpcClient: {
        call: vi.fn(async (_port: number, method: string) => {
          if (method === 'send_message') return { platform_message_id: 'm', sent_at: '' }
          return {}
        }),
      } as never,
      moduleId: 'm',
      resolveChannelPort: async () => 19009,
      getAdminPort: async () => 19001,
    }
    const buffer: OutboundBufferEntry[] = [makeEntry(), makeEntry({ session_id: 'sess2' })]
    const flush = createOutboundFlush(buffer, deps)
    const failures = await flush()
    expect(buffer.length).toBe(0)
    // 全部成功 → 无失败回传
    expect(failures).toEqual([])
  })
})

// ============================================================================
// §4.13.6 dispatch 钩子点 invariant 测试
// ============================================================================

describe('dispatchOutboundMessage onDispatched 钩子（§4.13.6 Invariant #1 + #2）', () => {
  function successDeps(onDispatched?: (e: OutboundBufferEntry, r: OutboundSendResult) => void): OutboundDispatchDeps {
    return {
      rpcClient: {
        call: vi.fn(async (_port: number, method: string) => {
          if (method === 'send_message') return { platform_message_id: 'mid', sent_at: 'now' }
          return {}
        }),
      } as never,
      moduleId: 'm',
      resolveChannelPort: async () => 19009,
      getAdminPort: async () => 19001,
      ...(onDispatched ? { onDispatched } : {}),
    }
  }

  it('Invariant #1: success 路径触发 onDispatched 恰好 1 次，entry + sendResult 作为参数', async () => {
    const hook = vi.fn()
    const deps = successDeps(hook)
    const entry = makeEntry({ content: 'hello' })

    await dispatchOutboundMessage(entry, deps)

    expect(hook).toHaveBeenCalledOnce()
    // spec A §4.13.7 Revision (3): 钩子签名 (entry, sendResult)；sendResult 含 platform_message_id / sent_at
    expect(hook).toHaveBeenCalledWith(entry, { platform_message_id: 'mid', sent_at: 'now' })
  })

  it('Invariant #2: dispatch 抛错（channel rpc 抛错）不触发钩子', async () => {
    const hook = vi.fn()
    const deps: OutboundDispatchDeps = {
      rpcClient: {
        call: vi.fn(async (_port: number, method: string) => {
          if (method === 'send_message') throw new Error('channel down')
          return {}
        }),
      } as never,
      moduleId: 'm',
      resolveChannelPort: async () => 19009,
      getAdminPort: async () => 19001,
      onDispatched: hook,
    }

    await expect(dispatchOutboundMessage(makeEntry(), deps)).rejects.toThrow('channel down')
    expect(hook).not.toHaveBeenCalled()
  })

  it('Invariant #2: resolveChannelPort 抛错也不触发钩子', async () => {
    const hook = vi.fn()
    const deps: OutboundDispatchDeps = {
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'm',
      resolveChannelPort: async () => { throw new Error('channel not found') },
      getAdminPort: async () => 19001,
      onDispatched: hook,
    }

    await expect(dispatchOutboundMessage(makeEntry(), deps)).rejects.toThrow()
    expect(hook).not.toHaveBeenCalled()
  })

  it('不传 onDispatched（向后兼容）→ dispatch 行为正常', async () => {
    const deps = successDeps(undefined)
    const result = await dispatchOutboundMessage(makeEntry(), deps)
    expect(result.platform_message_id).toBe('mid')
  })

  it('钩子内部抛错被 catch + console.warn，不污染 dispatch 返回', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hook = vi.fn(() => { throw new Error('hook bomb') })
    const deps = successDeps(hook)

    const result = await dispatchOutboundMessage(makeEntry(), deps)

    // dispatch 仍然成功返回（钩子抛错不影响 caller）
    expect(result.platform_message_id).toBe('mid')
    expect(warnSpy).toHaveBeenCalled()
    expect(warnSpy.mock.calls[0][0]).toContain('onDispatched hook threw')

    warnSpy.mockRestore()
  })

  it('createOutboundFlush 多 entry：每条 success entry 都触发钩子；失败 entry 不触发但不阻塞后续', async () => {
    const hook = vi.fn()
    let callCount = 0
    const deps: OutboundDispatchDeps = {
      rpcClient: {
        call: vi.fn(async (_port: number, method: string) => {
          if (method === 'send_message') {
            callCount++
            if (callCount === 2) throw new Error('mid failure')
            return { platform_message_id: `m${callCount}`, sent_at: '' }
          }
          return {}
        }),
      } as never,
      moduleId: 'm',
      resolveChannelPort: async () => 19009,
      getAdminPort: async () => 19001,
      onDispatched: hook,
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const buffer: OutboundBufferEntry[] = [
      makeEntry({ content: 'a' }),
      makeEntry({ content: 'b' }),  // 第 2 条 dispatch 抛错
      makeEntry({ content: 'c' }),
    ]
    await createOutboundFlush(buffer, deps)()

    // 钩子触发 2 次（第 1 / 第 3 entry success），第 2 entry 因抛错不触发
    expect(hook).toHaveBeenCalledTimes(2)
    expect(hook.mock.calls[0][0].content).toBe('a')
    expect(hook.mock.calls[1][0].content).toBe('c')
    expect(buffer.length).toBe(0) // splice 已清空

    warnSpy.mockRestore()
  })
})
