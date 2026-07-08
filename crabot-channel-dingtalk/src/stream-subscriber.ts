/**
 * StreamSubscriber - dingtalk-stream-sdk-nodejs DWClient 包装
 *
 * - 建立 Stream 长连接，注册机器人消息回调（TOPIC_ROBOT = /v1.0/im/bot/messages/get）
 * - 把 DWClientDownStream.data（JSON 字符串）解析为 DingtalkInboundMessage 交给 onMessage
 * - 计数连接/失败次数、记录最近错误，供 health 检查使用
 *
 * DWClient 内部自带心跳与自动重连（reconnectInterval / heartbeat），
 * 因此这里主要负责建连、回调分发与状态快照，对标 feishu 的 ws-subscriber.ts。
 */

import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream-sdk-nodejs'
import type { DingtalkInboundMessage } from './types.js'

export type StreamState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

export interface StreamSubscriberOptions {
  clientId: string
  clientSecret: string
  onMessage: (msg: DingtalkInboundMessage, raw: DWClientDownStream) => void | Promise<void>
}

export class StreamSubscriber {
  private client: DWClient | null = null
  private state: StreamState = 'idle'
  private connectCount = 0
  private failCount = 0
  private lastError: string | undefined

  constructor(private readonly opts: StreamSubscriberOptions) {}

  async start(): Promise<void> {
    if (this.client) {
      throw new Error('StreamSubscriber: already started')
    }
    this.state = 'connecting'

    const client = new DWClient({
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
    })

    client.registerCallbackListener(TOPIC_ROBOT, (downStream: DWClientDownStream) => {
      let msg: DingtalkInboundMessage
      try {
        msg = JSON.parse(downStream.data) as DingtalkInboundMessage
      } catch (err) {
        this.lastError = `parse downstream failed: ${(err as Error)?.message ?? String(err)}`
        return
      }
      // 同步与异步抛错都兜住，避免逃逸到 SDK 打挂本次消息分发
      void (async () => {
        try {
          await this.opts.onMessage(msg, downStream)
        } catch (err) {
          this.lastError = (err as Error)?.message ?? String(err)
        }
      })()
    })

    try {
      await client.connect()
    } catch (err) {
      this.state = 'failed'
      this.failCount += 1
      this.lastError = (err as Error)?.message ?? String(err)
      throw err
    }

    this.client = client
    this.state = 'connected'
    this.connectCount += 1
    this.lastError = undefined
  }

  async close(): Promise<void> {
    if (!this.client) return
    try {
      this.client.disconnect()
    } catch {
      // ignore disconnect errors
    }
    this.client = null
    this.state = 'idle'
  }

  isConnected(): boolean {
    return this.client?.connected ?? false
  }

  /** 优先反映 DWClient 的实时标志（自动重连场景），否则回落到内部记录的 state。 */
  getState(): StreamState {
    if (this.client) {
      if (this.client.reconnecting) return 'reconnecting'
      if (this.client.connected) return 'connected'
    }
    return this.state
  }

  getConnectCount(): number {
    return this.connectCount
  }

  getFailCount(): number {
    return this.failCount
  }

  getLastError(): string | undefined {
    return this.lastError
  }
}
