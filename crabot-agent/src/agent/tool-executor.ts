/**
 * Tool Executor - Dispatches Front tool calls to backend services
 *
 * crab-messaging tools -> RPC calls to Admin/Channel modules
 * query_tasks -> local activeTasks + Admin RPC
 * create_schedule -> Admin RPC
 */

import type { RpcClient } from 'crabot-shared'
import type { Friend } from '../types.js'

export interface ToolExecutorDeps {
  rpcClient: RpcClient
  moduleId: string
  getAdminPort: () => Promise<number>
  resolveChannelPort: (channelId: string) => Promise<number>
  getActiveTasks: () => Array<{
    task_id: string
    status: string
    started_at: string
    title?: string
  }>
  getMemoryPort: () => Promise<number>
  memoryWriteVisibility: () => 'private' | 'internal' | 'public'
  memoryWriteScopes: () => string[]
}

export interface ToolResult {
  output: string
  isError: boolean
}

export class ToolExecutor {
  constructor(private deps: ToolExecutorDeps) {}

  async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (toolName) {
        case 'lookup_friend': return await this.lookupFriend(input)
        case 'list_contacts': return await this.listContacts(input)
        case 'list_groups': return await this.listGroups(input)
        case 'list_sessions': return await this.listSessions(input)
        case 'open_private_session': return await this.openPrivateSession(input)
        case 'send_message': return await this.sendMessage(input)
        case 'get_history': return await this.getHistory(input)
        case 'get_message': return await this.getMessage(input)
        case 'query_tasks': return await this.queryTasks(input)
        case 'create_schedule': return await this.createSchedule(input)
        case 'store_memory': return await this.storeMemory(input)
        case 'search_memory': return await this.searchMemory(input)
        case 'get_memory_detail': return await this.getMemoryDetail(input)
        default:
          return { output: JSON.stringify({ error: `"${toolName}" 不是可用工具。如果你想使用此能力，请调用 make_decision(type="create_task") 创建任务。` }), isError: true }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: JSON.stringify({ error: msg }), isError: true }
    }
  }

  private async lookupFriend(input: Record<string, unknown>): Promise<ToolResult> {
    const adminPort = await this.deps.getAdminPort()
    const { rpcClient, moduleId } = this.deps

    if (input.friend_id) {
      const result = await rpcClient.call<{ friend_id: string }, { friend: Friend }>(
        adminPort, 'get_friend', { friend_id: input.friend_id as string }, moduleId,
      )
      return { output: JSON.stringify({ friends: [this.formatFriend(result.friend)] }), isError: false }
    }

    if (input.name) {
      const result = await rpcClient.call<
        { search?: string; pagination?: { page: number; page_size: number } },
        { items: Friend[]; pagination: { total_items: number } }
      >(adminPort, 'list_friends', { search: input.name as string, pagination: { page: 1, page_size: 20 } }, moduleId)
      return { output: JSON.stringify({ friends: result.items.map(f => this.formatFriend(f)) }), isError: false }
    }

    return { output: JSON.stringify({ error: '必须提供 name 或 friend_id' }), isError: true }
  }

  private async listContacts(input: Record<string, unknown>): Promise<ToolResult> {
    const adminPort = await this.deps.getAdminPort()
    const result = await this.deps.rpcClient.call(
      adminPort,
      'list_sessions',
      {
        channel_id: input.channel_id as string,
        type: 'private',
        search: input.search as string | undefined,
        limit: (input.limit as number) ?? 50,
        offset: (input.offset as number) ?? 0,
      },
      this.deps.moduleId,
    )
    return { output: JSON.stringify(result), isError: false }
  }

  private async listGroups(input: Record<string, unknown>): Promise<ToolResult> {
    const adminPort = await this.deps.getAdminPort()
    const result = await this.deps.rpcClient.call(
      adminPort,
      'list_sessions',
      {
        channel_id: input.channel_id as string,
        type: 'group',
        search: input.search as string | undefined,
        limit: (input.limit as number) ?? 50,
        offset: (input.offset as number) ?? 0,
      },
      this.deps.moduleId,
    )
    return { output: JSON.stringify(result), isError: false }
  }

  private async listSessions(input: Record<string, unknown>): Promise<ToolResult> {
    const channelPort = await this.deps.resolveChannelPort(input.channel_id as string)
    const result = await this.deps.rpcClient.call<
      { type?: string },
      { sessions: Array<{ session_id: string; type: string; title: string; participant_count: number }> }
    >(channelPort, 'get_sessions', { type: input.type as string | undefined }, this.deps.moduleId)
    return { output: JSON.stringify(result), isError: false }
  }

  private async openPrivateSession(input: Record<string, unknown>): Promise<ToolResult> {
    const adminPort = await this.deps.getAdminPort()
    const friendResult = await this.deps.rpcClient.call<{ friend_id: string }, { friend: Friend }>(
      adminPort, 'get_friend', { friend_id: input.friend_id as string }, this.deps.moduleId,
    )
    const identity = friendResult.friend.channel_identities.find(ci => ci.channel_id === input.channel_id)
    if (!identity) {
      return {
        output: JSON.stringify({
          error: `熟人在 Channel ${input.channel_id} 上没有身份`,
          available_channels: friendResult.friend.channel_identities.map(ci => ci.channel_id),
        }),
        isError: true,
      }
    }
    const channelPort = await this.deps.resolveChannelPort(input.channel_id as string)
    const result = await this.deps.rpcClient.call<
      { platform_user_id: string }, { session_id: string; created: boolean }
    >(channelPort, 'find_or_create_private_session', { platform_user_id: identity.platform_user_id }, this.deps.moduleId)
    return { output: JSON.stringify(result), isError: false }
  }

  private async sendMessage(input: Record<string, unknown>): Promise<ToolResult> {
    const channelPort = await this.deps.resolveChannelPort(input.channel_id as string)
    const result = await this.deps.rpcClient.call<
      { session_id: string; content: { type: string; text?: string } },
      { platform_message_id: string; sent_at: string }
    >(channelPort, 'send_message', {
      session_id: input.session_id as string,
      content: { type: (input.content_type as string) ?? 'text', text: input.content as string },
    }, this.deps.moduleId)
    return { output: JSON.stringify(result), isError: false }
  }

  private async getHistory(input: Record<string, unknown>): Promise<ToolResult> {
    const channelPort = await this.deps.resolveChannelPort(input.channel_id as string)
    const timeRange = (input.before || input.after)
      ? { before: input.before as string | undefined, after: input.after as string | undefined }
      : undefined
    const result = await this.deps.rpcClient.call<
      { session_id: string; time_range?: { before?: string; after?: string }; keyword?: string; limit?: number },
      { items: Array<{ platform_message_id: string; sender_name: string; content: string; content_type: string; timestamp: string }> }
    >(channelPort, 'get_history', {
      session_id: input.session_id as string,
      ...(timeRange ? { time_range: timeRange } : {}),
      ...(input.keyword ? { keyword: input.keyword as string } : {}),
      limit: (input.limit as number) ?? 20,
    }, this.deps.moduleId)
    return { output: JSON.stringify({ messages: result.items ?? [] }), isError: false }
  }

  private async getMessage(input: Record<string, unknown>): Promise<ToolResult> {
    const channelPort = await this.deps.resolveChannelPort(input.channel_id as string)
    const result = await this.deps.rpcClient.call<
      { session_id: string; platform_message_id: string },
      Record<string, unknown>
    >(channelPort, 'get_message', {
      session_id: input.session_id as string,
      platform_message_id: input.platform_message_id as string,
    }, this.deps.moduleId)
    return { output: JSON.stringify(result), isError: false }
  }

  private async queryTasks(input: Record<string, unknown>): Promise<ToolResult> {
    const localTasks = this.deps.getActiveTasks()
    let adminTasks: Array<{ task_id: string; title: string; status: string; task_type: string }> = []
    try {
      const adminPort = await this.deps.getAdminPort()
      const adminResult = await this.deps.rpcClient.call<
        { status?: string[]; channel_id?: string },
        { tasks: Array<{ task_id: string; title: string; status: string; task_type: string }> }
      >(adminPort, 'query_tasks', {
        status: input.status ? [input.status as string] : ['executing', 'waiting_human', 'planning'],
        ...(input.channel_id ? { channel_id: input.channel_id as string } : {}),
      }, this.deps.moduleId)
      adminTasks = adminResult.tasks ?? []
    } catch {
      // Admin RPC unavailable — return local tasks only
    }
    return {
      output: JSON.stringify({ local_active: localTasks, admin_tasks: adminTasks }),
      isError: false,
    }
  }

  private async createSchedule(input: Record<string, unknown>): Promise<ToolResult> {
    const adminPort = await this.deps.getAdminPort()
    const result = await this.deps.rpcClient.call(adminPort, 'create_schedule', {
      title: input.title,
      description: input.description,
      trigger_at: input.trigger_at,
      cron: input.cron,
      action: input.action,
      target_channel_id: input.target_channel_id,
      target_session_id: input.target_session_id,
    }, this.deps.moduleId)
    return { output: JSON.stringify(result), isError: false }
  }

  private async storeMemory(input: Record<string, unknown>): Promise<ToolResult> {
    const memoryPort = await this.deps.getMemoryPort()
    const rpcParams = {
      content: input.content as string,
      source: { type: 'conversation' },
      importance: (input.importance as number) ?? 5,
      ...(input.tags ? { tags: input.tags as string[] } : {}),
      visibility: this.deps.memoryWriteVisibility(),
      scopes: this.deps.memoryWriteScopes(),
    }

    // Fire-and-forget: 不阻塞 Front loop，Memory 后台完成 L0/L1 生成和写入
    this.deps.rpcClient.call(memoryPort, 'write_long_term', rpcParams, this.deps.moduleId)
      .then(result => {
        const r = result as { action: string; memory: { id: string } }
        console.log(`[${this.deps.moduleId}] store_memory completed: ${r.action} ${r.memory.id}`)
      })
      .catch(err => {
        console.error(`[${this.deps.moduleId}] store_memory failed:`, err instanceof Error ? err.message : err)
      })

    return {
      output: JSON.stringify({
        success: true,
        action: 'accepted',
        message: 'Memory write accepted, processing in background.',
      }),
      isError: false,
    }
  }

  private async searchMemory(input: Record<string, unknown>): Promise<ToolResult> {
    const memoryPort = await this.deps.getMemoryPort()
    const limit = Math.min((input.limit as number) ?? 5, 20)
    const visibility = this.deps.memoryWriteVisibility()

    if (input.level === 'short_term') {
      const result = await this.deps.rpcClient.call<
        {
          query: string
          limit: number
          min_visibility: string
          accessible_scopes?: string[]
        },
        { results: Array<{ id: string; content: string; event_time: string; persons: string[]; topic?: string }> }
      >(memoryPort, 'search_short_term', {
        query: input.query as string,
        limit,
        min_visibility: visibility,
        ...(this.deps.memoryWriteScopes().length > 0
          ? { accessible_scopes: this.deps.memoryWriteScopes() }
          : {}),
      }, this.deps.moduleId)
      return { output: JSON.stringify(result), isError: false }
    }

    // Default: long_term
    const result = await this.deps.rpcClient.call<
      {
        query: string
        detail: string
        limit: number
        min_visibility: string
        accessible_scopes?: string[]
      },
      { results: Array<{ memory: { id: string; abstract: string; importance: number; tags: string[]; category: string }; relevance: number }> }
    >(memoryPort, 'search_long_term', {
      query: input.query as string,
      detail: 'L0',
      limit,
      min_visibility: visibility,
      ...(this.deps.memoryWriteScopes().length > 0
        ? { accessible_scopes: this.deps.memoryWriteScopes() }
        : {}),
    }, this.deps.moduleId)
    return { output: JSON.stringify(result), isError: false }
  }

  private async getMemoryDetail(input: Record<string, unknown>): Promise<ToolResult> {
    const memoryPort = await this.deps.getMemoryPort()
    const result = await this.deps.rpcClient.call<
      { memory_id: string },
      { memory: Record<string, unknown> }
    >(memoryPort, 'get_memory', {
      memory_id: input.memory_id as string,
    }, this.deps.moduleId)

    const mem = result.memory
    const detail = (input.detail as string) ?? 'L1'

    if (detail === 'L1') {
      return {
        output: JSON.stringify({
          id: mem.id,
          category: mem.category,
          abstract: mem.abstract,
          overview: mem.overview,
          entities: mem.entities,
          keywords: mem.keywords,
          importance: mem.importance,
          tags: mem.tags,
          source: mem.source,
        }),
        isError: false,
      }
    }

    // L2: return full object
    return { output: JSON.stringify(mem), isError: false }
  }

  private formatFriend(f: Friend) {
    return {
      friend_id: f.id,
      display_name: f.display_name,
      permission: f.permission,
      channels: f.channel_identities.map(ci => ({
        channel_id: ci.channel_id,
        platform_user_id: ci.platform_user_id,
        platform_display_name: ci.platform_display_name ?? ci.platform_user_id,
      })),
    }
  }
}
