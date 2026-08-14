/**
 * Outbound dispatch helper（send_message handler immediate-send 路径与 goal-mode flush 路径共享逻辑）
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.5
 *
 * 背景：Task 8 加 outboundBuffer flush 钩子时把实现 inline 在 agent-handler.ts，但缺少 sandbox path
 * mapping 和 admin RPC 通路，导致 flush 出去的 entry 会 silent drop file_path 和 friend_id-only mentions。
 * 这违反 audit gate 核心语义——"未审消息不到达用户"——会让 agent 自以为已发的文件实际丢失。
 *
 * 解法：把 send 核心逻辑（path mapping + mention resolve + channel sendMessage）抽到此处，
 * 让 immediate-send / flush 两条路径调同一个 dispatchOutboundMessage helper，行为完全一致。
 */

import * as path from 'path'
import type { RpcClient } from 'crabot-shared'
import type { Friend } from '../types.js'

// ============================================================================
// PathMapping（Worker 沙盒路径 ↔ 主机路径映射）
// ============================================================================

/**
 * 沙盒路径 ↔ 主机路径映射。Worker 执行时 unified-agent 在 sandboxPathMappingsRef 上设置。
 * file_path 类型消息需要先转主机路径再交给 channel 真正读文件。
 *
 * 此前定义在 crab-messaging.ts，因 flush 路径也需要而抽到此处，crab-messaging.ts 重导出。
 */
export interface PathMapping {
  sandbox_path: string
  host_path: string
  read_only: boolean
}

// ============================================================================
// 共享类型
// ============================================================================

/**
 * outboundBuffer 单条 entry shape，与 WorkerTaskState.outboundBuffer / TaskContext.outboundBuffer
 * 严格对齐。所有字段 readonly——entry 进 buffer 后任何路径都不应改 shape，splice 出来直接 dispatch。
 */
export interface OutboundBufferEntry {
  readonly channel_id: string
  readonly session_id: string
  readonly content: string
  /**
   * send_message handler 传入的真实 intent。
   * - 'info': 进度告知 / 最终交付（默认，单向，不等回复）
   * - 'ask_human': 阻塞等人类同步回复
   *
   * 钩子点（spec §4.13.6 / §4.13.7）会把 entry 透传给 onDispatched callback，
   * PR-2 用此字段把 task.messages 的 agent_intent 字段写真值（不再固定 'info'）。
   *
   * 注意 goal mode 缓冲分支只缓冲 intent='info' 的条目（ask_human 走 immediate-send
   * 不进 buffer），但 immediate-send 路径仍构造 OutboundBufferEntry 喂给 dispatchOutboundMessage，
   * 所以 entry 类型必须能表达 'ask_human'。
   */
  readonly intent: 'info' | 'ask_human'
  readonly content_type?: 'text' | 'image' | 'file'
  readonly media_url?: string
  readonly file_path?: string
  readonly filename?: string
  readonly mentions?: ReadonlyArray<{
    readonly friend_id?: string
    readonly platform_user_id?: string
    readonly at_name?: string
  }>
  readonly quote_message_id?: string
  /** send_message 工具调用发生时所属的人类输入轮次。 */
  readonly human_input_epoch?: number
  readonly sent_at_attempt_ms: number
}

/**
 * dispatch 钩子点 — `dispatchOutboundMessage` success 路径触发一次。
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.13.6 Invariants
 *
 * Invariant #1 — anchor 钉在 `dispatchOutboundMessage` success 返回之后：
 *   immediate-send / 缓冲分支新顶旧 sync flush / post-tool flush / audit pass flush
 *   四个入口的所有 caller 共享同一钩子，自动统一。
 *
 * Invariant #2 — `dispatchOutboundMessage` 抛错时不触发钩子：
 *   everSentMessage 不置 true、task.messages 不追加；"未送达 = 未发过" 跨边界对称。
 *
 * Invariant #3 — 钩子点是叠加点：
 *   PR-1（本 spec §4.13）加 `taskState.everSentMessage = true`
 *   PR-2（spec B §4.2）在同函数体追加 `task.messages.push(...)`，agent_intent 取 entry.intent，
 *     source.platform_message_id 取 sendResult.platform_message_id
 *   未来扩展可继续叠加，conflict 严格限定在 callback 函数体内。
 *
 * 签名（spec §4.13.7 Revision 2026-06-09 第 2 段）：(entry, sendResult) => void
 *   entry: dispatch 的 buffer entry（含真实 intent、content、media 字段等）
 *   sendResult: channel send_message RPC 返回（含 platform_message_id / sent_at）
 *
 * 钩子内任何抛错都被 dispatch 内 catch + warn，不污染 dispatch 返回。
 */
export type OnDispatchedHook = (entry: OutboundBufferEntry, sendResult: OutboundSendResult) => void

/**
 * dispatchOutboundMessage 所需依赖。
 *
 * - rpcClient + moduleId: 调 channel sendMessage / admin get_friend
 * - resolveChannelPort: channelId → 端口
 * - getAdminPort: 解析 friend_id 时调 admin
 * - sandboxPathMappingsRef: file_path → host_path 转换；本地 unified agent 路径下 mappings 可能为空,
 *   此时 dispatchOutboundMessage 会按"无映射且 file_path 是绝对路径"直接放行（与 immediate-send 一致）。
 * - onDispatched: 真正 flush 到 channel success 返回后调用一次的钩子（spec §4.13.6 / §4.13.7）。
 *   异常路径不触发；caller 不传时无副作用。
 *
 * sendResult 返回与 channel 'send_message' RPC 返回一致；调用方按需消费。
 */
/**
 * P6-A §11.5-9：Admin Chat 出站 delivery 事务钩子。仅当目标是 exact
 * `admin-web::admin-chat` 时才调用；其它 channel/session 一律不携带 delivery
 * metadata（crab-messaging 层不注入即剥离）。
 */
export interface AdminChatDeliveryHooks {
  /** 首次 RPC 之前调用：生成 delivery_id + claim 的 request IDs 并把 prepared 记录落盘。 */
  prepare(entry: OutboundBufferEntry, content: MessageContent): Promise<{ delivery_id: string; request_ids: string[]; content: MessageContent } | undefined>
  /** Admin 确认 commit 后：delivery → confirmed、request claim settled、wake 结算、staging 清理。 */
  confirm(deliveryId: string, result: OutboundSendResult): Promise<void>
  /** RPC 失败/结果未知：delivery 保持可重试（不标 confirmed）。 */
  fail(deliveryId: string, error: unknown): Promise<void>
}

export interface OutboundDispatchDeps {
  readonly rpcClient: RpcClient
  readonly moduleId: string
  readonly resolveChannelPort: (channelId: string) => Promise<number>
  readonly getAdminPort: () => Promise<number>
  readonly sandboxPathMappingsRef?: { current: PathMapping[] }
  readonly onDispatched?: OnDispatchedHook
  readonly adminChatDelivery?: AdminChatDeliveryHooks
}

export interface OutboundSendResult {
  readonly platform_message_id: string
  readonly sent_at: string
}

// ============================================================================
// 内部 helpers
// ============================================================================

/** 沙盒路径 → 主机路径（normalize + 二次验证防止穿越）。与 crab-messaging.ts 内私有实现等价。 */
function mapSandboxPathToHost(sandboxPath: string, mappings: ReadonlyArray<PathMapping>): string {
  const normalizedPath = path.normalize(sandboxPath)
  for (const mapping of mappings) {
    const normalizedSandbox = path.normalize(mapping.sandbox_path)
    if (normalizedPath.startsWith(normalizedSandbox)) {
      const relativePart = normalizedPath.slice(normalizedSandbox.length)
      const hostPath = path.join(mapping.host_path, relativePart)
      const normalizedHost = path.normalize(hostPath)
      if (!normalizedHost.startsWith(path.normalize(mapping.host_path))) {
        throw new Error('Resolved path escapes allowed directory')
      }
      return normalizedHost
    }
  }
  throw new Error(`Path ${sandboxPath} is not accessible from sandbox`)
}

type MessageContent = {
  type: string
  text?: string
  media_url?: string
  file_path?: string
  filename?: string
}

type PlatformMention = {
  platform_user_id: string
  at_name?: string
}

/** 按优先级（media_url > file_path > text）构造 channel 期望的 content payload */
function buildMessageContent(
  entry: OutboundBufferEntry,
  sandboxMappings: ReadonlyArray<PathMapping>,
): MessageContent {
  if (entry.media_url) {
    return {
      type: entry.content_type ?? 'image',
      media_url: entry.media_url,
      ...(entry.filename !== undefined ? { filename: entry.filename } : {}),
    }
  }
  if (entry.file_path) {
    let hostPath: string
    if (sandboxMappings.length > 0) {
      // 远程 worker：沙盒路径 → 主机路径（mapSandboxPathToHost 内含二次验证防穿越）
      hostPath = mapSandboxPathToHost(entry.file_path, sandboxMappings)
    } else if (path.isAbsolute(entry.file_path)) {
      // 本地 unified agent：绝对路径直接用
      hostPath = entry.file_path
    } else {
      throw new Error('相对路径需要路径映射配置，请使用绝对路径')
    }
    return {
      type: entry.content_type ?? 'file',
      file_path: hostPath,
      filename: entry.filename ?? path.basename(entry.file_path),
    }
  }
  return {
    type: 'text',
    text: entry.content,
  }
}

/**
 * 把 entry.mentions（friend_id 或 platform_user_id 形态）解析成 channel 期望的 platform_user_id 列表。
 * - 直传 platform_user_id：原样保留
 * - 仅 friend_id：调 admin get_friend 反查；找不到当前 channel 的 identity 时丢弃该 mention
 *
 * 返回 undefined 表示无 mentions（避免在 features 里塞空数组）。
 */
async function resolvePlatformMentions(
  entry: OutboundBufferEntry,
  deps: OutboundDispatchDeps,
): Promise<PlatformMention[] | undefined> {
  if (!entry.mentions || entry.mentions.length === 0) return undefined
  const adminPort = await deps.getAdminPort()
  const resolved = await Promise.all(
    entry.mentions.map(async ({ friend_id, platform_user_id, at_name }) => {
      if (platform_user_id) {
        return { platform_user_id, ...(at_name !== undefined ? { at_name } : {}) }
      }
      if (!friend_id) return null
      try {
        const fResult = await deps.rpcClient.call<
          { friend_id: string },
          { friend: Friend }
        >(adminPort, 'get_friend', { friend_id }, deps.moduleId)
        const identity = fResult.friend.channel_identities.find(
          (ci) => ci.channel_id === entry.channel_id,
        )
        if (!identity) return null
        return {
          platform_user_id: identity.platform_user_id,
          ...(at_name !== undefined ? { at_name } : {}),
        }
      } catch {
        return null
      }
    }),
  )
  const filtered = resolved.filter((m): m is PlatformMention => m !== null)
  return filtered.length > 0 ? filtered : undefined
}

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 把一条 outboundBuffer entry 真正派发到 channel——含 sandbox path mapping + friend_id resolve。
 * 跟 send_message handler immediate-send 路径功能等价（同样的 path mapping + mention resolve + features 结构）。
 *
 * 失败抛 throw（不在此处吞错；flush 路径调用方在 createOutboundFlush 内做 continue-on-error，
 * 立即发路径让 send_message handler 自己 catch 转用户可见 error）。
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.5
 */
// 同一 tool invocation 的 delivery prepare 只跑一次（entry 对象在重试间共享）。
const preparedDeliveries = new WeakMap<OutboundBufferEntry, Promise<{ delivery_id: string; request_ids: string[]; content: MessageContent } | undefined>>()

function prepareDeliveryOnce(
  entry: OutboundBufferEntry,
  content: MessageContent,
  hooks: AdminChatDeliveryHooks,
): Promise<{ delivery_id: string; request_ids: string[]; content: MessageContent } | undefined> {
  const existing = preparedDeliveries.get(entry)
  if (existing) return existing
  const prepared = hooks.prepare(entry, content)
  preparedDeliveries.set(entry, prepared)
  // prepare 失败（如 staging 写盘）时清缓存：让 withRetry 的后续 attempt 真正重试 prepare。
  prepared.catch(() => { preparedDeliveries.delete(entry) })
  return prepared
}

export async function dispatchOutboundMessage(
  entry: OutboundBufferEntry,
  deps: OutboundDispatchDeps,
): Promise<OutboundSendResult> {
  const channelPort = await deps.resolveChannelPort(entry.channel_id)
  if (!channelPort) {
    throw new Error(`Channel ${entry.channel_id} 不可用`)
  }

  const sandboxMappings = deps.sandboxPathMappingsRef?.current ?? []
  const messageContent = buildMessageContent(entry, sandboxMappings)
  const platformMentions = await resolvePlatformMentions(entry, deps)

  const hasFeatures =
    (platformMentions !== undefined && platformMentions.length > 0)
    || entry.quote_message_id !== undefined

  // P6-A §11.7：admin-chat 目标先落 prepared delivery（delivery_id + claim 的 request IDs），
  // 再做首次 RPC。crab-messaging 的 withRetry 会整段重跑 dispatch——同一 tool invocation 的
  // 所有 attempt 共享同一个 dispatchEntry 对象，prepare 因此按 entry 记忆化：重试复用同一
  // delivery_id/request 集合/payload（§11.7），不会每 attempt 新造 delivery + 空 claim。
  const delivery = entry.channel_id === 'admin-web' && entry.session_id === 'admin-chat' && deps.adminChatDelivery
    ? await prepareDeliveryOnce(entry, messageContent, deps.adminChatDelivery)
    : undefined

  let sendResult: OutboundSendResult
  try {
    sendResult = await deps.rpcClient.call<
      {
        session_id: string
        content: MessageContent
        delivery_id?: string
        request_ids?: string[]
        features?: {
          mentions?: PlatformMention[]
          quote_message_id?: string
        }
      },
      OutboundSendResult
    >(channelPort, 'send_message', {
      session_id: entry.session_id,
      // 与 prepare 落盘的 payload 同源（staged attachment 引用）——payload_sha256 校验依赖。
      content: delivery ? delivery.content : messageContent,
      ...(delivery ? { delivery_id: delivery.delivery_id, request_ids: delivery.request_ids } : {}),
      ...(hasFeatures
        ? {
          features: {
            ...(platformMentions !== undefined && platformMentions.length > 0
              ? { mentions: platformMentions }
              : {}),
            ...(entry.quote_message_id !== undefined
              ? { quote_message_id: entry.quote_message_id }
              : {}),
          },
        }
        : {}),
    }, deps.moduleId)
  } catch (error) {
    if (delivery) await deps.adminChatDelivery!.fail(delivery.delivery_id, error)
    throw error
  }
  if (delivery) await deps.adminChatDelivery!.confirm(delivery.delivery_id, sendResult)

  // <-- HOOK POINT (spec §4.13.6 Invariant #1: success 路径触发；Invariant #2: 抛错路径上方 await 已throw，不到此处) -->
  // 钩子内任何 throw 都被 catch 后 console.warn，避免污染 dispatch 返回 / 影响 caller。
  // sendResult 一并透传，PR-2 等叠加 effect 需要 platform_message_id / sent_at 时直接取。
  if (deps.onDispatched) {
    try {
      deps.onDispatched(entry, sendResult)
    } catch (err) {
      console.warn(
        '[dispatchOutboundMessage] onDispatched hook threw:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return sendResult
}

/** flush 时单条消息发送失败的回传项——engine 据此注入给 worker，避免失败被静默吞掉。 */
export interface OutboundFlushFailure {
  /** 失败消息的内容摘要，让 worker 认出是哪条。 */
  readonly summary: string
  /** 失败原因（dispatch 抛出的错误信息）。 */
  readonly error: string
}

/** flush 结果：sentCount=本次真正送达的条数（engine 据此清除 pending-delivery 追踪），failures=失败明细。 */
export interface OutboundFlushResult {
  readonly sentCount: number
  readonly failures: OutboundFlushFailure[]
}

/** 把 buffer entry 压成一句话摘要，供失败回传时让 worker 辨认。 */
function summarizeEntry(entry: OutboundBufferEntry): string {
  const text = (entry.content ?? '').trim()
  const attachment = entry.file_path
    ? `[文件: ${entry.filename ?? entry.file_path}]`
    : entry.media_url
      ? `[媒体: ${entry.filename ?? entry.media_url}]`
      : ''
  const base = [text, attachment].filter(Boolean).join(' ').trim() || '(空消息)'
  return base.length > 60 ? `${base.slice(0, 60)}…` : base
}

/**
 * 工厂返回 flush 函数：splice buffer + 逐 entry dispatch + continue on error。
 *
 * - splice(0) 一次性取出所有缓冲项，失败的不放回；buffer 永远不被反复 flush
 * - 单条 entry dispatch 抛异常时不阻塞后续 entry，但把"摘要+原因"收进返回的 failures：
 *   engine 据此把发送失败注入给 worker（旧版只 warn 一行就吞掉，让 worker 误以为已送达——
 *   trace a72623ec 成因之二）。
 * - 返回 sentCount：engine 用它区分"真送出去了"和"空 buffer no-op"——只有真送出至少一条
 *   才允许清除 pending-delivery 追踪；否则 worker 续轮不重发直接 end_turn 会被空 flush 骗过。
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 8
 */
export function createOutboundFlush(
  outboundBuffer: Array<OutboundBufferEntry>,
  deps: OutboundDispatchDeps,
): () => Promise<OutboundFlushResult> {
  return async () => {
    if (outboundBuffer.length === 0) return { sentCount: 0, failures: [] }
    const entries = outboundBuffer.splice(0)
    const failures: OutboundFlushFailure[] = []
    let sentCount = 0
    for (const entry of entries) {
      try {
        await dispatchOutboundMessage(entry, deps)
        sentCount++
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.warn('[outbound flush] entry failed:', error)
        failures.push({ summary: summarizeEntry(entry), error })
      }
    }
    return { sentCount, failures }
  }
}
