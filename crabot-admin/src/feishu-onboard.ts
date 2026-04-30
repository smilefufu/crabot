/**
 * FeishuOnboard - 飞书设备码 OAuth 客户端
 *
 * 实现 spec 2026-04-30-native-feishu-channel-design.md §5：
 * - init: 校验 supported_auth_methods
 * - begin: 拿 device_code + verification_uri
 * - poll (async iterable): 按 interval 轮询，发出 pending / slow_down / success / error 事件
 * - finish: 把 result 喂给 channelManager.createInstance
 *
 * 端点来源：参考 @larksuite/openclaw-lark-tools 1.0.39 的实现
 *   POST https://open.feishu.cn/oauth/v1/app/registration
 *   Content-Type: application/x-www-form-urlencoded
 *   action ∈ init | begin | poll
 */

import { randomUUID } from 'node:crypto'

export type FeishuDomain = 'feishu' | 'lark'

export interface PollEventPending {
  type: 'pending'
}
export interface PollEventSlowDown {
  type: 'slow_down'
}
export interface PollEventSuccess {
  type: 'success'
  app_id: string
  app_secret: string
  open_id: string
  domain: FeishuDomain
}
export interface PollEventError {
  type: 'error'
  code: string
  message?: string
}
export type PollEvent = PollEventPending | PollEventSlowDown | PollEventSuccess | PollEventError

interface OnboardSession {
  device_code: string
  base_url: string
  domain: FeishuDomain
  interval: number
  expires_at: number
  result?: { app_id: string; app_secret: string; open_id: string; domain: FeishuDomain }
}

export interface BeginResult {
  session_id: string
  verification_uri: string
  interval: number
  expires_at: number
}

export interface ChannelManagerLike {
  createInstance: (params: {
    implementation_id: string
    name: string
    auto_start?: boolean
    env: Record<string, string>
  }) => Promise<unknown>
}

export interface FeishuOnboardOptions {
  channelManager?: ChannelManagerLike
  /** 注入 fetch 用于测试；默认 globalThis.fetch */
  fetchImpl?: typeof fetch
  /** 注入 delay 实现（毫秒）。测试中可改成 noop 跳过等待 */
  delayMs?: (ms: number) => Promise<void>
}

const SESSION_TTL_MS = 10 * 60 * 1000
const GC_INTERVAL_MS = 60 * 1000

const BASE_BY_DOMAIN: Record<FeishuDomain, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
}

export class FeishuOnboard {
  private sessions = new Map<string, OnboardSession>()
  private gcTimer: NodeJS.Timeout | null = null
  private channelManager: ChannelManagerLike | undefined
  private fetchImpl: typeof fetch
  private delay: (ms: number) => Promise<void>

  constructor(opts: FeishuOnboardOptions = {}) {
    this.channelManager = opts.channelManager
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.delay = opts.delayMs ?? defaultDelay
  }

  setChannelManager(cm: ChannelManagerLike): void {
    this.channelManager = cm
  }

  startGc(): void {
    if (this.gcTimer) return
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS)
    if (this.gcTimer && typeof this.gcTimer === 'object' && 'unref' in this.gcTimer) {
      ;(this.gcTimer as NodeJS.Timeout).unref()
    }
  }

  stopGc(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer)
      this.gcTimer = null
    }
  }

  /** 启动一次扫码会话：先 init，再 begin */
  async begin(opts?: { domain?: FeishuDomain }): Promise<BeginResult> {
    const domain: FeishuDomain = opts?.domain === 'lark' ? 'lark' : 'feishu'
    const baseUrl = BASE_BY_DOMAIN[domain]

    // init
    const initResp = await this.callRegistration(baseUrl, { action: 'init' })
    const methods = (initResp.supported_auth_methods as string[] | undefined) ?? []
    if (!methods.includes('client_secret')) {
      throw new Error(`飞书 OAuth 不支持 client_secret 模式（supported=${methods.join(',') || '无'}）`)
    }

    // begin
    const beginResp = await this.callRegistration(baseUrl, {
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    })
    const deviceCode = beginResp.device_code as string | undefined
    const verifUri = beginResp.verification_uri_complete as string | undefined
    if (!deviceCode || !verifUri) {
      throw new Error('飞书 OAuth begin 响应缺少 device_code / verification_uri_complete')
    }
    const interval = Number(beginResp.interval) || 2
    const expireIn = Number(beginResp.expire_in) || 600

    const sessionId = randomUUID()
    this.sessions.set(sessionId, {
      device_code: deviceCode,
      base_url: baseUrl,
      domain,
      interval,
      expires_at: Date.now() + expireIn * 1000,
    })

    return {
      session_id: sessionId,
      verification_uri: appendQuery(verifUri, 'from=onboard'),
      interval,
      expires_at: Date.now() + expireIn * 1000,
    }
  }

  /** 轮询授权结果（async generator） */
  async *poll(sessionId: string): AsyncIterable<PollEvent> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      yield { type: 'error', code: 'session_not_found' }
      return
    }

    let interval = session.interval

    while (true) {
      if (Date.now() > session.expires_at) {
        yield { type: 'error', code: 'expired_token' }
        return
      }

      let resp: Record<string, unknown>
      try {
        resp = await this.callRegistration(session.base_url, {
          action: 'poll',
          device_code: session.device_code,
        })
      } catch (err) {
        yield { type: 'error', code: 'unknown', message: err instanceof Error ? err.message : String(err) }
        return
      }

      const errCode = (resp.error as string | undefined) ?? ''
      const clientId = resp.client_id as string | undefined
      const clientSecret = resp.client_secret as string | undefined

      if (clientId && clientSecret) {
        const userInfo = (resp.user_info as Record<string, unknown> | undefined) ?? {}
        const openId = (userInfo.open_id as string | undefined) ?? ''
        const tenantBrand = (userInfo.tenant_brand as string | undefined) ?? ''
        const domain: FeishuDomain = tenantBrand === 'lark' ? 'lark' : session.domain
        session.result = { app_id: clientId, app_secret: clientSecret, open_id: openId, domain }
        yield { type: 'success', app_id: clientId, app_secret: clientSecret, open_id: openId, domain }
        return
      }

      if (errCode === 'authorization_pending' || errCode === '') {
        yield { type: 'pending' }
      } else if (errCode === 'slow_down') {
        interval += 5
        yield { type: 'slow_down' }
      } else if (errCode === 'access_denied') {
        yield { type: 'error', code: 'access_denied' }
        return
      } else if (errCode === 'expired_token') {
        yield { type: 'error', code: 'expired_token' }
        return
      } else {
        yield { type: 'error', code: 'unknown', message: (resp.error_description as string | undefined) ?? errCode }
        return
      }

      await this.delay(interval * 1000)
    }
  }

  async finish(sessionId: string, params: { name: string }): Promise<unknown> {
    const session = this.sessions.get(sessionId)
    if (!session?.result) throw new Error('会话不存在或尚未完成扫码')
    if (!this.channelManager) throw new Error('channelManager 未注入')
    const { app_id, app_secret, open_id, domain } = session.result
    const env: Record<string, string> = {
      FEISHU_APP_ID: app_id,
      FEISHU_APP_SECRET: app_secret,
      FEISHU_DOMAIN: domain,
      FEISHU_ONLY_RESPOND_TO_MENTIONS: 'true',
    }
    if (open_id) env.FEISHU_OWNER_OPEN_ID = open_id

    const instance = await this.channelManager.createInstance({
      implementation_id: 'channel-feishu',
      name: params.name,
      auto_start: true,
      env,
    })
    this.sessions.delete(sessionId)
    return instance
  }

  cancel(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private async callRegistration(baseUrl: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const params = new URLSearchParams(body)
    const resp = await this.fetchImpl(`${baseUrl}/oauth/v1/app/registration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    let json: Record<string, unknown> = {}
    try {
      json = (await resp.json()) as Record<string, unknown>
    } catch {
      // ignore
    }
    if (!resp.ok && !json.error) {
      throw new Error(`飞书 OAuth ${body.action} 请求失败: HTTP ${resp.status}`)
    }
    return json
  }

  private gc(): void {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      if (s.expires_at + SESSION_TTL_MS < now) this.sessions.delete(id)
    }
  }
}

function appendQuery(uri: string, query: string): string {
  const sep = uri.includes('?') ? '&' : '?'
  return `${uri}${sep}${query}`
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
