import type { LLMAdapter } from './llm-adapter'
import { callNonStreaming } from './llm-adapter'
import type { EngineMessage, EngineMessagesRef, EngineTurnEvent } from './types'
import { createUserMessage } from './types'
import { hasDanglingToolUse } from './tool-message-integrity.js'

/**
 * 进度汇报（fork 模式）。
 *
 * 思路：定时从主 loop 的 messages 数组 fork 一份只读副本，在末尾追加一条
 * "系统提醒：该汇报进度了"user msg，复用主 loop 上一轮实际使用的
 * systemPrompt + tools 跑一次非流式 LLM 调用，截获 send_message tool_use
 * 的 content 转给用户（工具不真正执行）。主 loop 完全不感知本次 fork——
 * messages 是浅拷贝，主 loop 的对话历史不会被污染。
 *
 * 为什么逐字节复用主 loop 的 systemPrompt/tools：prompt cache 按精确前缀
 * 匹配（tools → system → messages），任何一处不同都会让整个对话历史按
 * 全价 input 重算。用 engine 快照的原值（EngineMessagesRef.systemPrompt/
 * tools）而非重调 builder 回调，保证逐字节一致——不依赖回调的确定性，
 * 也不受 admin push config 热更新的时序影响。
 */

// --- Config & Deps ---

export type DigestReason = 'interval' | 'overdue'

export interface ProgressDigestConfig {
  /** 定时 flush 间隔（毫秒）；不传或 ≤0 表示不启用定时触发 */
  readonly intervalMs?: number
  /**
   * 超期触发延迟（毫秒，相对于 ProgressDigest 构造时刻）。
   * 不传表示不启用超期触发。启用后到时间会触发一次 fork-and-send，且只触发一次。
   * 跟 intervalMs 是两条独立触发条件，可以一起开 / 单独开 / 都不开。
   */
  readonly overdueMs?: number
  /** 主人私聊场景 —— 允许暴露完整路径；否则要求 LLM 用 basename 替代 */
  readonly isMasterPrivate: boolean
  /**
   * trace 写入回调：每次 fork-and-send 开始时调一次。
   * 不传则不写 trace；返回的 spanId 由调用方在 trace 结束时配合 onTraceEnd 关闭。
   */
  readonly onTraceStart?: (reason: DigestReason) => string | undefined
  /** 配合 onTraceStart 使用：fork-and-send 完成（含失败）时调一次。 */
  readonly onTraceEnd?: (spanId: string, status: 'completed' | 'failed', details?: Record<string, unknown>) => void
}

export interface ProgressDigestDeps {
  readonly sendToUser: (text: string) => Promise<void>
  /** 主 loop 自己的 adapter；fork 调用直接复用，省去额外配置 */
  readonly adapter: LLMAdapter
  /** 主 loop 自己的 model_id */
  readonly modelId: string
  /** 主 loop 的 maxTokens；不传则走 adapter 默认 */
  readonly maxTokens?: number
  /**
   * 主 loop 对话状态的只读 holder。engine 在每个 turn 完成时浅拷贝刷新
   * `current`，每次 LLM 调用前快照 systemPrompt/tools。doFlush 时拿当前
   * 快照 fork 一份给摘要 LLM。
   */
  readonly messagesRef: EngineMessagesRef
}

// --- Prompts ---

const buildReminder = (isMasterPrivate: boolean): string => {
  const base = '系统提醒：已经过去较长时间了，你需要使用 send_message 向人类汇报一下当前的进度'
  if (!isMasterPrivate) {
    return base + '（不要泄露绝对路径，路径只说 basename）'
  }
  return base
}

// --- Class ---

export class ProgressDigest {
  private readonly config: ProgressDigestConfig
  private readonly deps: ProgressDigestDeps
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private overdueTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private flushing = false
  /** 上次 flush 时观察到的 snapshot 长度 —— 没有新内容时跳过 flush */
  private lastFlushMessagesCount = 0
  /**
   * agent 在本 loop 已经成功调过 send_message —— overdue 触发时用作"用户已知进度"
   * 的兜底判断：agent 主动说过话了就不再额外发 overdue digest，避免用户收两条
   * 相近的进度消息。interval 不受此影响（interval 是稳定节奏）。
   */
  private sentMessageSinceStart = false

  constructor(config: ProgressDigestConfig, deps: ProgressDigestDeps) {
    this.config = config
    this.deps = deps
    this.startTimers()
  }

  /**
   * 检测 send_message 调用并标记 sentMessageSinceStart（影响 overdue 是否触发）。
   * ask_human 本身已通过 send_message 真实发给用户；这里不再额外生成 digest。
   */
  ingest(event: EngineTurnEvent): void {
    if (this.disposed) return
    for (const tc of event.toolCalls) {
      const bare = tc.name.replace(/^mcp__[^_]+__/, '')
      const isSendMsg = bare === 'send_message' || bare === 'send_private_message'
      if (!isSendMsg || tc.isError) continue
      this.sentMessageSinceStart = true
    }
  }

  flushNow(reason: DigestReason = 'overdue'): void {
    if (this.disposed) return
    this.doFlush(reason).catch(() => {})
  }

  dispose(): void {
    this.disposed = true
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
    if (this.overdueTimer !== null) {
      clearTimeout(this.overdueTimer)
      this.overdueTimer = null
    }
  }

  private startTimers(): void {
    if (this.config.intervalMs !== undefined && this.config.intervalMs > 0) {
      this.intervalTimer = setInterval(() => {
        this.doFlush('interval').catch(() => {})
      }, this.config.intervalMs)
    }
    if (this.config.overdueMs !== undefined && this.config.overdueMs > 0) {
      this.overdueTimer = setTimeout(() => {
        this.overdueTimer = null
        this.doFlush('overdue').catch(() => {})
      }, this.config.overdueMs)
    }
  }

  private async doFlush(reason: DigestReason): Promise<void> {
    if (this.flushing) return
    // overdue 触发但 agent 已经 send_message 过 → 跳过：用户已经收到 agent 自己写的
    // 进度（带工作记忆 + 后续行动），再发一份 fork digest 是冗余。
    // interval 不受此判断影响（interval 是稳定节奏）。
    if (reason === 'overdue' && this.sentMessageSinceStart) return
    const snapshot = this.deps.messagesRef.current
    if (snapshot.length === 0) return
    // 与上次相比没有新增 turn → 跳过（避免重复输出相同进度）
    if (snapshot.length <= this.lastFlushMessagesCount) return
    // 防御性检查：跳过尾部有"孤立 tool_use"（assistant 调了工具但 tool_result
    // 还没 push）的快照。OpenAI Responses / Anthropic 都严格要求 function_call
    // 配 output；race 窗口里 fork 这种半截 messages 会 400。
    if (hasDanglingToolUse(snapshot)) return

    this.flushing = true
    const observedCount = snapshot.length
    const spanId = this.config.onTraceStart?.(reason)
    let status: 'completed' | 'failed' = 'completed'
    let details: Record<string, unknown> | undefined

    try {
      const message = await this.generateDigest(snapshot)
      if (message.length > 0) {
        await this.deps.sendToUser(message)
        this.lastFlushMessagesCount = observedCount
        details = { output_summary: message.slice(0, 200), messages_count: observedCount }
      } else {
        this.lastFlushMessagesCount = observedCount
        details = { output_summary: '(empty)', messages_count: observedCount }
      }
    } catch (err) {
      status = 'failed'
      details = { error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (spanId !== undefined) {
        this.config.onTraceEnd?.(spanId, status, details)
      }
      this.flushing = false
    }
  }

  private async generateDigest(snapshot: ReadonlyArray<EngineMessage>): Promise<string> {
    // systemPrompt/tools 必须用 engine 快照的原值才能命中 prompt cache 前缀；
    // 第一次 LLM 调用前快照还没写入 → 跳过本次，下个 interval 重试
    const { systemPrompt, tools } = this.deps.messagesRef
    if (systemPrompt === undefined || tools === undefined) return ''

    const reminder = buildReminder(this.config.isMasterPrivate)
    const forkMessages: EngineMessage[] = [...snapshot, createUserMessage(reminder)]

    const params = {
      messages: forkMessages,
      systemPrompt,
      tools: [...tools],
      model: this.deps.modelId,
      ...(this.deps.maxTokens !== undefined ? { maxTokens: this.deps.maxTokens } : {}),
    }
    const response = await callNonStreaming(this.deps.adapter, params)

    // 优先截获 send_message tool_use 的 content（工具不真正执行）；
    // 模型没调工具时 fallback 到文本块输出
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const bare = block.name.replace(/^mcp__[^_]+__/, '')
      if (bare !== 'send_message' && bare !== 'send_private_message') continue
      const content = (block.input as { content?: unknown }).content
      if (typeof content === 'string' && content.trim().length > 0) {
        return content.trim()
      }
    }
    return response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()
  }
}
