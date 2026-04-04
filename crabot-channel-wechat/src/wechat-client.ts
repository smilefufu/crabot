/**
 * WechatClient - wechat-connector REST API 客户端
 *
 * 封装 Bot REST API 的所有读写操作。
 * 参考 BOT_INTEGRATION.md 的 REST API 章节。
 */

import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import type { ApiResponse } from './types.js'

export class WechatClient {
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(connectorUrl: string, apiKey: string) {
    // 去掉尾部斜杠
    this.baseUrl = connectorUrl.replace(/\/+$/, '')
    this.apiKey = apiKey
  }

  // ============================================================================
  // 写入操作
  // ============================================================================

  /**
   * 发送文本消息
   */
  async sendText(wxid: string, content: string, atString?: string): Promise<{ taskId: string }> {
    const body: Record<string, unknown> = { wxid, type: 'text', content }
    if (atString) body.atString = atString
    return this.post('/api/v1/bot/send', body)
  }

  /**
   * 发送图片
   */
  async sendImage(wxid: string, url: string): Promise<{ taskId: string }> {
    return this.post('/api/v1/bot/send', { wxid, type: 'image', url })
  }

  /**
   * 发送文件（通过 URL）
   */
  async sendFile(wxid: string, url: string): Promise<{ taskId: string }> {
    return this.post('/api/v1/bot/send', { wxid, type: 'file', url })
  }

  /**
   * 发送本地文件（通过 /api/v1/bot/send-file multipart 上传并发送）
   */
  async sendLocalFile(wxid: string, filePath: string, type: 'image' | 'file' = 'image'): Promise<{ taskId: string; url: string }> {
    const fileBuffer = fs.readFileSync(filePath)
    const filename = path.basename(filePath)
    const boundary = `----CrabotBoundary${Date.now()}`

    const parts: Buffer[] = []

    // file field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ))
    parts.push(fileBuffer)
    parts.push(Buffer.from('\r\n'))

    // wxid field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="wxid"\r\n\r\n${wxid}\r\n`
    ))

    // type field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${type}\r\n`
    ))

    parts.push(Buffer.from(`--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    return this.multipartPost('/api/v1/bot/send-file', body, boundary)
  }

  // ============================================================================
  // 读取操作
  // ============================================================================

  /**
   * 获取 Puppet 信息
   */
  async getPuppet(): Promise<{
    id: string
    wechatUsername: string
    wechatNickname: string
    status: string
    wechatLoggedIn: boolean
    lastSeenAt: string | null
  }> {
    return this.get('/api/v1/bot/puppet')
  }

  /**
   * 查询联系人
   */
  async getContact(username: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.get(`/api/v1/bot/contacts/${encodeURIComponent(username)}`)
    } catch {
      return null
    }
  }

  /**
   * 查询群组
   */
  async getGroup(chatroomName: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.get(`/api/v1/bot/groups/${encodeURIComponent(chatroomName)}`)
    } catch {
      return null
    }
  }

  /**
   * 获取群成员列表
   */
  async getGroupMembers(chatroomName: string): Promise<{
    members: Array<{ username: string; nickname: string; chatroom_nick?: string }>
    memberCount: number
  } | null> {
    try {
      return await this.get(`/api/v1/bot/groups/${encodeURIComponent(chatroomName)}/members`)
    } catch {
      return null
    }
  }

  /**
   * 查询消息历史
   */
  async getMessages(talker: string, limit = 20): Promise<Array<Record<string, unknown>>> {
    const result = await this.get<Array<Record<string, unknown>>>(
      `/api/v1/bot/messages?talker=${encodeURIComponent(talker)}&limit=${limit}`
    )
    return result ?? []
  }

  // ============================================================================
  // HTTP 请求封装
  // ============================================================================

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  private multipartPost<T>(apiPath: string, body: Buffer, boundary: string): Promise<T> {
    const url = new URL(apiPath, this.baseUrl)
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
          timeout: 60000,
        },
        (res) => {
          let data = ''
          res.on('data', (chunk: string) => { data += chunk })
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as ApiResponse<T>
              if (parsed.code !== 0) {
                reject(new Error(parsed.message ?? `API error: code=${parsed.code}`))
                return
              }
              resolve(parsed.data)
            } catch (e) {
              reject(new Error(`Failed to parse response: ${String(e)}`))
            }
          })
        }
      )
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Upload timeout')) })
      req.write(body)
      req.end()
    })
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl)
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http

    const bodyStr = body ? JSON.stringify(body) : undefined

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
          },
          timeout: 15000,
        },
        (res) => {
          let data = ''
          res.on('data', (chunk: string) => { data += chunk })
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as ApiResponse<T>
              if (parsed.code !== 0) {
                reject(new Error(parsed.message ?? `API error: code=${parsed.code}`))
                return
              }
              resolve(parsed.data)
            } catch (e) {
              reject(new Error(`Failed to parse response: ${String(e)}`))
            }
          })
        }
      )

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error(`Request timeout: ${method} ${path}`))
      })

      if (bodyStr) req.write(bodyStr)
      req.end()
    })
  }
}
