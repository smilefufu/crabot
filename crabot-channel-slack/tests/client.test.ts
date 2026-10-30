import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ handlers: new Map<string, Function>(), call: vi.fn(), start: vi.fn(), stop: vi.fn(), webOptions: {} as any, socketOptions: {} as any }))
vi.mock('@slack/web-api', () => ({ LogLevel: { ERROR: 'error' }, WebClient: class {
  constructor(_token: string, options: unknown) { state.webOptions = options }
  apiCall = state.call
} }))
vi.mock('@slack/socket-mode', () => ({ SocketModeClient: class {
  constructor(options: unknown) { state.socketOptions = options }
  on(name: string, callback: Function) { state.handlers.set(name, callback) }
  start = state.start
  disconnect = state.stop
} }))
import { proxyManager } from 'crabot-shared'
import { SlackClient, platformError } from '../src/slack-client.js'
beforeEach(() => { state.handlers.clear(); vi.clearAllMocks() })
describe('Slack official SDK boundary',()=>{
  it('routes socket connections through the currently configured shared dispatcher rather than an SDK direct Agent', () => {
    new SlackClient('xoxb-fixture', 'xapp-fixture')
    expect(state.socketOptions.dispatcher).toBeDefined()
    const first = { dispatch: vi.fn(() => true) }, second = { dispatch: vi.fn(() => true) }
    const current = vi.spyOn(proxyManager, 'getDispatcher').mockReturnValueOnce(first as never).mockReturnValueOnce(second as never)
    try {
      const options = { origin: 'https://fixture.invalid', path: '/', method: 'GET' }, handler = {}
      state.socketOptions.dispatcher.dispatch(options, handler)
      state.socketOptions.dispatcher.dispatch(options, handler)
      expect(first.dispatch).toHaveBeenCalledWith(options, handler)
      expect(second.dispatch).toHaveBeenCalledWith(options, handler)
    } finally { current.mockRestore() }
  })
  it('uses SDK v3 slack_event, ACKs before dispatch and bounds retries',async()=>{
    const client = new SlackClient('xoxb-secret','xapp-secret'), deliver=vi.fn().mockRejectedValueOnce(new Error('MM down')).mockResolvedValue(undefined), ack=vi.fn()
    await client.start(deliver)
    expect(state.handlers.has('slack_event')).toBe(true)
    expect(state.handlers.has('events_api')).toBe(false)
    const body={team_id:'T1',event:{type:'message'}}
    await state.handlers.get('slack_event')!({type:'events_api',body,ack})
    expect(ack).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(ack.mock.invocationCallOrder[0]).toBeLessThan(deliver.mock.invocationCallOrder[0])
    expect(state.webOptions.retryConfig.retries).toBe(0)
    expect(state.webOptions.rejectRateLimitedCalls).toBe(true)
    state.handlers.get('connected')!()
    expect(client.connected).toBe(true)
    state.handlers.get('reconnecting')!()
    expect(client.connected).toBe(false)
    await client.stop()
    expect(state.stop).toHaveBeenCalledOnce()
  })
  it('cleans up a failed socket start without leaking SDK secrets',async()=>{
    state.start.mockRejectedValueOnce(new Error('xapp-secret token wss://secret'))
    const client=new SlackClient('xoxb-secret','xapp-secret')
    await expect(client.start(vi.fn())).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'})
    expect(state.stop).toHaveBeenCalledOnce()
  })
  it('maps permissions and Retry-After explicitly, sanitizes unknown network write errors',async()=>{
    const missing=platformError({data:{error:'missing_scope',needed:'groups:read'}})
    expect(missing).toMatchObject({code:'PERMISSION_DENIED',details:{missing_scope:'groups:read'}})
    expect(platformError({code:'slack_webapi_rate_limited_error',retryAfter:7})).toMatchObject({code:'RATE_LIMITED',details:{retry_after:7}})
    const client=new SlackClient('xoxb-secret','xapp-secret')
    state.call.mockRejectedValueOnce(new Error('ECONNRESET token=xoxb-secret'))
    await expect(client.call('chat.postMessage',{channel:'C1',text:'x'})).rejects.toMatchObject({code:'CHANNEL_SEND_FAILED',message:expect.not.stringMatching(/ECONNRESET|secret/)})
    expect(state.call).toHaveBeenCalledOnce()
  })
})
