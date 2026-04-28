/**
 * TelegramClient - Telegram Bot API HTTP 封装
 *
 * 用原生 fetch 调用 Telegram Bot API，零第三方依赖。
 * https://core.telegram.org/bots/api
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  TgUser,
  TgChat,
  TgChatMember,
  TgMessage,
  TgUpdate,
  TgFile,
  TgApiResponse,
  TgSendOptions,
} from './types.js'

export class TelegramClient {
  private readonly baseUrl: string
  private readonly fileBaseUrl: string

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`
  }

  // ── 基础 ──────────────────────────────────────────────────────────────────

  async getMe(): Promise<TgUser> {
    return this.callApi<TgUser>('getMe')
  }

  // ── 消息接收 ──────────────────────────────────────────────────────────────

  async getUpdates(offset?: number, timeout = 30): Promise<TgUpdate[]> {
    const params: Record<string, unknown> = { timeout }
    if (offset !== undefined) params.offset = offset
    params.allowed_updates = ['message', 'edited_message']
    // long polling 自身就是循环操作，pollLoop 失败后会自然进入下一轮；
    // 客户端层再加重试只会放大单次失败的等待时间和日志噪音。
    return this.callApi<TgUpdate[]>('getUpdates', params, { retry: false })
  }

  // ── 消息发送 ──────────────────────────────────────────────────────────────

  async sendMessage(
    chatId: string | number,
    text: string,
    options?: TgSendOptions
  ): Promise<TgMessage> {
    return this.callApi<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      ...options,
    })
  }

  async sendPhoto(
    chatId: string | number,
    photo: string | Buffer,
    options?: TgSendOptions & { caption?: string }
  ): Promise<TgMessage> {
    if (Buffer.isBuffer(photo)) {
      return this.callApiMultipart<TgMessage>('sendPhoto', {
        chat_id: String(chatId),
        ...options,
      }, { photo })
    }
    return this.callApi<TgMessage>('sendPhoto', {
      chat_id: chatId,
      photo,
      ...options,
    })
  }

  async sendDocument(
    chatId: string | number,
    document: string | Buffer,
    options?: TgSendOptions & { caption?: string; filename?: string }
  ): Promise<TgMessage> {
    if (Buffer.isBuffer(document)) {
      const { filename, ...rest } = options ?? {}
      return this.callApiMultipart<TgMessage>('sendDocument', {
        chat_id: String(chatId),
        ...rest,
      }, { document }, filename)
    }
    return this.callApi<TgMessage>('sendDocument', {
      chat_id: chatId,
      document,
      ...options,
    })
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  async setWebhook(url: string, secret?: string): Promise<boolean> {
    const params: Record<string, unknown> = {
      url,
      allowed_updates: ['message', 'edited_message'],
    }
    if (secret) params.secret_token = secret
    return this.callApi<boolean>('setWebhook', params)
  }

  async deleteWebhook(): Promise<boolean> {
    return this.callApi<boolean>('deleteWebhook')
  }

  // ── 查询 ──────────────────────────────────────────────────────────────────

  async getChat(chatId: string | number): Promise<TgChat> {
    return this.callApi<TgChat>('getChat', { chat_id: chatId })
  }

  async getChatMember(chatId: string | number, userId: number): Promise<TgChatMember> {
    return this.callApi<TgChatMember>('getChatMember', {
      chat_id: chatId,
      user_id: userId,
    })
  }

  async getFile(fileId: string): Promise<TgFile> {
    return this.callApi<TgFile>('getFile', { file_id: fileId })
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const url = `${this.fileBaseUrl}/${filePath}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new TelegramApiError(
        response.status,
        `Failed to download file: ${response.statusText}`
      )
    }
    return Buffer.from(await response.arrayBuffer())
  }

  /**
   * 通过 file_id 下载文件并保存到本地目录。
   * 返回保存后的本地文件路径。
   */
  async downloadFileToLocal(
    fileId: string,
    mediaDir: string
  ): Promise<{ localPath: string; filePath: string }> {
    const fileInfo = await this.getFile(fileId)
    if (!fileInfo.file_path) {
      throw new TelegramApiError(0, `File ${fileId} has no file_path`)
    }

    const buffer = await this.downloadFile(fileInfo.file_path)
    const ext = path.extname(fileInfo.file_path) || ''
    const localFilename = `${fileInfo.file_unique_id}${ext}`
    const localPath = path.join(mediaDir, localFilename)

    await fs.mkdir(mediaDir, { recursive: true })
    await fs.writeFile(localPath, buffer)

    return { localPath, filePath: fileInfo.file_path }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private async callApi<T>(
    method: string,
    params?: Record<string, unknown>,
    options?: { retry?: boolean },
  ): Promise<T> {
    const url = `${this.baseUrl}/${method}`
    const body = params ? JSON.stringify(params) : undefined
    return this.fetchWithRetry<T>(method, () => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }), options?.retry !== false)
  }

  private async callApiMultipart<T>(
    method: string,
    fields: Record<string, unknown>,
    files: Record<string, Buffer>,
    filename?: string
  ): Promise<T> {
    const now = Date.now()
    const boundary = `----CrabotBoundary${now}`
    const parts: Buffer[] = []

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`
      ))
    }

    for (const [key, buffer] of Object.entries(files)) {
      const fn = filename ?? `upload_${now}`
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${fn}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      ))
      parts.push(buffer)
      parts.push(Buffer.from('\r\n'))
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`))
    const body = Buffer.concat(parts)

    const url = `${this.baseUrl}/${method}`
    return this.fetchWithRetry<T>(method, () => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    }))
  }

  /**
   * 调用 Telegram API，带瞬态错误重试。
   *
   * 会重试的：
   *   - fetch 抛错（DNS/connection reset/socket hang up 等网络层错误）
   *   - HTTP 5xx（Telegram 后端临时故障）
   *   - HTTP 429 / `retry_after`（rate limit；遵循返回的 retry_after 秒数）
   *
   * 不会重试的：
   *   - 4xx 用户错误（chat not found、bot blocked、bad request 等永久错误）
   *   - 业务级 ok=false 但 HTTP 200 的（除非 error_code=429）
   *
   * 退避：指数递增，base=300ms（300 / 600 / 1200ms），最多 3 次尝试。
   *
   * `enabled=false` 时退化为单次请求（用于 long polling 等本身具循环语义的调用）。
   */
  private async fetchWithRetry<T>(
    method: string,
    doFetch: () => Promise<Response>,
    enabled = true,
  ): Promise<T> {
    const MAX_ATTEMPTS = enabled ? 3 : 1
    const BASE_DELAY_MS = 300

    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await doFetch()
        const data = (await response.json()) as TgApiResponse<T>
        const status = response.status
        const errorCode = data.error_code ?? status

        const retryable =
          status >= 500 || status === 429 || errorCode === 429
        if (!data.ok && retryable && attempt < MAX_ATTEMPTS) {
          const retryAfter = typeof data.parameters?.retry_after === 'number'
            ? data.parameters.retry_after * 1000
            : BASE_DELAY_MS * 2 ** (attempt - 1)
          console.warn(
            `[TelegramClient] ${method} retryable status=${status} code=${errorCode} attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${retryAfter}ms`
          )
          await sleep(retryAfter)
          continue
        }

        return this.unwrapResponse(data, status)
      } catch (err: unknown) {
        // fetch 抛错 = 网络层错误（DNS、connection refused、socket reset、TLS 等），瞬态可重试
        lastError = err
        if (attempt < MAX_ATTEMPTS) {
          const delay = BASE_DELAY_MS * 2 ** (attempt - 1)
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(
            `[TelegramClient] ${method} network error attempt ${attempt}/${MAX_ATTEMPTS}: ${msg}, retrying in ${delay}ms`
          )
          await sleep(delay)
          continue
        }
        throw err
      }
    }
    // 不可达（循环内要么 return 要么 throw），但 TS 需要兜底
    throw lastError ?? new Error(`[TelegramClient] ${method} exhausted retries without result`)
  }

  private unwrapResponse<T>(data: TgApiResponse<T>, httpStatus: number): T {
    if (!data.ok || data.result === undefined) {
      throw new TelegramApiError(
        data.error_code ?? httpStatus,
        data.description ?? 'Unknown Telegram API error'
      )
    }
    return data.result
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ============================================================================
// 错误类型
// ============================================================================

export class TelegramApiError extends Error {
  constructor(
    public readonly errorCode: number,
    message: string
  ) {
    super(message)
    this.name = 'TelegramApiError'
  }
}
