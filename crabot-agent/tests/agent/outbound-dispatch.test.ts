/**
 * outbound-dispatch helper 单测。
 *
 * 覆盖 dispatchOutboundMessage 的核心契约：
 * - file_path + sandbox path mapping 走主机路径转换（不再 silent drop）
 * - friend_id-only mention 走 admin get_friend 反查（不再 silent drop）
 */
import { describe, it, expect, vi } from 'vitest'
import {
  dispatchOutboundMessage,
  type OutboundMessage,
  type OutboundDispatchDeps,
  type OutboundSendResult,
  type PathMapping,
} from '../../src/agent/outbound-dispatch.js'

function makeEntry(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
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

  it('admin-chat delivery：wire payload 与 prepare 落盘的 staged payload 同源（§11.7）', async () => {
    const captured: Array<{ method: string; payload: unknown }> = []
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
      sandboxPathMappingsRef: { current: [] },
      adminChatDelivery: {
        // prepare 把 file_path 改写成 staging 路径；wire 必须发改写后的版本，
        // 否则重启重放（发 staged 版）会被 Admin payload_sha256 校验判成 CONFLICT。
        prepare: vi.fn(async (_entry, content) => ({
          delivery_id: 'd1',
          request_ids: ['r1'],
          content: { ...content, file_path: '/agent-data/staging/d1/attachment.abc123' },
        })),
        confirm: vi.fn(async () => {}),
        fail: vi.fn(async () => {}),
      },
    }

    const entry = makeEntry({
      channel_id: 'admin-web',
      session_id: 'admin-chat',
      file_path: '/host/work/output.png',
      filename: 'report.png',
      content_type: 'image',
    })
    await dispatchOutboundMessage(entry, deps)

    const sendCall = captured.find((c) => c.method === 'send_message')
    const sendPayload = sendCall!.payload as { content: { file_path?: string }; delivery_id?: string; request_ids?: string[] }
    expect(sendPayload.delivery_id).toBe('d1')
    expect(sendPayload.request_ids).toEqual(['r1'])
    expect(sendPayload.content.file_path).toBe('/agent-data/staging/d1/attachment.abc123')
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


// ============================================================================
// dispatch completion hook tests
// ============================================================================

describe('dispatchOutboundMessage onDispatched hook', () => {
  function successDeps(onDispatched?: (e: OutboundMessage, r: OutboundSendResult) => void): OutboundDispatchDeps {
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

  it('success 路径触发 onDispatched 恰好 1 次，entry + sendResult 作为参数', async () => {
    const hook = vi.fn()
    const deps = successDeps(hook)
    const entry = makeEntry({ content: 'hello' })

    await dispatchOutboundMessage(entry, deps)

    expect(hook).toHaveBeenCalledOnce()
    expect(hook).toHaveBeenCalledWith(entry, { platform_message_id: 'mid', sent_at: 'now' })
  })

  it('dispatch 抛错（channel rpc 抛错）不触发钩子', async () => {
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

  it('resolveChannelPort 抛错也不触发钩子', async () => {
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

})
