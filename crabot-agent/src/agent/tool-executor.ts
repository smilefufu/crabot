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

/** brief 必须 ≤80 字符且非空，从 content 首行截取 */
function deriveBriefFromContent(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const trimmed = firstLine || content.trim()
  return trimmed.slice(0, 80) || 'untitled'
}

/** 1-10 importance → 4 维 importance_factors（0-1 区间） */
function importanceToFactors(importance: number | undefined): {
  proximity: number
  surprisal: number
  entity_priority: number
  unambiguity: number
} {
  const raw = typeof importance === 'number' ? importance : 5
  const clamped = Math.min(10, Math.max(1, raw))
  const normalized = clamped / 10
  return {
    proximity: 0.5,
    surprisal: normalized,
    entity_priority: 0.5,
    unambiguity: 0.5,
  }
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
          return { output: JSON.stringify({ error: `"${toolName}" 不是可用工具。如果你想使用此能力，请调用 create_task 工具创建任务。` }), isError: true }
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
    let adminTasks: Array<{ task_id: string; title: string; status: string }> = []
    try {
      const adminPort = await this.deps.getAdminPort()
      const adminResult = await this.deps.rpcClient.call<
        { status?: string[]; channel_id?: string },
        { tasks: Array<{ task_id: string; title: string; status: string }> }
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
    // ---- 参数校验 ----
    const title = (input.title as string | undefined)?.trim()
    if (!title) {
      return { output: JSON.stringify({ error: 'title 不能为空' }), isError: true }
    }

    const action = (input.action as string) ?? 'send_reminder'
    if (action !== 'send_reminder' && action !== 'create_task') {
      return { output: JSON.stringify({ error: `action 必须是 "send_reminder" 或 "create_task"，收到: "${action}"` }), isError: true }
    }

    // trigger: 必须提供 trigger_at 或 cron 二选一
    let trigger: Record<string, unknown>
    if (input.cron) {
      const expression = (input.cron as string).trim()
      const parts = expression.split(/\s+/)
      if (parts.length < 5) {
        return { output: JSON.stringify({ error: `cron 表达式无效: "${expression}"，至少需要 5 个字段（分 时 日 月 周）` }), isError: true }
      }
      trigger = { type: 'cron', expression }
    } else if (input.trigger_at) {
      const executeAt = input.trigger_at as string
      const ts = new Date(executeAt).getTime()
      if (Number.isNaN(ts)) {
        return { output: JSON.stringify({ error: `trigger_at 格式无效: "${executeAt}"，请使用 ISO 8601 格式，如 2026-04-15T16:45:00+08:00` }), isError: true }
      }
      trigger = { type: 'once', execute_at: new Date(executeAt).toISOString() }
    } else {
      return { output: JSON.stringify({ error: '必须提供 trigger_at（一次性）或 cron（周期性），不能都为空' }), isError: true }
    }

    // send_reminder 时校验 channel/session
    if (action === 'send_reminder' && (!input.target_channel_id || !input.target_session_id)) {
      return { output: JSON.stringify({ error: 'action 为 send_reminder 时必须提供 target_channel_id 和 target_session_id' }), isError: true }
    }

    // ---- 构建 task_template ----
    const descParts: string[] = []
    if (input.description) descParts.push(input.description as string)

    if (action === 'send_reminder') {
      descParts.push(`\n[提醒指令] 使用 send_message 工具向 channel_id="${input.target_channel_id}" session_id="${input.target_session_id}" 发送提醒消息。提醒内容: ${title}`)
    }

    const task_template = {
      title,
      description: descParts.join('\n') || undefined,
      priority: 'normal' as const,
      tags: action === 'send_reminder' ? ['reminder'] : ['scheduled'],
    }

    // ---- 调用 Admin RPC ----
    const adminPort = await this.deps.getAdminPort()
    const result = await this.deps.rpcClient.call(adminPort, 'create_schedule', {
      name: title,
      description: input.description as string | undefined,
      enabled: true,
      trigger,
      task_template,
    }, this.deps.moduleId)
    return { output: JSON.stringify(result), isError: false }
  }

  private async storeMemory(input: Record<string, unknown>): Promise<ToolResult> {
    const memoryPort = await this.deps.getMemoryPort()
    const content = input.content as string
    const brief = (input.brief as string | undefined)?.trim() || deriveBriefFromContent(content)
    const type = (input.type as 'fact' | 'lesson' | 'concept' | undefined) ?? 'fact'
    const rpcParams = {
      type,
      brief,
      content,
      author: 'agent',
      source_ref: { type: 'conversation' as const },
      entities: [] as Array<{ type: string; id: string; name: string }>,
      tags: (input.tags as string[] | undefined) ?? [],
      importance_factors: importanceToFactors(input.importance as number | undefined),
    }

    // Fire-and-forget: 不阻塞 Front loop，Memory 后台完成索引/嵌入
    this.deps.rpcClient.call(memoryPort, 'quick_capture', rpcParams, this.deps.moduleId)
      .then(result => {
        const r = result as { id?: string; status?: string }
        console.log(`[${this.deps.moduleId}] store_memory completed: ${r.status ?? 'ok'} ${r.id ?? ''}`)
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

    // Default: long_term (Memory v2 contract)
    const result = await this.deps.rpcClient.call<
      {
        query: string
        k: number
        include: 'brief' | 'full'
        min_visibility: string
        accessible_scopes?: string[]
      },
      { results: Array<{ id: string; type: string; status: string; brief: string; tags?: string[] }> }
    >(memoryPort, 'search_long_term', {
      query: input.query as string,
      k: limit,
      include: 'brief',
      min_visibility: visibility,
      ...(this.deps.memoryWriteScopes().length > 0
        ? { accessible_scopes: this.deps.memoryWriteScopes() }
        : {}),
    }, this.deps.moduleId)
    return { output: JSON.stringify(result), isError: false }
  }

  private async getMemoryDetail(input: Record<string, unknown>): Promise<ToolResult> {
    const memoryPort = await this.deps.getMemoryPort()
    const include = (input.include as 'brief' | 'full' | undefined) ?? 'full'
    const result = await this.deps.rpcClient.call<
      { id: string; include: 'brief' | 'full' },
      { id: string; type: string; status: string; brief: string; body?: string; frontmatter?: Record<string, unknown> }
    >(memoryPort, 'get_memory', {
      id: input.memory_id as string,
      include,
    }, this.deps.moduleId)

    return { output: JSON.stringify(result), isError: false }
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
