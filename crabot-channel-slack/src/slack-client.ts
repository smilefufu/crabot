import { SocketModeClient } from '@slack/socket-mode'
import { WebClient, LogLevel } from '@slack/web-api'
import { RpcError, proxyManager } from 'crabot-shared'
import type { SlackApi, SlackEnvelope, SlackResult } from './types.js'

// Do not let SDK logs expose tokens, websocket URLs, or raw message payloads.
const logger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} }
export function platformError(error: unknown, fallback = 'CHANNEL_SEND_FAILED'): RpcError {
  const e = error as { code?: string; data?: { error?: string; needed?: string }; retryAfter?: number }
  const reason = e?.data?.error
  if (reason === 'invalid_auth' || reason === 'not_authed' || reason === 'token_revoked' || reason === 'account_inactive') return new RpcError('UNAUTHORIZED', 'Slack 凭据失效，请在 Admin 更新并重启模块')
  if (reason === 'missing_scope' || reason === 'no_permission' || reason === 'not_allowed_token_type' || reason === 'restricted_action' || reason === 'not_in_channel') return new RpcError('PERMISSION_DENIED', 'Slack 应用没有执行此操作的权限', { ...(e.data?.needed ? { missing_scope: e.data.needed } : {}) })
  if (reason === 'user_not_found' || reason === 'channel_not_found') return new RpcError('NOT_FOUND', 'Slack 用户或会话不可见/不存在')
  if (e?.code === 'slack_webapi_rate_limited_error' || reason === 'ratelimited') return new RpcError('RATE_LIMITED', 'Slack 限流，请稍后重试', { retry_after: e.retryAfter })
  // Unknown write outcomes must not expose network strings that upstream retries automatically.
  return new RpcError(fallback, 'Slack 操作失败；发送结果可能未知，请核查后再重试')
}
export class SlackClient implements SlackApi {
  connected = false
  private readonly web: WebClient
  private readonly socket: SocketModeClient
  constructor(botToken: string, appToken: string) {
    this.web = new WebClient(botToken, { logger, timeout: 15000, maxRequestConcurrency: 1, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, allowAbsoluteUrls: false })
    this.socket = new SocketModeClient({ appToken, logger, autoReconnectEnabled: true,
      dispatcher: { dispatch: (options, handler) => proxyManager.getDispatcher().dispatch(options, handler) }, clientOptions: { timeout: 15000, retryConfig: { retries: 2 }, rejectRateLimitedCalls: true } })
    this.socket.on('connected', () => { this.connected = true })
    for (const name of ['disconnected', 'reconnecting', 'error']) this.socket.on(name, () => { this.connected = false })
  }
  async call(method: string, args: Record<string, unknown> = {}): Promise<SlackResult> {
    try { return await this.web.apiCall(method, args) as SlackResult }
    catch (error) {
      let fallback = 'SERVICE_UNAVAILABLE'
      if (method === 'chat.postMessage') fallback = 'CHANNEL_SEND_FAILED'
      if (method === 'users.info') fallback = 'CHANNEL_PLATFORM_USER_QUERY_UNAVAILABLE'
      if (method === 'conversations.open') fallback = 'CHANNEL_PRIVATE_SESSION_UNAVAILABLE'
      throw platformError(error, fallback)
    }
  }
  async start(onEvent: (body: SlackEnvelope) => Promise<void>) {
    this.socket.on('slack_event', async ({ type, body, ack }: { type: string; body: SlackEnvelope; ack: () => Promise<void> }) => {
      if (type !== 'events_api') { await ack().catch(() => {}); return }
      try {
        await ack() // Transport receipt only; neither authorization nor Agent consumption.
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await onEvent(body); return }
          catch { if (attempt === 2) console.error('[Slack] inbound delivery failed after bounded retries') }
        }
      } catch { console.error('[Slack] event acknowledgement failed') }
    })
    try { await this.socket.start() } catch (error) { await this.stop(); throw platformError(error, 'SERVICE_UNAVAILABLE') }
  }
  async stop() { this.connected = false; await this.socket.disconnect() }
}
