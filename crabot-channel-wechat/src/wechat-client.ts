/**
 * WechatClient - wechat-connector REST API 客户端
 *
 * 封装 Bot REST API 的所有读写操作。
 * 参考 BOT_INTEGRATION.md 的 REST API 章节。
 */

import http from 'node:http'
import https from 'node:https'
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
   * 发送文件
   */
  async sendFile(wxid: string, url: string): Promise<{ taskId: string }> {
    return this.post('/api/v1/bot/send', { wxid, type: 'file', url })
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
