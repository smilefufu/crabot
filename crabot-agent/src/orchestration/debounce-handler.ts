/**
 * Debounce Handler - 群聊自适应 Debounce 机制
 *
 * 对群聊消息进行缓冲，窗口结束后批量传给 Agent 处理。
 * Agent 判断无关消息时 silent discard，窗口期自适应退避。
 *
 * @see protocol-agent-v2.md §5.2
 */

import type { SessionId } from '../core/base-protocol.js'
import type { ChannelMessage, Friend } from '../types.js'

export interface DebounceConfig {
  /** 最小缓冲窗口（ms），默认 5000 */
  group_debounce_min_ms: number
  /** 最大缓冲窗口（ms），默认 300000 */
  group_debounce_max_ms: number
}

export interface BufferedMessage {
  message: ChannelMessage
  friend: Friend
}

interface SessionDebounceState {
  /** 当前缓冲窗口（ms） */
  currentWindowMs: number
  /** 缓冲队列 */
  buffer: BufferedMessage[]
  /** 当前定时器 */
  timer: ReturnType<typeof setTimeout> | undefined
}

export type FlushCallback = (sessionId: SessionId, messages: BufferedMessage[]) => Promise<void>

export class DebounceHandler {
  private states: Map<SessionId, SessionDebounceState> = new Map()
  private config: DebounceConfig
  private flushCallback: FlushCallback

  constructor(config: DebounceConfig, flushCallback: FlushCallback) {
    this.config = config
    this.flushCallback = flushCallback
  }

  /**
   * 接收一条群聊消息，加入缓冲队列并重置定时器
   */
  enqueue(sessionId: SessionId, message: ChannelMessage, friend: Friend): void {
    const state = this.getOrCreateState(sessionId)
    state.buffer.push({ message, friend })

    // @mention 消息立即重置窗口到最小值
    if (message.features.is_mention_crab) {
      state.currentWindowMs = this.config.group_debounce_min_ms
    }

    // 重置定时器（每条新消息都重新计时）
    this.resetTimer(sessionId, state)
  }

  /**
   * 报告本批处理结果，调整下次窗口
   *
   * @param replied - Agent 是否产生了回复（direct_reply 或 create_task）
   */
  reportResult(sessionId: SessionId, replied: boolean): void {
    const state = this.states.get(sessionId)
    if (!state) return

    if (replied) {
      // Agent 回复了 → 重置到最小窗口（后续消息高概率与回复相关）
      state.currentWindowMs = this.config.group_debounce_min_ms
    } else {
      // Agent 判断无关（silent discard）→ 退避 ×5，上限 max
      state.currentWindowMs = Math.min(
        state.currentWindowMs * 5,
        this.config.group_debounce_max_ms
      )
    }
  }

  /**
   * 停止所有定时器（模块关闭时调用）
   */
  stopAll(): void {
    for (const state of this.states.values()) {
      if (state.timer) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
    }
    this.states.clear()
  }

  /**
   * 获取指定 session 的当前窗口值（测试用）
   */
  getCurrentWindowMs(sessionId: SessionId): number | undefined {
    return this.states.get(sessionId)?.currentWindowMs
  }

  /**
   * 获取指定 session 的缓冲消息数（测试用）
   */
  getBufferSize(sessionId: SessionId): number {
    return this.states.get(sessionId)?.buffer.length ?? 0
  }

  private getOrCreateState(sessionId: SessionId): SessionDebounceState {
    let state = this.states.get(sessionId)
    if (!state) {
      state = {
        currentWindowMs: this.config.group_debounce_min_ms,
        buffer: [],
        timer: undefined,
      }
      this.states.set(sessionId, state)
    }
    return state
  }

  private resetTimer(sessionId: SessionId, state: SessionDebounceState): void {
    if (state.timer) {
      clearTimeout(state.timer)
    }

    state.timer = setTimeout(() => {
      this.flush(sessionId)
    }, state.currentWindowMs)
  }

  private flush(sessionId: SessionId): void {
    const state = this.states.get(sessionId)
    if (!state || state.buffer.length === 0) return

    // 取出缓冲消息并清空
    const messages = [...state.buffer]
    state.buffer = []
    state.timer = undefined

    // 异步调用回调，不阻塞
    this.flushCallback(sessionId, messages).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[DebounceHandler] Flush error for session ${sessionId}: ${msg}`)
    })
  }
}
