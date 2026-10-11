import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWorkerMessagingTools } from '../../src/mcp/crab-messaging.js'

afterEach(() => vi.useRealTimers())
describe('formal voice delivery policy', () => {
  it('uses arbitrary instance capability, injects runtime context only on the matching group, and never retries interrupted playback', async () => {
    const context = { channel_id: '客厅', session_id: 'group-1', turn_id: 'turn-1', connection_epoch: 'epoch-1', expires_at: new Date(Date.now() + 50000).toISOString() }
    const call = vi.fn(async (_port, method) => {
      if (method === 'get_capabilities') return { voice: { protocol_version: 1, send_timeout_ms: 30000 } }
      throw new Error('ECONNRESET after playback started')
    })
    const tools = buildWorkerMessagingTools({ rpcClient: { call } as never, moduleId: 'manager-test', getAdminPort: async () => 1, resolveChannelPort: async () => 2, voiceReplyContext: () => context })
    const send = tools.find(tool => tool.name === 'send_message')!
    expect(send.schema).not.toHaveProperty('voice_reply_context')
    const result = await send.handler({ channel_id: '客厅', session_id: 'group-1', content: '收到' })
    expect(result.isError).toBe(true)
    const sends = call.mock.calls.filter(args => args[1] === 'send_message')
    expect(sends).toHaveLength(1)
    expect(sends[0][2]).toMatchObject({ voice_reply_context: context })
    expect(sends[0][5]).toEqual({ timeoutMs: 30000 })
    call.mockClear()
    expect((await send.handler({ channel_id: '客厅', session_id: 'other-group', content: '不要播' })).isError).toBe(true)
    expect(call.mock.calls.filter(args => args[1] === 'send_message')).toEqual([])
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
