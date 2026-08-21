/** Shared outbound channel dispatch for messaging tools and assistant-text fallback. */

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
 * crab-messaging.ts 重导出这个类型，供外部调用方使用。
 */
export interface PathMapping {
  sandbox_path: string
  host_path: string
  read_only: boolean
}

// ============================================================================
// 共享类型
// ============================================================================

/** A message ready for immediate channel dispatch. */
export interface OutboundMessage {
  readonly channel_id: string
  readonly session_id: string
  readonly content: string
  /**
   * send_message handler 传入的真实 intent。
   * - 'info': 进度告知 / 最终交付（默认，单向，不等回复）
   * - 'ask_human': 阻塞等人类同步回复
   *
   * Dispatch completion hooks use this value when recording the task message.
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
  readonly sent_at_attempt_ms: number
}

/** Called after a channel message is successfully delivered. */
export type OnDispatchedHook = (entry: OutboundMessage, sendResult: OutboundSendResult) => void

/**
 * dispatchOutboundMessage 所需依赖。
 *
 * - rpcClient + moduleId: 调 channel sendMessage / admin get_friend
 * - resolveChannelPort: channelId → 端口
 * - getAdminPort: 解析 friend_id 时调 admin
 * - sandboxPathMappingsRef: file_path → host_path 转换；本地 unified agent 路径下 mappings 可能为空,
 *   此时 dispatchOutboundMessage 会按"无映射且 file_path 是绝对路径"直接放行（与 immediate-send 一致）。
 * - onDispatched: invoked after a successful channel send; caller omits it when no bookkeeping is needed.
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
  prepare(entry: OutboundMessage, content: MessageContent): Promise<{ delivery_id: string; request_ids: string[]; content: MessageContent } | undefined>
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
  entry: OutboundMessage,
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
  entry: OutboundMessage,
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
 * Dispatch a message to its channel with sandbox path mapping and friend mention resolution.
 * Failures propagate to the caller.
 */
// 同一 tool invocation 的 delivery prepare 只跑一次（entry 对象在重试间共享）。
const preparedDeliveries = new WeakMap<OutboundMessage, Promise<{ delivery_id: string; request_ids: string[]; content: MessageContent } | undefined>>()

function prepareDeliveryOnce(
  entry: OutboundMessage,
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
  entry: OutboundMessage,
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

  // Completion hooks are best effort and never alter delivery success.
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
