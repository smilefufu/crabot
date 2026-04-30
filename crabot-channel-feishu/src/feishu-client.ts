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
}

export class FeishuClientError extends Error {
  code: string
  cause?: unknown
  constructor(opts: FeishuClientErrorOpts) {
    super(opts.message)
    this.name = 'FeishuClientError'
    this.code = opts.code
    this.cause = opts.cause
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

  async getChatMembers(chatId: string): Promise<Array<{ open_id: string; name: string }>> {
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

  /** 历史消息查询：im.v1.message.list */
  async listMessages(params: { container_id_type: 'chat'; container_id: string; start_time?: string; end_time?: string; page_size?: number; page_token?: string }): Promise<{ items: Array<Record<string, unknown>>; page_token?: string; has_more: boolean }> {
    const resp = await this.client.im.message.list({
      params: {
        container_id_type: params.container_id_type,
        container_id: params.container_id,
        start_time: params.start_time,
        end_time: params.end_time,
        page_size: params.page_size ?? 20,
        page_token: params.page_token,
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
