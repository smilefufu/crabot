import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWorkerMessagingTools } from '../../src/mcp/crab-messaging.js'

afterEach(() => vi.useRealTimers())
describe('formal voice delivery policy', () => {
  it('rejects message-tool replies to a voice instance before any audio or delivery RPC', async () => {
    const call = vi.fn(async (_port, method) => {
      if (method === 'get_capabilities') return { voice: { protocol_version: 4, send_timeout_ms: 30000 } }
      throw new Error('Unexpected delivery RPC')
    })
    const tools = buildWorkerMessagingTools({ rpcClient: { call } as never, moduleId: 'manager-test', getAdminPort: async () => 1, resolveChannelPort: async () => 2 })
    const send = tools.find(tool => tool.name === 'send_message')!
    expect(send.schema).not.toHaveProperty('voice_reply_context')
    const result = await send.handler({ channel_id: '手机语音', session_id: 'group-1', content: '收到' })
    expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).toContain('voice_reply')
    expect(call.mock.calls.map(args => args[1])).toEqual(['get_capabilities'])
  })
  it('keeps ordinary channel retry behavior without leaking voice or Admin Chat metadata', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const call = vi.fn(async (_port, method, params) => {
      if (method === 'get_capabilities') return {}
      if (++attempts === 1) throw new Error('ECONNRESET')
      expect(params).not.toHaveProperty('voice_reply_context'); expect(params).not.toHaveProperty('request_ids')
      return { platform_message_id: 'delivered', sent_at: new Date().toISOString() }
    })
    const send = buildWorkerMessagingTools({ rpcClient: { call } as never, moduleId: 'manager-test', getAdminPort: async () => 1, resolveChannelPort: async () => 2 }).find(tool => tool.name === 'send_message')!
    const result = send.handler({ channel_id: 'wechat', session_id: 'group', content: '收到' })
    await vi.runAllTimersAsync()
    expect((await result).isError).not.toBe(true); expect(attempts).toBe(2)
  })
})
