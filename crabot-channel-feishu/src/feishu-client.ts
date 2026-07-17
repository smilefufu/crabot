/**
 * FeishuClient - lark.Client 的薄封装
 *
 * 提供 channel 层需要的高阶 API：
 * - 应用信息：getBotInfo
 * - 群 / 用户：listChats / getChatMembers / getUser
 * - 收发消息：sendText / sendImage / sendFile / reply
 * - 上传 / 下载：uploadImage / uploadFile / downloadResource
 *
 * 错误：把 lark SDK 的 throw 翻译为带 code 的 Error，channel 层据此映射到 protocol-channel.md 的错误码。
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { Readable } from 'node:stream'
import { RpcError } from 'crabot-shared'
import type { FeishuDomain } from './types.js'

export interface SendReceive {
  type: 'open_id' | 'chat_id' | 'union_id' | 'user_id'
  id: string
}

export interface SendResult {
  message_id: string
  create_time: string
}

export interface FeishuClientErrorOpts {
  code: string
  message: string
  cause?: unknown
  feishu_code?: number
  feishu_message?: string
}

export class FeishuClientError extends Error {
  code: string
  cause?: unknown
  feishu_code?: number
  feishu_message?: string
  constructor(opts: FeishuClientErrorOpts) {
    super(opts.message)
    this.name = 'FeishuClientError'
    this.code = opts.code
    this.cause = opts.cause
    this.feishu_code = opts.feishu_code
    this.feishu_message = opts.feishu_message
  }
}

export interface ChatListItem {
  chat_id: string
  name: string
  /** chat_mode 在 lark.list 中没直接返回；这里固定 'group' 以方便 channel 端 bootstrap */
  chat_mode: 'group'
}

export class FeishuClient {
  private readonly client: lark.Client

  constructor(opts: { app_id: string; app_secret: string; domain: FeishuDomain }) {
    this.client = new lark.Client({
      appId: opts.app_id,
      appSecret: opts.app_secret,
      domain: opts.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      disableTokenCache: false,
      logger: createLarkLogger(),
    })
  }

  /**
   * 通过 /open-apis/bot/v3/info/ 拿当前 bot 的 app_id / app_name / open_id。
   * 开放 SDK 没有这条端点的强类型方法，用底层 request。
   */
  async getBotInfo(): Promise<{ app_id: string; app_name: string; open_id: string }> {
    const resp = await this.client.request<{ code?: number; msg?: string; bot?: { activate_status?: number; app_name?: string; avatar_url?: string; ip_white_list?: string[]; open_id?: string; app_id?: string } }>({
      url: '/open-apis/bot/v3/info/',
      method: 'GET',
    })
    if (resp.code && resp.code !== 0) {
      throw new FeishuClientError({ code: 'CHANNEL_AUTH_FAILED', message: resp.msg ?? `bot info failed (code=${resp.code})` })
    }
    const bot = resp.bot ?? {}
    return {
      app_id: bot.app_id ?? '',
      app_name: bot.app_name ?? '',
      open_id: bot.open_id ?? '',
    }
  }

  // ── chats ──────────────────────────────────────────────────────────────────

  /** 取单个 chat 详情：/open-apis/im/v1/chats/{chat_id}。仅用 name 字段做群名解析 */
  async getChat(chatId: string): Promise<{ chat_id: string; name: string }> {
    try {
      const resp = await this.client.im.chat.get({ path: { chat_id: chatId } })
      return {
        chat_id: chatId,
        name: resp.data?.name ?? '',
      }
    } catch (err: unknown) {
      mapFeishuPermissionError(err, 'im:chat:readonly', '飞书应用缺少群信息读取权限')
      throw err
    }
  }

  async listChats(params?: { page_token?: string; page_size?: number }): Promise<{ items: ChatListItem[]; page_token?: string; has_more: boolean }> {
    const resp = await this.client.im.chat.list({ params: { page_size: params?.page_size ?? 50, page_token: params?.page_token } })
    if (!resp.data) return { items: [], has_more: false }
    return {
      items: (resp.data.items ?? []).map((it) => ({
        chat_id: it.chat_id ?? '',
        name: it.name ?? '',
        chat_mode: 'group',
      })),
      page_token: resp.data.page_token,
      has_more: !!resp.data.has_more,
    }
  }

  async listContacts(params: {
    page_token?: string
    page_size?: number
  }): Promise<{
    items: Array<{ open_id: string; name: string; avatar_url?: string }>
    page_token?: string
    has_more: boolean
  }> {
    try {
      const resp = await this.client.contact.v3.user.list({
        params: {
          page_size: params.page_size ?? 50,
          page_token: params.page_token,
        },
      })
      const data = resp.data ?? {}
      const items = (data.items ?? []).map((it) => ({
        open_id: it.open_id ?? '',
        name: it.name ?? '',
        ...(it.avatar?.avatar_72 ? { avatar_url: it.avatar.avatar_72 } : {}),
      }))
      return {
        items,
        page_token: data.page_token,
        has_more: data.has_more ?? false,
      }
    } catch (err: unknown) {
      mapFeishuPermissionError(err, 'contact:user.base:readonly', '飞书应用缺少通讯录读取权限')
      throw err
    }
  }

  async getChatMembers(chatId: string): Promise<Array<{ open_id: string; name: string }>> {
    try {
      const all: Array<{ open_id: string; name: string }> = []
      let pageToken: string | undefined = undefined
      while (true) {
        const resp = await this.client.im.chatMembers.get({
          path: { chat_id: chatId },
          params: { member_id_type: 'open_id', page_size: 100, page_token: pageToken },
        })
        const items = resp.data?.items ?? []
        for (const it of items) {
          if (it.member_id) all.push({ open_id: it.member_id, name: it.name ?? '' })
        }
        if (!resp.data?.has_more) break
        pageToken = resp.data?.page_token
        if (!pageToken) break
      }
      return all
    } catch (err: unknown) {
      mapFeishuPermissionError(err, 'im:chat.members:read', '飞书应用缺少群成员读取权限')
      throw err
    }
  }

  async getUser(openId: string): Promise<{ open_id: string; name: string; avatar_url?: string }> {
    const resp = await this.client.contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    })
    if (!resp.data?.user) {
      throw new FeishuClientError({ code: 'NOT_FOUND', message: `user not found: ${openId}` })
    }
    const u = resp.data.user
    return {
      open_id: u.open_id ?? openId,
      name: u.name ?? '',
      avatar_url: u.avatar?.avatar_72 ?? u.avatar?.avatar_origin,
    }
  }

  /**
   * 在指定消息上加一个 reaction（emoji）。
   * 飞书 SDK 对此端点无强类型，用底层 client.request。
   * scope：im:message 已覆盖（无需 im:message.reactions:write_only）。
   *
   * https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create
   */
  async addReaction(messageId: string, emojiType: string): Promise<void> {
    const resp = await this.client.request<{ code?: number; msg?: string }>({
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      method: 'POST',
      data: { reaction_type: { emoji_type: emojiType } },
    })
    if (resp.code && resp.code !== 0) {
      throw new FeishuClientError({
        code: 'CHANNEL_SEND_FAILED',
        message: resp.msg ?? `add_reaction failed (code=${resp.code})`,
      })
    }
  }

  // ── send ───────────────────────────────────────────────────────────────────

  async sendText(receive: SendReceive, text: string): Promise<SendResult> {
    return this.sendRaw(receive, 'text', JSON.stringify({ text }))
  }

  async sendImage(receive: SendReceive, imageKey: string): Promise<SendResult> {
    return this.sendRaw(receive, 'image', JSON.stringify({ image_key: imageKey }))
  }

  async sendFile(receive: SendReceive, fileKey: string): Promise<SendResult> {
    return this.sendRaw(receive, 'file', JSON.stringify({ file_key: fileKey }))
  }

  /** 发送 interactive 卡片（飞书 markdown 渲染必走这个 msg_type） */
  async sendCard(receive: SendReceive, card: unknown): Promise<SendResult> {
    return this.sendRaw(receive, 'interactive', JSON.stringify(card))
  }

  async reply(messageId: string, msgType: string, contentJson: string, replyInThread?: boolean): Promise<SendResult> {
    const resp = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: { content: contentJson, msg_type: msgType, reply_in_thread: replyInThread },
    })
    return this.normalizeSendResp(resp)
  }

  private async sendRaw(receive: SendReceive, msgType: string, contentJson: string): Promise<SendResult> {
    const resp = await this.client.im.message.create({
      params: { receive_id_type: receive.type },
      data: { receive_id: receive.id, msg_type: msgType, content: contentJson },
    })
    return this.normalizeSendResp(resp)
  }

  private normalizeSendResp(resp: { code?: number; msg?: string; data?: { message_id?: string; create_time?: string } }): SendResult {
    if (resp.code && resp.code !== 0) {
      throw new FeishuClientError({ code: 'CHANNEL_SEND_FAILED', message: resp.msg ?? `send failed (code=${resp.code})` })
    }
    return {
      message_id: resp.data?.message_id ?? '',
      create_time: resp.data?.create_time ?? new Date().toISOString(),
    }
  }

  // ── upload / download ──────────────────────────────────────────────────────

  async uploadImage(image: Buffer): Promise<string> {
    const resp = await this.client.im.image.create({
      data: { image_type: 'message', image },
    })
    if (!resp || !resp.image_key) {
      throw new FeishuClientError({ code: 'CHANNEL_SEND_FAILED', message: 'upload image returned no key' })
    }
    return resp.image_key
  }

  async uploadFile(file: Buffer, filename: string, fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' = 'stream'): Promise<string> {
    const resp = await this.client.im.file.create({
      data: { file_type: fileType, file_name: filename, file },
    })
    if (!resp || !resp.file_key) {
      throw new FeishuClientError({ code: 'CHANNEL_SEND_FAILED', message: 'upload file returned no key' })
    }
    return resp.file_key
  }

  /**
   * 下载消息中的资源（type='image' | 'file'）。
   * lark SDK 返回 { writeFile, getReadableStream, headers }；这里读为 Buffer。
   */
  async downloadResource(messageId: string, fileKey: string, type: 'image' | 'file'): Promise<Buffer> {
    const resp = await this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    })
    const stream: Readable = resp.getReadableStream()
    return await streamToBuffer(stream)
  }

  // ── 云文档 ────────────────────────────────────────────────────────────────

  /**
   * 飞书只读 API 的唯一原语：GET 任意 /open-apis 端点，返回 data 字段。
   * code 非 0 抛 FeishuClientError（权限码经 mapDocCode → PERMISSION_DENIED）。
   * 内部被 FeishuDocReader 编排，外部经 feishu_get RPC 当逃生门暴露。
   */
  async rawGet<T = unknown>(path: string, query?: Record<string, string | number>): Promise<T> {
    let url = path
    if (query && Object.keys(query).length > 0) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) qs.set(k, String(v))
      url += (path.includes('?') ? '&' : '?') + qs.toString()
    }
    try {
      const resp = await this.client.request<{ code?: number; msg?: string; data?: T }>({ url, method: 'GET' })
      if (resp.code && resp.code !== 0) {
        throw this.makeDocError(resp.code, resp.msg ?? '', path)
      }
      return (resp.data ?? {}) as T
    } catch (err: unknown) {
      if (err instanceof FeishuClientError) throw err
      const extracted = tryExtractFeishuError(err)
      if (extracted) {
        throw this.makeDocError(extracted.code, extracted.msg, path, err)
      }
      throw err
    }
  }

  /**
   * 飞书写透传原语：非 GET（POST/PUT/PATCH/DELETE）打任意 /open-apis 端点，body 作为 data。
   * code 非 0 抛 FeishuClientError（权限码经 mapDocCode → PERMISSION_DENIED）。只读请用 rawGet。
   */
  async rawRequest<T = unknown>(opts: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    body?: unknown
    query?: Record<string, string | number>
  }): Promise<T> {
    let url = opts.path
    if (opts.query && Object.keys(opts.query).length > 0) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(opts.query)) qs.set(k, String(v))
      url += (opts.path.includes('?') ? '&' : '?') + qs.toString()
    }
    const resp = await this.client.request<{ code?: number; msg?: string; data?: T }>(
      { url, method: opts.method, ...(opts.body !== undefined ? { data: opts.body } : {}) })
    if (resp.code && resp.code !== 0) {
      throw new FeishuClientError({ code: this.mapDocCode(resp.code), message: resp.msg ?? `feishu ${opts.method} failed (code=${resp.code}) ${opts.path}` })
    }
    return (resp.data ?? {}) as T
  }

  /**
   * drive 云空间文件下载：GET /open-apis/drive/v1/files/:token/download（SDK drive.v1.file.download）。
   * 返回二进制 + 从响应头解析的文件名/MIME。流只能消费一次，故一次性读为 Buffer。
   */
  async downloadDriveFile(fileToken: string): Promise<{ buffer: Buffer; filename?: string; mimeType?: string }> {
    const resp = await (this.client as any).drive.v1.file.download({ path: { file_token: fileToken } })
    const buffer = await streamToBuffer(resp.getReadableStream())
    const headers = (resp as { headers?: Record<string, string> }).headers ?? {}
    const filename = parseContentDispositionFilename(headers['content-disposition'])
    const mimeType = headers['content-type']
    return { buffer, ...(filename ? { filename } : {}), ...(mimeType ? { mimeType } : {}) }
  }

  private mapDocCode(code: number): string {
    // 41050: 无用户权限  99991663/99991672: 权限不足  230001: 文档不存在
    if (code === 41050 || code === 99991663 || code === 99991672 || code === 403) return 'PERMISSION_DENIED'
    if (code === 230001 || code === 404) return 'NOT_FOUND'
    return 'CHANNEL_SEND_FAILED'
  }

  private makeDocError(code: number, msg: string, path?: string, cause?: unknown): FeishuClientError {
    return new FeishuClientError({
      code: this.mapDocCode(code),
      message: msg || `feishu GET failed (code=${code})${path ? ' ' + path : ''}`,
      feishu_code: code,
      feishu_message: msg || undefined,
      cause,
    })
  }

  /** 历史消息查询：im.v1.message.list */
  async listMessages(params: { container_id_type: 'chat'; container_id: string; start_time?: string; end_time?: string; page_size?: number; page_token?: string; sort_type?: 'ByCreateTimeAsc' | 'ByCreateTimeDesc' }): Promise<{ items: Array<Record<string, unknown>>; page_token?: string; has_more: boolean }> {
    const resp = await this.client.im.message.list({
      params: {
        container_id_type: params.container_id_type,
        container_id: params.container_id,
        start_time: params.start_time,
        end_time: params.end_time,
        page_size: params.page_size ?? 20,
        page_token: params.page_token,
        sort_type: params.sort_type,
      },
    })
    return {
      items: (resp.data?.items ?? []) as Array<Record<string, unknown>>,
      page_token: resp.data?.page_token,
      has_more: !!resp.data?.has_more,
    }
  }

  /** 单条消息查询：im.v1.message.get */
  async getMessage(messageId: string): Promise<Record<string, unknown> | null> {
    const resp = await this.client.im.message.get({ path: { message_id: messageId } })
    const items = resp.data?.items ?? []
    return items.length > 0 ? (items[0] as Record<string, unknown>) : null
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/** 从 Axios/SDK 拒绝的 error.response.data 安全提取飞书业务 code/msg，无 payload 返回 null。 */
function tryExtractFeishuError(err: unknown): { code: number; msg: string } | null {
  if (!err || typeof err !== 'object') return null
  const response = (err as { response?: unknown }).response
  if (!response || typeof response !== 'object') return null
  const data = (response as { data?: unknown }).data
  if (!data || typeof data !== 'object') return null
  const { code, msg } = data as { code?: unknown; msg?: unknown }
  if (typeof code === 'number' && typeof msg === 'string') {
    return { code, msg }
  }
  return null
}

/** 从 Content-Disposition 头解析文件名，支持 filename* (RFC 5987) 与普通 filename。 */
function parseContentDispositionFilename(cd?: string): string | undefined {
  if (!cd) return undefined
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd)
  if (star?.[1]) return decodeURIComponent(star[1].replace(/^"|"$/g, ''))
  const plain = /filename="?([^";]+)"?/i.exec(cd)
  return plain?.[1]
}

/**
 * 飞书业务错误码 99991672 / 99991663 = 应用 scope 缺失。
 * 把它统一翻译成带 missing_scope 的 RpcError(PERMISSION_DENIED)，调用方据此决定降级或上报。
 * 其他错误原样冒泡。
 */
export function mapFeishuPermissionError(err: unknown, missingScope: string, defaultMsg: string): void {
  const code = (err as { code?: number }).code
  if (code === 99991672 || code === 99991663) {
    throw new RpcError(
      'PERMISSION_DENIED',
      (err as { msg?: string }).msg ?? defaultMsg,
      { missing_scope: missingScope },
    )
  }
}

/**
 * 自定义 lark.Client logger：屏蔽 SDK 内部对 99991672 / 99991663（应用 scope 缺失）
 * 的 console.error 巨型 axios 对象输出。这类错由应用层 catch 后自己 warn 单行，
 * 不需要 SDK 重复打。其他错误透传到 console.error，保持可观测性。
 */
export function createLarkLogger(): {
  error: (...msg: unknown[]) => void
  warn: (...msg: unknown[]) => void
  info: (...msg: unknown[]) => void
  debug: (...msg: unknown[]) => void
  trace: (...msg: unknown[]) => void
} {
  return {
    error: (...msg: unknown[]) => {
      if (isFeishuPermissionLog(msg)) return
      console.error('[lark-sdk]', ...msg)
    },
    warn: (...msg: unknown[]) => console.warn('[lark-sdk]', ...msg),
    info: () => {},
    debug: () => {},
    trace: () => {},
  }
}

function isFeishuPermissionLog(msg: unknown[]): boolean {
  for (const arg of msg) {
    if (!Array.isArray(arg)) continue
    for (const item of arg) {
      const code = (item as { code?: number } | null)?.code
      if (code === 99991672 || code === 99991663) return true
    }
  }
  return false
}
