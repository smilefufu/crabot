/**
 * Front Tools - Engine ToolDefinition format for Front Handler v2
 *
 * Decision tools: reply, create_task, supplement_task, stay_silent
 * Info tools: query_tasks, create_schedule
 * Messaging tools: lookup_friend, list_contacts, list_groups, list_sessions,
 *   open_private_session, send_message, get_history, get_message
 * Memory tools: store_memory, search_memory, get_memory_detail
 *
 * NOTE: These tools are NOT executed by the engine — the front-loop handles
 * them manually. The `call` property is a no-op placeholder.
 */

import type { ToolDefinition } from '../engine/types.js'

const NOOP_CALL = async () => ({ output: '', isError: false as const })

/** 决策工具名称，单一来源 */
const DECISION_NAMES = ['reply', 'create_task', 'supplement_task', 'stay_silent'] as const
export type DecisionToolName = typeof DECISION_NAMES[number]
export const DECISION_TOOL_NAMES: ReadonlySet<string> = new Set(DECISION_NAMES)

export const REPLY_TOOL: ToolDefinition = {
  name: 'reply',
  description: '直接回复用户。调用后对话结束，不会有后续动作。适用于简单问答、问候、信息查询。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      text: {
        type: 'string',
        description: '发给用户的最终完整回答。这是最终内容，不要写"让我查一下"等暗示后续动作的话。',
      },
    },
    required: ['text'],
  },
  isReadOnly: true,
  call: NOOP_CALL,
}

export const CREATE_TASK_TOOL: ToolDefinition = {
  name: 'create_task',
  description: '创建异步任务。适用于需要多步操作、外部访问、代码编写、深度分析等复杂请求。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_title: {
        type: 'string',
        description: '任务标题，简明扼要',
      },
      task_description: {
        type: 'string',
        description: '一句话分类标注，描述任务方向。不要概括用户需求，原始消息会完整传给执行环节。例如："分析挂靠功能需求并规划实现方案"',
      },
      task_type: {
        type: 'string',
        enum: ['general', 'code', 'analysis', 'command'],
        description: '任务类型，默认 general',
      },
      ack_text: {
        type: 'string',
        description: '立即发给用户的确认文本。必须简短自然，让用户知道你已收到并开始处理，如"好的，我来对比一下这几个产品"、"收到，正在分析代码"。',
      },
    },
    required: ['task_title', 'task_description', 'ack_text'],
  },
  isReadOnly: true,
  call: NOOP_CALL,
}

export function supplementTaskTool(activeTaskIds: readonly string[]): ToolDefinition {
  return {
    name: 'supplement_task',
    description: '补充或纠偏一个正在执行的任务。仅当用户消息明确针对某个活跃任务时使用。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: {
          type: 'string',
          enum: [...activeTaskIds],
          description: '目标任务 ID，必须是活跃任务列表中的一个',
        },
        content: {
          type: 'string',
          description: '提炼后的补充/纠偏内容',
        },
        ack_text: {
          type: 'string',
          description: '立即发给用户的确认文本，如"好的，我调整一下方向"',
        },
      },
      required: ['task_id', 'content', 'ack_text'],
    },
    isReadOnly: true,
    call: NOOP_CALL,
  }
}

export const STAY_SILENT_TOOL: ToolDefinition = {
  name: 'stay_silent',
  description: '静默不回复。仅群聊中使用，当消息与自己无关时选择。',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
  isReadOnly: true,
  call: NOOP_CALL,
}

export const QUERY_TASKS_TOOL: ToolDefinition = {
  name: 'query_tasks',
  category: 'task' as const,
  description: '查询当前活跃的任务列表和状态。用于回答用户关于任务进度的提问。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        description: '按状态过滤：executing, waiting_human, planning, completed, failed',
      },
      channel_id: {
        type: 'string',
        description: '按 Channel 过滤',
      },
    },
    required: [],
  },
  isReadOnly: true,
  call: NOOP_CALL,
}

export const CREATE_SCHEDULE_TOOL: ToolDefinition = {
  name: 'create_schedule',
  category: 'task' as const,
  description: '创建定时任务或提醒。支持一次性和周期性。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: '任务/提醒标题' },
      description: { type: 'string', description: '详细描述' },
      trigger_at: { type: 'string', description: '触发时间（ISO 8601），一次性提醒用此字段' },
      cron: { type: 'string', description: 'Cron 表达式，周期性任务用此字段' },
      action: {
        type: 'string',
        enum: ['send_reminder', 'create_task'],
        description: 'send_reminder=发送提醒消息, create_task=触发时创建 Worker 任务',
      },
      target_channel_id: { type: 'string', description: '提醒发送到的 channel' },
      target_session_id: { type: 'string', description: '提醒发送到的 session' },
    },
    required: ['title', 'action'],
  },
  isReadOnly: false,
  call: NOOP_CALL,
}

export const LOOKUP_FRIEND_TOOL: ToolDefinition = {
  name: 'lookup_friend',
  category: 'messaging' as const,
  description: '搜索熟人信息，包括该熟人在哪些 Channel 上有身份。可按名称模糊搜索或按 friend_id 精确查找。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: '按名称模糊搜索' },
      friend_id: { type: 'string', description: '按 friend_id 精确查找' },
    },
    required: [],
  },
  isReadOnly: true,
  call: NOOP_CALL,
}

export const LIST_CONTACTS_TOOL: ToolDefinition = {
  name: 'list_contacts',
  category: 'messaging' as const,
  description: '列出渠道的联系人列表（包含非熟人）',
  inputSchema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: '渠道 ID' },
      search: { type: 'string', description: '联系人名称搜索关键词' },
      limit: { type: 'number', description: '返回数量上限' },
    },
    required: ['channel_id'],
  },
  isReadOnly: true,
  call: NOOP_CALL,
}

export const LIST_GROUPS_TOOL: ToolDefinition = {
  name: 'list_groups',
  category: 'messaging' as const,
  description: '列出渠道的群聊列表',
  inputSchema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: '渠道 ID' },
      search: { type: 'string', description: '群名搜索关键词' },
      limit: { type: 'number', description: '返回数量上限' },
    },
    required: ['channel_id'],
  },
  isReadOnly: true,
  call: NOOP_CALL,
}

export const LIST_SESSIONS_TOOL: ToolDefinition = {
  name: 'list_sessions',
  category: 'messaging' as const,
  description: '查看指定 Channel 上的会话列表。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: 'Channel 模块实例 ID' },
      type: { type: 'string', enum: ['private', 'group'], description: '按类型过滤' },
    },
    required: ['channel_id'],
  },
  isReadOnly: true,
  call: NOOP_CALL,
}

export const OPEN_PRIVATE_SESSION_TOOL: ToolDefinition = {
  name: 'open_private_session',
  category: 'messaging' as const,
  description: '在指定 Channel 上查找或创建与某个熟人的私聊 Session。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: 'Channel 模块实例 ID' },
      friend_id: { type: 'string', description: '目标熟人 ID' },
    },
    required: ['channel_id', 'friend_id'],
  },
  isReadOnly: false,
  call: NOOP_CALL,
}

export const SEND_MESSAGE_TOOL: ToolDefinition = {
  name: 'send_message',
  category: 'messaging' as const,
  description: '在指定 Channel 的指定 Session 中发送消息。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: 'Channel 模块实例 ID' },
      session_id: { type: 'string', description: '目标 Session ID' },
      content: { type: 'string', description: '消息内容' },
      content_type: { type: 'string', enum: ['text', 'image', 'file'], description: '消息类型，默认 text' },
    },
    required: ['channel_id', 'session_id', 'content'],
  },
  isReadOnly: false,
  call: NOOP_CALL,
}

export const GET_HISTORY_TOOL: ToolDefinition = {
  name: 'get_history',
  category: 'messaging' as const,
  description: '查看指定 Channel 上某个 Session 的历史消息。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: 'Channel 模块实例 ID' },
      session_id: { type: 'string', description: 'Session ID' },
      keyword: { type: 'string', description: '关键词过滤' },
      limit: { type: 'number', description: '返回条数上限，默认 20' },
      before: { type: 'string', description: '查询此时间之前的消息（ISO 8601）' },
      after: { type: 'string', description: '查询此时间之后的消息（ISO 8601）' },
    },
    required: ['channel_id', 'session_id'],
  },
  isReadOnly: true,
  call: NOOP_CALL,
}

export const GET_MESSAGE_TOOL: ToolDefinition = {
  name: 'get_message',
  category: 'messaging' as const,
  description: '按消息 ID 查询单条消息详情。当历史消息中某条消息的内容不完整时（如只显示占位符），可用此工具查看完整内容。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: 'Channel 模块实例 ID' },
      session_id: { type: 'string', description: 'Session ID' },
      platform_message_id: { type: 'string', description: '要查询的消息 ID' },
    },
    required: ['channel_id', 'session_id', 'platform_message_id'],
  },
  isReadOnly: true,
  call: NOOP_CALL,
}

export const STORE_MEMORY_TOOL: ToolDefinition = {
  name: 'store_memory',
  category: 'memory' as const,
  description: '将信息写入长期记忆。当用户要求记住/记录某些信息时使用。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      content: { type: 'string', description: '要记忆的完整内容，应包含足够上下文' },
      importance: {
        type: 'number',
        description: '重要性（1-10），日常偏好 3-5，重要决策 6-8，关键信息 9-10',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '分类标签',
      },
    },
    required: ['content'],
  },
  isReadOnly: false,
  call: NOOP_CALL,
}

export const SEARCH_MEMORY_TOOL: ToolDefinition = {
  name: 'search_memory',
  category: 'memory' as const,
  description: '搜索记忆，返回摘要列表（L0 级别）。可按语义查询、按分类过滤。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: '自然语言搜索查询' },
      level: {
        type: 'string',
        enum: ['short_term', 'long_term'],
        description: '搜索范围：short_term=近期事件流水账, long_term=认知知识库（默认 long_term）',
      },
      limit: {
        type: 'number',
        description: '返回数量上限（1-20，默认 5）',
      },
    },
    required: ['query'],
  },
  isReadOnly: true,
  call: NOOP_CALL,
}

export const GET_MEMORY_DETAIL_TOOL: ToolDefinition = {
  name: 'get_memory_detail',
  category: 'memory' as const,
  description: '获取某条长期记忆的详细内容。先用 search_memory 找到记忆 ID，再用此工具查看详情。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      memory_id: { type: 'string', description: '记忆 ID（如 mem-l042）' },
      detail: {
        type: 'string',
        enum: ['L1', 'L2'],
        description: '详细程度：L1=概览(~2k token), L2=完整内容（默认 L1）',
      },
    },
    required: ['memory_id'],
  },
  isReadOnly: true,
  call: NOOP_CALL,
}

/** All Front tools in order */
export function getAllFrontTools(allowSilent: boolean, activeTaskIds: readonly string[]): ToolDefinition[] {
  return [
    // Decision tools
    REPLY_TOOL,
    CREATE_TASK_TOOL,
    ...(activeTaskIds.length > 0 ? [supplementTaskTool(activeTaskIds)] : []),
    ...(allowSilent ? [STAY_SILENT_TOOL] : []),
    // Info tools
    QUERY_TASKS_TOOL,
    CREATE_SCHEDULE_TOOL,
    LOOKUP_FRIEND_TOOL,
    LIST_CONTACTS_TOOL,
    LIST_GROUPS_TOOL,
    LIST_SESSIONS_TOOL,
    OPEN_PRIVATE_SESSION_TOOL,
    SEND_MESSAGE_TOOL,
    GET_HISTORY_TOOL,
    GET_MESSAGE_TOOL,
    STORE_MEMORY_TOOL,
    SEARCH_MEMORY_TOOL,
    GET_MEMORY_DETAIL_TOOL,
  ]
}
