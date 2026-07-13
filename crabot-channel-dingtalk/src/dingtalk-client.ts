/**
 * DingtalkClient - 钉钉出站 REST API 封装（原生 fetch，无第三方 SDK）
 *
 * 职责：
 * - access_token 内存缓存 + 过期前自动刷新（oauth2/accessToken）
 * - 群聊发送（robot/groupMessages/send）、单聊发送（robot/oToMessages/batchSend）
 * - 媒体下载换取 downloadUrl（robot/messageFiles/download）
 * - 业务错误映射为带 .code 的 DingtalkClientError（对齐 protocol-channel 错误码）
 *
 * 所有业务调用带 header `x-acs-dingtalk-access-token`。auth 失效时清缓存并重试一次。
 */

const OAUTH_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const GROUP_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
const OTO_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'
const MEDIA_DOWNLOAD_URL = 'https://api.dingtalk.com/v1.0/robot/messageFiles/download'

/** 提前 60s 刷新 token，避免边界失效 */
const TOKEN_REFRESH_SKEW_MS = 60_000
/** token 缺省有效期（秒），响应未给 expireIn 时兜底 */
const DEFAULT_TOKEN_TTL_SEC = 7200

export type SendMsgKey = 'sampleText' | 'sampleMarkdown'

/** 带错误码的客户端错误，code 对齐 protocol-channel / base-protocol 错误码 */
export class DingtalkClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'DingtalkClientError'
  }
}

export interface DingtalkClientOptions {
  appKey: string
  appSecret: string
  robotCode: string
  /** 可注入（测试用），默认 globalThis.fetch */
  fetchImpl?: typeof fetch
  /** 可注入（测试用），默认 Date.now */
  now?: () => number
}

/** 把 DingTalk 返回的 code / HTTP status 映射到 protocol-channel 错误码 */
function mapDingtalkError(httpStatus: number, apiCode: string | undefined): string {
  const code = (apiCode ?? '').toLowerCase()
  if (httpStatus === 401 || code.includes('auth') || code.includes('token')) {
    return 'PERMISSION_DENIED'
  }
  if (httpStatus === 403 || code.includes('forbidden') || code.includes('permission')) {
    return 'PERMISSION_DENIED'
  }
  if (httpStatus === 404 || code.includes('notfound') || code.includes('not_found')) {
    return 'NOT_FOUND'
  }
  if (httpStatus === 429 || code.includes('limit') || code.includes('flowcontrol')) {
    return 'RATE_LIMITED'
  }
  return 'CHANNEL_SEND_FAILED'
}

export class DingtalkClient {
  private token: string | null = null
  private tokenExpiresAt = 0 // epoch ms
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  /** 并发首取去重：多个并发调用共享同一次 token 请求，避免打爆 accessToken 端点被限流 */
  private tokenInflight: Promise<string> | null = null

  constructor(private readonly opts: DingtalkClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
    this.now = opts.now ?? (() => Date.now())
  }

  /** 拿有效 access_token，命中缓存则不发请求；并发时复用同一个 in-flight 请求 */
  async getAccessToken(): Promise<string> {
    if (this.token && this.now() < this.tokenExpiresAt - TOKEN_REFRESH_SKEW_MS) {
      return this.token
    }
    if (this.tokenInflight) return this.tokenInflight
    this.tokenInflight = this.fetchAccessToken().finally(() => {
      this.tokenInflight = null
    })
    return this.tokenInflight
  }

  private async fetchAccessToken(): Promise<string> {
    const res = await this.fetchImpl(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.opts.appKey, appSecret: this.opts.appSecret }),
    })
    const data = await this.readJson(res)
    if (!res.ok) {
      throw new DingtalkClientError(
        mapDingtalkError(res.status, data?.code as string | undefined),
        `accessToken failed: ${res.status} ${(data?.message as string) ?? ''}`.trim(),
        { status: res.status, api_code: data?.code }
      )
    }
    const accessToken = data?.accessToken
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new DingtalkClientError('CHANNEL_SEND_FAILED', 'accessToken missing in response', { data })
    }
    const expireIn = typeof data?.expireIn === 'number' ? data.expireIn : DEFAULT_TOKEN_TTL_SEC
    this.token = accessToken
    this.tokenExpiresAt = this.now() + expireIn * 1000
    return accessToken
  }

  /** 群聊发送，返回 processQueryKey（非真实 message_id） */
  async sendGroupMessage(
    openConversationId: string,
    msgKey: SendMsgKey,
    msgParam: Record<string, unknown>
  ): Promise<string> {
    const data = await this.postRobot(GROUP_SEND_URL, {
      robotCode: this.opts.robotCode,
      openConversationId,
      msgKey,
      msgParam: JSON.stringify(msgParam),
    })
    return (data?.processQueryKey as string) ?? ''
  }

  /** 单聊发送（批量给 userIds），返回 processQueryKey */
  async sendOneToOneMessage(
    userIds: string[],
    msgKey: SendMsgKey,
    msgParam: Record<string, unknown>
  ): Promise<string> {
    const data = await this.postRobot(OTO_SEND_URL, {
      robotCode: this.opts.robotCode,
      userIds,
      msgKey,
      msgParam: JSON.stringify(msgParam),
    })
    // batchSend 成功仍是 HTTP 200，但未达者落在 invalid/flowControlled 列表；
    // 若全部收件人都未达（单发=唯一收件人未达）视为失败，避免"失败当成功"。
    const invalid = Array.isArray(data?.invalidStaffIdList) ? (data.invalidStaffIdList as unknown[]).map(String) : []
    const flow = Array.isArray(data?.flowControlledStaffIdList) ? (data.flowControlledStaffIdList as unknown[]).map(String) : []
    const failed = new Set([...invalid, ...flow])
    if (userIds.length > 0 && userIds.every((u) => failed.has(u))) {
      throw new DingtalkClientError(
        flow.length > 0 && invalid.length === 0 ? 'RATE_LIMITED' : 'CHANNEL_SEND_FAILED',
        `oTo 消息未投递：invalid=${JSON.stringify(invalid)} flowControlled=${JSON.stringify(flow)}`,
        { invalid, flow }
      )
    }
    return (data?.processQueryKey as string) ?? ''
  }

  /** 用 downloadCode 换取临时 downloadUrl（随后 GET 下载文件内容） */
  async getMediaDownloadUrl(downloadCode: string): Promise<string> {
    const data = await this.postRobot(MEDIA_DOWNLOAD_URL, {
      downloadCode,
      robotCode: this.opts.robotCode,
    })
    const url = data?.downloadUrl
    if (typeof url !== 'string' || !url) {
      throw new DingtalkClientError('CHANNEL_SEND_FAILED', 'downloadUrl missing in response', { data })
    }
    return url
  }

  /** 直接 POST 到会话 sessionWebhook（免 token 的即时回复兜底路径） */
  async sendViaSessionWebhook(
    sessionWebhook: string,
    body: Record<string, unknown>
  ): Promise<void> {
    const res = await this.fetchImpl(sessionWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    // 旧版 webhook 业务失败是 HTTP 200 + errcode≠0，不能只看 res.ok，否则"失败当成功"
    const data = await this.readJson(res)
    const errcode = typeof data?.errcode === 'number' ? data.errcode : 0
    if (!res.ok || errcode !== 0) {
      throw new DingtalkClientError(
        mapDingtalkError(res.status, (data?.code as string | undefined) ?? (errcode ? String(errcode) : undefined)),
        `sessionWebhook send failed: status=${res.status} errcode=${errcode} ${(data?.errmsg as string) ?? ''}`.trim(),
        { status: res.status, errcode }
      )
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** 带 token 的机器人 API POST，auth 失效清缓存重试一次 */
  private async postRobot(
    url: string,
    body: Record<string, unknown>,
    isRetry = false
  ): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken()
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify(body),
    })
    const data = await this.readJson(res)
    if (res.ok) return data ?? {}

    const mapped = mapDingtalkError(res.status, data?.code as string | undefined)
    // auth 失效：清缓存并重试一次
    if (mapped === 'PERMISSION_DENIED' && !isRetry) {
      this.token = null
      this.tokenExpiresAt = 0
      return this.postRobot(url, body, true)
    }
    throw new DingtalkClientError(
      mapped,
      `dingtalk api ${url} failed: ${res.status} ${(data?.message as string) ?? ''}`.trim(),
      { status: res.status, api_code: data?.code }
    )
  }

  private async readJson(res: Response): Promise<Record<string, unknown> | undefined> {
    try {
      return (await res.json()) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
}
