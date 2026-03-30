/**
 * Attention Scheduler - 群聊注意力调度
 *
 * 模拟人类查看 IM 消息的注意力模式：
 * - 刚在群里发过言 → 注意力仍在群内，高频巡检后续消息
 * - 持续判断无关 → 注意力渐远，巡检间隔拉长
 * - 收到 @消息 → 立即触发巡检
 *
 * 巡检间隔起点 = 上一次 Agent 发言或上一次巡检的时刻。
 * 新消息只入队缓冲，不影响已有的巡检定时器。
 *
 * @see protocol-agent-v2.md §5.2
 */

import type { SessionId } from '../core/base-protocol.js'
import type { ChannelMessage, Friend } from '../types.js'

export interface AttentionConfig {
  /** 最小巡检间隔（ms），默认 5000 */
  group_attention_min_ms: number
  /** 最大巡检间隔（ms），默认 300000 */
  group_attention_max_ms: number
}

export interface BufferedMessage {
  message: ChannelMessage
  friend: Friend
}

interface SessionAttentionState {
  /** 当前巡检间隔（ms） */
  currentIntervalMs: number
  /** 缓冲队列 */
  buffer: BufferedMessage[]
  /** 当前定时器 */
  timer: ReturnType<typeof setTimeout> | undefined
  /** 上次 Agent 发言或巡检的时间戳（ms） */
  lastActionTime: number
}

export type FlushCallback = (sessionId: SessionId, messages: BufferedMessage[]) => Promise<void>

export class AttentionScheduler {
  private states: Map<SessionId, SessionAttentionState> = new Map()
  private config: AttentionConfig
  private flushCallback: FlushCallback

  constructor(config: AttentionConfig, flushCallback: FlushCallback) {
    this.config = config
    this.flushCallback = flushCallback
  }

  /**
   * 接收一条群聊消息，加入缓冲队列。
   * 不重置定时器——只在没有 pending timer 时按需调度。
   */
  enqueue(sessionId: SessionId, message: ChannelMessage, friend: Friend): void {
    const state = this.getOrCreateState(sessionId)
    state.buffer.push({ message, friend })

    // @mention 消息立即触发巡检
    if (message.features.is_mention_crab) {
      this.flushNow(sessionId, state)
      return
    }

    // 已有定时器在跑 → 消息已入队，等定时器触发即可
    if (state.timer) {
      return
    }

    // 没有 pending timer → 计算距上次 action 的时间差，决定何时巡检
    this.scheduleCheck(sessionId, state)
  }

  /**
   * 报告本批处理结果，调整下次巡检间隔
   *
   * @param replied - Agent 是否产生了回复（direct_reply 或 create_task）
   */
  reportResult(sessionId: SessionId, replied: boolean): void {
    const state = this.states.get(sessionId)
    if (!state) return

    if (replied) {
      // Agent 回复了 → 注意力拉回，间隔重置到最小值
      state.currentIntervalMs = this.config.group_attention_min_ms
    } else {
      // Agent 判断无关（silent discard）→ 注意力渐远，间隔 ×5，上限 max
      state.currentIntervalMs = Math.min(
        state.currentIntervalMs * 5,
        this.config.group_attention_max_ms
      )
    }

    // 更新 lastActionTime（巡检完成时刻）
    state.lastActionTime = Date.now()

    // 如果 buffer 中还有消息（巡检期间又来了新消息），调度下一次巡检
    if (state.buffer.length > 0) {
      this.scheduleCheck(sessionId, state)
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
   * 获取指定 session 的当前巡检间隔（测试用）
   */
  getCurrentIntervalMs(sessionId: SessionId): number | undefined {
    return this.states.get(sessionId)?.currentIntervalMs
  }

  /**
   * 获取指定 session 的缓冲消息数（测试用）
   */
  getBufferSize(sessionId: SessionId): number {
    return this.states.get(sessionId)?.buffer.length ?? 0
  }

  private getOrCreateState(sessionId: SessionId): SessionAttentionState {
    let state = this.states.get(sessionId)
    if (!state) {
      state = {
        currentIntervalMs: this.config.group_attention_min_ms,
        buffer: [],
        timer: undefined,
        lastActionTime: Date.now(),
      }
      this.states.set(sessionId, state)
    }
    return state
  }

  /**
   * 根据距上次 action 的时间差，决定立即巡检还是延迟巡检
   */
  private scheduleCheck(sessionId: SessionId, state: SessionAttentionState): void {
    const elapsed = Date.now() - state.lastActionTime
    const remaining = state.currentIntervalMs - elapsed

    if (remaining <= 0) {
      // 已超过巡检间隔 → 立即触发
      this.flushNow(sessionId, state)
    } else {
      // 未到巡检时间 → 设定定时器等待剩余时间
      state.timer = setTimeout(() => {
        this.flush(sessionId)
      }, remaining)
    }
  }

  /**
   * 立即触发巡检（@mention 或已超时）
   */
  private flushNow(sessionId: SessionId, state: SessionAttentionState): void {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    this.flush(sessionId)
  }

  private flush(sessionId: SessionId): void {
    const state = this.states.get(sessionId)
    if (!state || state.buffer.length === 0) {
      if (state) {
        state.timer = undefined
      }
      return
    }

    // 取出缓冲消息并清空
    const messages = [...state.buffer]
    state.buffer = []
    state.timer = undefined

    // 异步调用回调，不阻塞
    this.flushCallback(sessionId, messages).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[AttentionScheduler] Flush error for session ${sessionId}: ${msg}`)
    })
  }
}
