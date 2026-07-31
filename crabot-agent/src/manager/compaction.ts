/**
 * P4 Manager loop 缓存感知增量压缩 —— protocol-agent-v3.md §4.2。
 *
 * 背景与硬约束(勿删):manager 走 EngineOptions.disableCompaction: true 完全接管压缩,
 * 这同时关掉了 engine query-loop.ts 里的两条压缩路径——
 *   ① 每轮 turn 前的阈值压缩(shouldCompact);
 *   ② stop_reason==='max_tokens' 时无视阈值的强压重试(上限 2 次)。
 * 因此本文件的职责边界是:
 *   - decideCompaction 的 fold_at_wake / force_hot 接管①(唤醒边界折叠 + 热态强压兜底);
 *   - ② 的 max_tokens 情形属于 episode 失败处理语义,由 Task 7 负责编排——本文件只
 *     提供 force_hot 决策与 foldIntoSummary 折叠能力供其复用,不在这里处理重试/失败语义。
 * 不改 engine:ContextManager 的 compactSystemPrompt/keepRecentMessages 未暴露到
 * EngineOptions,这里不复用,自行实现折叠(纯 LLM 摘要,不做启发式截断)。
 */

import { callNonStreaming, createUserMessage } from '../engine/index.js'
import type { EngineMessage, LLMAdapter } from '../engine/index.js'
import type { ManagerSessionState } from './types.js'

export interface CompactionPolicy {
  /** 尾巴保留条数 */
  readonly keepRecent: number
  /** 缓存热判定阈值(ms) */
  readonly cacheTtlMs: number
  /** 唤醒边界折叠的历史 token 阈值 */
  readonly foldTokenThreshold: number
  /** 热态强压的总 token 上限 */
  readonly hardCapTokens: number
}

export type CompactionDecision =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'fold_at_wake'
      readonly foldMessages: ReadonlyArray<EngineMessage>
      readonly keep: ReadonlyArray<EngineMessage>
    }
  | {
      readonly kind: 'force_hot'
      readonly foldMessages: ReadonlyArray<EngineMessage>
      readonly keep: ReadonlyArray<EngineMessage>
    }

/**
 * 纯决策函数:无 IO、无 LLM 调用、不读系统时钟——nowMs 与 estimateTokens 均由调用方
 * 注入,保证测试确定性,也让"当前时间"这个易变量不会污染决策路径本身。
 *
 * 规则(protocol §4.2):
 *   - 历史不足 keepRecent 条 → none(burst 内只追加,吃满前缀缓存);
 *   - 缓存已冷(nowMs - lastActiveAt > cacheTtlMs)且待折叠历史 token > foldTokenThreshold
 *     → fold_at_wake;
 *   - 缓存仍热但总 token > hardCapTokens → force_hot;
 *   - 否则 none。
 *
 * lastActiveAt 缺失(从未记录过活动,如全新 session)按"未冷"处理:没有历史活动记录就
 * 谈不上"距上次活动超过 TTL"。真实场景下这类 state 的 recent 本就几乎不可能超过
 * keepRecent(已被上面的"历史不足"分支拦截),这里只是语义上的显式选择;若出现防御性
 * 场景(异常累积且从未落过 lastActiveAt),仍会走 hardCapTokens 兜底为 force_hot,不会
 * 因为"未冷"就放任 token 无限增长。
 *
 * foldMessages/keep 的切分点不是裸下标 history.length - keepRecent,而是走
 * findSafeSplitIndex(见下方定义)避开 tool_use/tool_result 配对中间——history 里大量
 * assistant(tool_use) → toolResults 相邻对(worker 六件套/messaging 全是工具调用),裸切分
 * 会把孤儿 toolResults 消息留在 keep 头部,发给 LLM 时其 tool_use_id 找不到匹配的前置
 * tool_use,触发 API 400 且无自愈路径(永久卡死,详见 findSafeSplitIndex 注释)。
 */
export function decideCompaction(args: {
  readonly state: ManagerSessionState
  readonly nowMs: number
  readonly policy: CompactionPolicy
  readonly estimateTokens: (msgs: ReadonlyArray<EngineMessage>) => number
}): CompactionDecision {
  const { state, nowMs, policy, estimateTokens } = args
  const history = state.recent

  if (history.length < policy.keepRecent) {
    return { kind: 'none' }
  }

  const splitAt = findSafeSplitIndex(history, policy.keepRecent)
  const foldMessages = history.slice(0, splitAt)
  const keep = history.slice(splitAt)

  const isCold =
    state.lastActiveAt !== undefined && nowMs - Date.parse(state.lastActiveAt) > policy.cacheTtlMs

  if (isCold) {
    if (estimateTokens(foldMessages) > policy.foldTokenThreshold) {
      return { kind: 'fold_at_wake', foldMessages, keep }
    }
    return { kind: 'none' }
  }

  if (estimateTokens(history) > policy.hardCapTokens) {
    if (foldMessages.length === 0) {
      // history.length === keepRecent:splitAt=0,没有任何可折叠的历史(keep=全部历史)。
      // 强行对空 transcript 调一次折叠 LLM 是零进展的空折叠——白烧一次调用,recent 原样不变,
      // 还可能让已有 rollingSummary 被"无新增输入"的合并重写而漂移;热态 burst 下每次唤醒都会
      // 重复这笔开销。fold_at_wake 分支已经被 estimateTokens([]) > foldTokenThreshold 自然
      // 拦住(0 不可能 > 正数阈值),这里是 force_hot 分支唯一需要显式补的漏。
      return { kind: 'none' }
    }
    return { kind: 'force_hot', foldMessages, keep }
  }
  return { kind: 'none' }
}

/**
 * 用 LLM 把 foldMessages 折叠进(可能已存在的)滚动摘要,返回新摘要文本。
 *
 * 前缀稳定性要求(见 decideCompaction 的调用方约定):返回的摘要必须是纯文本、不含
 * 时间戳/计数等易变量——否则同一段历史被两次折叠会产出不同字节的摘要块,破坏"静态段
 * 前缀不变"这一 prompt cache 命中的前提。若未来需要携带诊断用元信息,必须放在摘要块
 * 之外(例如 ManagerSessionState.foldedCount),不要混进这里的返回值。
 *
 * 走 callNonStreaming(engine 导出的流式消费 + 整流重试封装)而非直接拼 adapter.stream:
 * 折叠是一次性、非交互的单轮调用,不需要増量消费流式 chunk,callNonStreaming 现成地
 * 提供了断流重试,不必在这里重新实现。
 */
export async function foldIntoSummary(args: {
  readonly adapter: LLMAdapter
  readonly model: string
  readonly prevSummary: string | undefined
  readonly foldMessages: ReadonlyArray<EngineMessage>
}): Promise<string> {
  const { adapter, model, prevSummary, foldMessages } = args

  const transcript = foldMessages.map(renderMessageForFold).join('\n\n')
  const promptParts: string[] = []
  if (prevSummary !== undefined) {
    promptParts.push(`此前摘要:\n${prevSummary}`)
  }
  promptParts.push(`待折叠的新增对话:\n${transcript}`)
  promptParts.push('请把以上内容(含此前摘要,若有)合并为一段更新后的摘要,只输出摘要正文本身,不要加任何前后缀说明、时间戳或计数。')

  const response = await callNonStreaming(adapter, {
    messages: [createUserMessage(promptParts.join('\n\n'))],
    systemPrompt: '你是对话历史压缩助手,负责把对话折叠成简洁但保留关键信息的摘要,供后续对话轮次续接上下文。',
    tools: [],
    model,
  })

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('')

  if (!text) {
    throw new Error('[foldIntoSummary] LLM 返回空摘要')
  }
  return text
}

/**
 * 找一个安全的切分点:保证 keep 段第一条消息不是孤儿 tool_result(其匹配的 tool_use 若被
 * 划进 foldMessages 折叠段,该 tool_result 引用的 tool_use_id 在发给 LLM 的消息里找不到
 * 对应的前置 tool_use,Anthropic 等 API 会直接 400——manager 每个后续 episode 都会命中,
 * 且 400 的错误文案不匹配 isContextOverflow,没有自愈路径,是永久卡死。
 *
 * 与 engine/context-manager.ts 的 findSafeSplitIndex 同一语义、同一写法(那边服务于
 * engine 内建压缩,这边服务于 manager 自管压缩),两处保持一致,改一处需同步检查另一处。
 * assistant(tool_use) 与其 toolResults 消息严格相邻,回退时只要落在 toolResults 消息上
 * 就继续回退,直到落在非 toolResults 消息(或到 0)。回退后 keep 可能比 keepRecent 多几条——
 * 这是有意为之的取舍:宁可多留几条历史吃不满 keepRecent 的折叠效率,也不能把孤儿
 * tool_result 放进 keep 头部。
 */
function findSafeSplitIndex(history: ReadonlyArray<EngineMessage>, keepRecent: number): number {
  let splitAt = history.length - keepRecent
  while (splitAt > 0 && 'toolResults' in history[splitAt]) splitAt--
  return splitAt
}

/** 把一条 EngineMessage 渲染成折叠 prompt 里的一段文本(只取语义内容,不含 id/timestamp)。 */
function renderMessageForFold(msg: EngineMessage): string {
  if (msg.role === 'assistant') {
    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
    return `assistant: ${text}`
  }
  if ('toolResults' in msg) {
    return msg.toolResults.map((r) => `tool_result(${r.tool_use_id}): ${r.content}`).join('\n')
  }
  const text =
    typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('')
  return `user: ${text}`
}
