/**
 * Crab-Messaging MCP Server — Agent 统一通讯能力
 *
 * 提供 8 个工具：lookup_friend, list_contacts, list_groups, list_sessions, open_private_session, send_message, get_history, get_message
 * 对齐 protocol-crab-messaging.md
 *
 * @see crabot-docs/protocols/protocol-crab-messaging.md
 */

import { createMcpServer, type McpServer } from './mcp-helpers.js'
import { z } from 'zod/v4'
import type { RpcClient } from '../core/module-base.js'
import type { ModuleId, FriendId } from '../core/base-protocol.js'
import * as path from 'path'

// ============================================================================
// 依赖注入接口
// ============================================================================

export interface CrabMessagingDeps {
  rpcClient: RpcClient
  moduleId: string
  getAdminPort: () => Promise<number>
  resolveChannelPort: (channelId: string) => Promise<number>
}

// ============================================================================
// 路径映射（Worker 执行时动态设置）
// ============================================================================

export interface PathMapping {
  sandbox_path: string
  host_path: string
  read_only: boolean
}

// ============================================================================
// Admin RPC 返回的 Friend 类型
// ============================================================================

interface Friend {
  id: FriendId
  display_name: string
  permission: 'master' | 'normal'
  channel_identities: Array<{
    channel_id: ModuleId
    platform_user_id: string
    platform_display_name?: string
  }>
}

// ============================================================================
// 路径转换
// ============================================================================

/**
 * 安全的沙盒路径→主机路径转换
 * 对齐 protocol-crab-messaging.md：normalize 防止路径穿越，替换后二次验证
 */
function mapSandboxPathToHost(sandboxPath: string, mappings: PathMapping[]): string {
  const normalizedPath = path.normalize(sandboxPath)

  for (const mapping of mappings) {
    const normalizedSandbox = path.normalize(mapping.sandbox_path)
    if (normalizedPath.startsWith(normalizedSandbox)) {
      const relativePart = normalizedPath.slice(normalizedSandbox.length)
      const hostPath = path.join(mapping.host_path, relativePart)
      const normalizedHost = path.normalize(hostPath)
      // 二次验证：确保结果路径仍在映射的 host_path 目录内
      if (!normalizedHost.startsWith(path.normalize(mapping.host_path))) {
        throw new Error('Resolved path escapes allowed directory')
      }
      return normalizedHost
    }
  }

  throw new Error(`Path ${sandboxPath} is not accessible from sandbox`)
}

// ============================================================================
// 重试逻辑
// ============================================================================

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delays = [1000, 2000, 4000],
): Promise<T> {
  let lastError: Error | undefined
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const isRetryable = lastError.message.includes('ECONNREFUSED')
        || lastError.message.includes('ETIMEDOUT')
        || lastError.message.includes('ECONNRESET')
        || lastError.message.includes('socket hang up')
      if (!isRetryable || i === maxRetries - 1) throw lastError
      await new Promise(resolve => setTimeout(resolve, delays[i] ?? 4000))
    }
  }
  throw lastError
}

// ============================================================================
// MCP Server 创建
// ============================================================================

export function createCrabMessagingServer(
  deps: CrabMessagingDeps,
  sandboxPathMappingsRef?: { current: PathMapping[] },
): McpServer {
  const { rpcClient, moduleId, getAdminPort, resolveChannelPort } = deps

  const server = createMcpServer({ name: 'crab-messaging', version: '1.0.0' })

  // ================================================================
  // 1. lookup_friend — 查找熟人
  // ================================================================
  server.tool(
        'lookup_friend',
        '搜索熟人信息，包括该熟人在哪些 Channel 上有身份。可按名称模糊搜索或按 friend_id 精确查找。',
        {
          name: z.string().optional().describe('按名称模糊搜索'),
          friend_id: z.string().optional().describe('按 friend_id 精确查找'),
        },
        async (args) => {
          if (!args.name && !args.friend_id) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: '必须提供 name 或 friend_id 至少一个查询条件' }) }],
            }
          }

          const adminPort = await getAdminPort()

          if (args.friend_id) {
            try {
              const result = await rpcClient.call<
                { friend_id: string },
                { friend: Friend }
              >(adminPort, 'get_friend', { friend_id: args.friend_id }, moduleId)

              const friend = result.friend
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    friends: [{
                      friend_id: friend.id,
                      display_name: friend.display_name,
                      permission: friend.permission,
                      channels: friend.channel_identities.map(ci => ({
                        channel_id: ci.channel_id,
                        platform_user_id: ci.platform_user_id,
                        platform_display_name: ci.platform_display_name ?? ci.platform_user_id,
                      })),
                    }],
                  }),
                }],
              }
            } catch (err) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: `Friend not found: ${args.friend_id}` }) }],
              }
            }
          }

          // 按名称搜索
          const result = await rpcClient.call<
            { search?: string; pagination?: { page: number; page_size: number } },
            { items: Friend[]; pagination: { total_items: number } }
          >(adminPort, 'list_friends', { search: args.name, pagination: { page: 1, page_size: 20 } }, moduleId)

          const friends = result.items.map(f => ({
            friend_id: f.id,
            display_name: f.display_name,
            permission: f.permission,
            channels: f.channel_identities.map(ci => ({
              channel_id: ci.channel_id,
              platform_user_id: ci.platform_user_id,
              platform_display_name: ci.platform_display_name ?? ci.platform_user_id,
            })),
          }))

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ friends }) }],
          }
        },
      ),

      // ================================================================
      // 2. list_contacts — 列出渠道的联系人列表（包含非熟人）
      // ================================================================
  server.tool(
        'list_contacts',
        '列出渠道的联系人列表（包含非熟人）',
        {
          channel_id: z.string().describe('渠道 ID'),
          search: z.string().optional().describe('联系人名称搜索关键词'),
          limit: z.number().optional().describe('返回数量上限，默认 50'),
          offset: z.number().optional().describe('分页偏移'),
        },
        async (args) => {
          const adminPort = await getAdminPort()

          const result = await rpcClient.call(
            adminPort,
            'list_sessions',
            {
              channel_id: args.channel_id,
              type: 'private',
              search: args.search,
              limit: args.limit ?? 50,
              offset: args.offset ?? 0,
            },
            moduleId,
          )
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        },
      ),

      // ================================================================
      // 2b. list_groups — 列出渠道的群聊列表
      // ================================================================
  server.tool(
        'list_groups',
        '列出渠道的群聊列表',
        {
          channel_id: z.string().describe('渠道 ID'),
          search: z.string().optional().describe('群名搜索关键词'),
          limit: z.number().optional().describe('返回数量上限，默认 50'),
          offset: z.number().optional().describe('分页偏移'),
        },
        async (args) => {
          const adminPort = await getAdminPort()

          const result = await rpcClient.call(
            adminPort,
            'list_sessions',
            {
              channel_id: args.channel_id,
              type: 'group',
              search: args.search,
              limit: args.limit ?? 50,
              offset: args.offset ?? 0,
            },
            moduleId,
          )
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        },
      ),

      // ================================================================
      // 3. list_sessions — 查看会话列表
      // ================================================================
  server.tool(
        'list_sessions',
        '查看指定 Channel 上的会话列表。',
        {
          channel_id: z.string().describe('Channel 模块实例 ID'),
          type: z.enum(['private', 'group']).optional().describe('按类型过滤'),
        },
        async (args) => {
          try {
            const channelPort = await resolveChannelPort(args.channel_id)
            if (!channelPort) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: `Channel ${args.channel_id} 不可用` }) }],
              }
            }

            const result = await rpcClient.call<
              { type?: string },
              { sessions: Array<{ session_id: string; type: string; title: string; participant_count: number }> }
            >(channelPort, 'get_sessions', { type: args.type }, moduleId)

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `Channel 不可用: ${msg}` }) }],
            }
          }
        },
      ),

      // ================================================================
      // 4. open_private_session — 打开/创建私聊
      // ================================================================
  server.tool(
        'open_private_session',
        '在指定 Channel 上查找或创建与某个熟人的私聊 Session。',
        {
          channel_id: z.string().describe('Channel 模块实例 ID'),
          friend_id: z.string().describe('目标熟人 ID'),
        },
        async (args) => {
          try {
            // 1. 查询 friend 的 channel_identities
            const adminPort = await getAdminPort()
            const friendResult = await rpcClient.call<
              { friend_id: string },
              { friend: Friend }
            >(adminPort, 'get_friend', { friend_id: args.friend_id }, moduleId)

            const identity = friendResult.friend.channel_identities.find(
              ci => ci.channel_id === args.channel_id,
            )
            if (!identity) {
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: `熟人 ${friendResult.friend.display_name} 在 Channel ${args.channel_id} 上没有身份`,
                    available_channels: friendResult.friend.channel_identities.map(ci => ci.channel_id),
                  }),
                }],
              }
            }

            // 2. 调用 Channel 的 find_or_create_private_session
            const channelPort = await resolveChannelPort(args.channel_id)
            if (!channelPort) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: `Channel ${args.channel_id} 不可用` }) }],
              }
            }
            const result = await rpcClient.call<
              { platform_user_id: string },
              { session_id: string; created: boolean }
            >(channelPort, 'find_or_create_private_session', {
              platform_user_id: identity.platform_user_id,
            }, moduleId)

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
            }
          }
        },
      ),

      // ================================================================
      // 5. send_message — 发送消息
      // ================================================================
  server.tool(
        'send_message',
        '在指定 Channel 的指定 Session 中发送消息。支持文本、媒体 URL、本地文件路径。',
        {
          channel_id: z.string().describe('Channel 模块实例 ID'),
          session_id: z.string().describe('目标 Session ID'),
          content: z.string().describe('消息内容（文本或描述）'),
          content_type: z.enum(['text', 'image', 'file']).optional().describe('消息类型，默认 text'),
          media_url: z.string().optional().describe('媒体 URL（网络地址，与 file_path 二选一）'),
          file_path: z.string().optional().describe('沙盒内本地文件路径（自动转换为主机路径）'),
          filename: z.string().optional().describe('文件名（可选）'),
          mentions: z.array(z.string()).optional().describe('@提及的熟人 ID 列表'),
          quote_message_id: z.string().optional().describe('引用回复的平台消息 ID'),
        },
        async (args) => {
          try {
            const channelPort = await resolveChannelPort(args.channel_id)
            if (!channelPort) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: `Channel ${args.channel_id} 不可用` }) }],
              }
            }

            // 按优先级构造 MessageContent
            type MessageContent = {
              type: string
              text?: string
              media_url?: string
              file_path?: string
              filename?: string
            }
            let messageContent: MessageContent

            if (args.media_url) {
              messageContent = {
                type: args.content_type ?? 'image',
                media_url: args.media_url,
                filename: args.filename,
              }
            } else if (args.file_path) {
              const mappings = sandboxPathMappingsRef?.current ?? []
              let hostPath: string

              if (mappings.length > 0) {
                // 有路径映射（远程 Worker）：沙盒路径 → 主机路径
                try {
                  hostPath = mapSandboxPathToHost(args.file_path, mappings)
                } catch (pathErr) {
                  return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: pathErr instanceof Error ? pathErr.message : String(pathErr) }) }],
                  }
                }
              } else if (path.isAbsolute(args.file_path)) {
                // 无路径映射（本地 unified agent）：绝对路径直接使用
                hostPath = args.file_path
              } else {
                return {
                  content: [{ type: 'text' as const, text: JSON.stringify({ error: '相对路径需要路径映射配置，请使用绝对路径' }) }],
                }
              }

              messageContent = {
                type: args.content_type ?? 'file',
                file_path: hostPath,
                filename: args.filename ?? path.basename(args.file_path),
              }
            } else {
              messageContent = {
                type: 'text',
                text: args.content,
              }
            }

            // 转换 mentions：friend_id → platform_user_id（并行解析）
            let platformMentions: Array<{ platform_user_id: string }> | undefined
            if (args.mentions && args.mentions.length > 0) {
              const adminPort = await getAdminPort()
              const resolved = await Promise.all(
                args.mentions.map(async (friendId) => {
                  try {
                    const fResult = await rpcClient.call<
                      { friend_id: string },
                      { friend: Friend }
                    >(adminPort, 'get_friend', { friend_id: friendId }, moduleId)
                    const identity = fResult.friend.channel_identities.find(
                      ci => ci.channel_id === args.channel_id,
                    )
                    return identity ? { platform_user_id: identity.platform_user_id } : null
                  } catch {
                    return null
                  }
                }),
              )
              platformMentions = resolved.filter((m): m is NonNullable<typeof m> => m !== null)
            }

            // 带重试发送消息
            const result = await withRetry(async () => {
              return rpcClient.call<
                {
                  session_id: string
                  content: MessageContent
                  features?: {
                    mentions?: Array<{ platform_user_id: string }>
                    quote_message_id?: string
                  }
                },
                { platform_message_id: string; sent_at: string }
              >(channelPort, 'send_message', {
                session_id: args.session_id,
                content: messageContent,
                ...(platformMentions || args.quote_message_id ? {
                  features: {
                    ...(platformMentions ? { mentions: platformMentions } : {}),
                    ...(args.quote_message_id ? { quote_message_id: args.quote_message_id } : {}),
                  },
                } : {}),
              }, moduleId)
            })

            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `发送失败: ${msg}` }) }],
            }
          }
        },
      ),

      // ================================================================
      // 6. get_history — 查看聊天记录
      // ================================================================
  server.tool(
        'get_history',
        '查看指定 Channel 上某个 Session 的历史消息。',
        {
          channel_id: z.string().describe('Channel 模块实例 ID'),
          session_id: z.string().describe('Session ID'),
          keyword: z.string().optional().describe('关键词过滤'),
          limit: z.number().optional().describe('返回条数上限，默认 20'),
          before: z.string().optional().describe('查询此时间之前的消息（ISO 8601）'),
          after: z.string().optional().describe('查询此时间之后的消息（ISO 8601）'),
        },
        async (args) => {
          try {
            const channelPort = await resolveChannelPort(args.channel_id)
            if (!channelPort) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: `Channel ${args.channel_id} 不可用` }) }],
              }
            }

            const timeRange = (args.before || args.after)
              ? { before: args.before, after: args.after }
              : undefined

            const result = await rpcClient.call<
              {
                session_id: string
                time_range?: { before?: string; after?: string }
                keyword?: string
                limit?: number
              },
              {
                // Channel 协议返回 PaginatedResult<HistoryMessage>，字段名是 items
                items: Array<{
                  platform_message_id: string
                  sender_name: string
                  sender_platform_user_id?: string
                  content: string
                  content_type: string
                  timestamp: string
                }>
              }
            >(channelPort, 'get_history', {
              session_id: args.session_id,
              ...(timeRange ? { time_range: timeRange } : {}),
              ...(args.keyword ? { keyword: args.keyword } : {}),
              limit: args.limit ?? 20,
            }, moduleId)

            const messages = result.items ?? []

            // 将 platform_user_id 映射为 friend_id（去重后批量查询）
            const adminPort = await getAdminPort()
            const uniqueUserIds = [...new Set(
              messages
                .map(m => m.sender_platform_user_id)
                .filter((id): id is string => !!id),
            )]
            const friendMap = new Map<string, string | undefined>()
            await Promise.all(uniqueUserIds.map(async (puid) => {
              try {
                const resolveResult = await rpcClient.call<
                  { channel_id: string; platform_user_id: string },
                  { friend: Friend | null }
                >(adminPort, 'resolve_friend', {
                  channel_id: args.channel_id,
                  platform_user_id: puid,
                }, moduleId)
                friendMap.set(puid, resolveResult.friend?.id)
              } catch {
                // ignore mapping failures
              }
            }))

            const enrichedMessages = messages.map(msg => ({
              platform_message_id: msg.platform_message_id,
              sender_name: msg.sender_name,
              sender_friend_id: msg.sender_platform_user_id
                ? friendMap.get(msg.sender_platform_user_id)
                : undefined,
              content: msg.content,
              content_type: msg.content_type,
              timestamp: msg.timestamp,
            }))

            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ messages: enrichedMessages }) }],
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `查询历史失败: ${msg}` }) }],
            }
          }
        },
  )

      // ================================================================
      // 7. get_message — 按 ID 查询单条消息
      // ================================================================
  server.tool(
        'get_message',
        '按消息 ID 查询单条消息详情。当消息内容不完整时可用此工具查看完整内容。',
        {
          channel_id: z.string().describe('Channel 模块实例 ID'),
          session_id: z.string().describe('Session ID'),
          platform_message_id: z.string().describe('要查询的消息 ID'),
        },
        async (args) => {
          try {
            const channelPort = await resolveChannelPort(args.channel_id)
            if (!channelPort) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: `Channel ${args.channel_id} 不可用` }) }],
              }
            }

            const result = await rpcClient.call<
              { session_id: string; platform_message_id: string },
              {
                platform_message_id: string
                sender: { platform_user_id: string; platform_display_name: string }
                content: { type: string; text?: string; media_url?: string }
                features: Record<string, unknown>
                platform_timestamp: string
              }
            >(channelPort, 'get_message', {
              session_id: args.session_id,
              platform_message_id: args.platform_message_id,
            }, moduleId)

            // friend-id enrichment（与 get_history 保持一致）
            let senderFriendId: string | undefined
            const puid = result.sender?.platform_user_id
            if (puid) {
              try {
                const adminPort = await getAdminPort()
                const resolveResult = await rpcClient.call<
                  { channel_id: string; platform_user_id: string },
                  { friend: Friend | null }
                >(adminPort, 'resolve_friend', {
                  channel_id: args.channel_id,
                  platform_user_id: puid,
                }, moduleId)
                senderFriendId = resolveResult.friend?.id
              } catch {
                // ignore mapping failure
              }
            }

            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                platform_message_id: result.platform_message_id,
                sender_name: result.sender?.platform_display_name,
                sender_friend_id: senderFriendId,
                content: result.content?.text ?? '',
                content_type: result.content?.type ?? 'text',
                timestamp: result.platform_timestamp,
                quote_message_id: result.features?.quote_message_id,
              }) }],
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: `查询消息失败: ${msg}` }) }],
            }
          }
        },
  )

  return server
}
