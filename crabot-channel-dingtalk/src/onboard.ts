/**
 * 钉钉引导式 onboarding
 *
 * 由 admin 在用户进入 onboarding 流程时 require()，不通过 RPC 暴露。
 * 实现 base-protocol §10 的 Onboarder 接口。
 *
 * 钉钉企业内部应用**没有设备码 OAuth**（不同于飞书扫码），因此这是一个「引导式表单」：
 *   1. begin：返回图文步骤（建企业内部应用 → 加机器人能力 → 消息接收模式选 Stream → 发布 → 记下 AppKey/AppSecret/robotCode）
 *   2. poll：表单式无后台验证轮询，直接就绪，等用户在前端把凭据填进 finish
 *   3. finish(app_key, app_secret, robot_code)：调 accessToken 端点校验凭据有效性，返回写入 channel-config 的 env
 *
 * 注：auto-master（主人私聊机器人发「绑定」自动认主）是**运行时**行为——onboarding 在
 * 模块启动前运行，拿不到发送者 staffId，故不在此实现；owner_staff_id 由运行时/手动补齐。
 */

import { randomUUID } from 'node:crypto'
import type {
  Onboarder,
  OnboarderBeginResult,
  OnboarderEvent,
  OnboarderFactory,
  OnboarderFinishResult,
} from 'crabot-shared'

const OAUTH_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const SESSION_TTL_MS = 30 * 60 * 1000
const GC_INTERVAL_MS = 60 * 1000

const GUIDE_STEPS: readonly string[] = [
  '1. 打开钉钉开发者后台 open-dev.dingtalk.com，创建「企业内部应用」。',
  '2. 在应用能力里添加「机器人」，消息接收模式选择 **Stream 模式**（无需公网回调地址）。',
  '3. 发布 / 上线应用，使机器人生效。',
  '4. 在「凭证与基础信息」记下 AppKey、AppSecret；在机器人配置页记下 robotCode。',
  '5. 把这三项填入下一步表单，Crabot 会校验后自动完成配置。',
]

interface OnboardSession {
  created_at: number
}

export interface DingtalkOnboarderOptions {
  /** 注入 fetch 用于测试 */
  fetchImpl?: typeof fetch
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export class DingtalkOnboarder implements Onboarder {
  private sessions = new Map<string, OnboardSession>()
  private gcTimer: NodeJS.Timeout | null = null
  private fetchImpl: typeof fetch

  constructor(opts: DingtalkOnboarderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
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

  async begin(): Promise<OnboarderBeginResult> {
    const sessionId = randomUUID()
    this.sessions.set(sessionId, { created_at: Date.now() })
    return {
      session_id: sessionId,
      ui_mode: 'pending',
      display: {
        title: '配置钉钉机器人（Stream 模式）',
        description: GUIDE_STEPS.join('\n'),
      },
    }
  }

  async *poll(sessionId: string): AsyncIterable<OnboarderEvent> {
    if (!this.sessions.has(sessionId)) {
      yield { type: 'error', code: 'session_not_found' }
      return
    }
    // 表单式 onboarding：无后台验证轮询，直接就绪，等用户在 finish 提交凭据
    yield { type: 'success' }
  }

  async finish(sessionId: string, params?: Record<string, unknown>): Promise<OnboarderFinishResult> {
    if (!this.sessions.has(sessionId)) {
      throw new Error('会话不存在或已过期')
    }
    const appKey = asString(params?.app_key ?? params?.DINGTALK_APP_KEY)
    const appSecret = asString(params?.app_secret ?? params?.DINGTALK_APP_SECRET)
    const robotCode = asString(params?.robot_code ?? params?.DINGTALK_ROBOT_CODE)
    if (!appKey || !appSecret || !robotCode) {
      throw new Error('请填写 AppKey / AppSecret / robotCode')
    }

    await this.validateCredentials(appKey, appSecret)

    this.sessions.delete(sessionId)
    return {
      env: {
        DINGTALK_APP_KEY: appKey,
        DINGTALK_APP_SECRET: appSecret,
        DINGTALK_ROBOT_CODE: robotCode,
        DINGTALK_ONLY_RESPOND_TO_MENTIONS: 'true',
      },
      suggested_name: '钉钉',
    }
  }

  cancel(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** 调 accessToken 端点校验 AppKey/AppSecret；失败抛错 */
  private async validateCredentials(appKey: string, appSecret: string): Promise<void> {
    const res = await this.fetchImpl(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey, appSecret }),
    })
    let data: Record<string, unknown> = {}
    try {
      data = (await res.json()) as Record<string, unknown>
    } catch {
      // ignore parse error, handled by the check below
    }
    if (!res.ok || typeof data.accessToken !== 'string' || !data.accessToken) {
      const msg = typeof data.message === 'string' ? data.message : `HTTP ${res.status}`
      throw new Error(`钉钉凭据校验失败：${msg}`)
    }
  }

  private gc(): void {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      if (s.created_at + SESSION_TTL_MS < now) this.sessions.delete(id)
    }
  }
}

/** Onboarder 工厂——admin 通过该函数创建实例 */
export const createOnboarder: OnboarderFactory = () => new DingtalkOnboarder()
