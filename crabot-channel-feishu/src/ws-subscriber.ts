/**
 * WsSubscriber - lark.WSClient 包装
 *
 * - 计数 reconnect / 失败次数，供 health 检查使用
 * - 提供统一的 start / close
 *
 * lark.WSClient 通过 onReady / onError / onReconnecting / onReconnected 暴露状态变化。
 */

import * as lark from '@larksuiteoapi/node-sdk'
import type { FeishuDomain } from './types.js'

export type WsState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

export class WsSubscriber {
  private wsClient: lark.WSClient | null = null
  private state: WsState = 'idle'
  private reconnectCount = 0
  private failCount = 0
  private lastError: string | undefined

  constructor(
    private readonly opts: { app_id: string; app_secret: string; domain: FeishuDomain }
  ) {}

  async start(eventDispatcher: lark.EventDispatcher): Promise<void> {
    if (this.wsClient) {
      throw new Error('WsSubscriber: already started')
    }
    this.state = 'connecting'
    this.wsClient = new lark.WSClient({
      appId: this.opts.app_id,
      appSecret: this.opts.app_secret,
      domain: this.opts.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      autoReconnect: true,
      onReady: () => {
        this.state = 'connected'
        this.failCount = 0
        this.lastError = undefined
      },
      onError: (err: Error) => {
        this.state = 'failed'
        this.failCount += 1
        this.lastError = err?.message ?? String(err)
      },
      onReconnecting: () => {
        this.state = 'reconnecting'
      },
      onReconnected: () => {
        this.state = 'connected'
        this.reconnectCount += 1
        this.failCount = 0
        this.lastError = undefined
      },
    })
    await this.wsClient.start({ eventDispatcher })
  }

  async close(): Promise<void> {
    if (!this.wsClient) return
    try {
      this.wsClient.close({ force: true })
    } catch {
      // ignore close errors
    }
    this.wsClient = null
    this.state = 'idle'
  }

  isConnected(): boolean {
    return this.state === 'connected'
  }

  getState(): WsState {
    return this.state
  }

  getReconnectCount(): number {
    return this.reconnectCount
  }

  getFailCount(): number {
    return this.failCount
  }

  getLastError(): string | undefined {
    return this.lastError
  }
}
