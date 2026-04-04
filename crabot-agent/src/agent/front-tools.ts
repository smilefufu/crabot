/**
 * Front Tools - Engine ToolDefinition format for Front Handler v2
 *
 * Includes: make_decision, query_tasks, create_schedule,
 * and crab-messaging tools (lookup_friend, list_contacts, list_groups, list_sessions,
 * open_private_session, send_message, get_history)
 *
 * NOTE: These tools are NOT executed by the engine — the front-loop handles
 * them manually. The `call` property is a no-op placeholder.
 */

import type { ToolDefinition } from '../engine/types.js'

const NOOP_CALL = async () => ({ output: '', isError: false as const })

export function makeDecisionTool(allowSilent: boolean): ToolDefinition {
  const types = allowSilent
    ? ['direct_reply', 'create_task', 'supplement_task', 'silent']
    : ['direct_reply', 'create_task', 'supplement_task']
  const desc = allowSilent
    ? 'direct_reply=直接回复, create_task=创建新任务, supplement_task=补充/纠偏已有任务, silent=静默'
    : 'direct_reply=直接回复, create_task=创建新任务, supplement_task=补充/纠偏已有任务'
  return {
    name: 'make_decision',
    description: '做出最终决策。分析完消息后必须调用此工具输出决策。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: types,
          description: desc,
        },
      reply_text: {
        type: 'string',
        description: '回复文本。direct_reply 时必填（作为回复内容）；create_task/supplement_task 时可选（作为即时回复，如"好的，正在处理"）',
      },
      task_title: { type: 'string', description: '任务标题（type=create_task 时必填）' },
      task_description: { type: 'string', description: '一句话分类标注，描述任务方向（type=create_task 时必填）。不要概括用户需求，原始消息会完整传给 Worker。例如："分析挂靠功能需求并规划实现方案"' },
      task_type: {
        type: 'string',
        enum: ['general', 'code', 'analysis', 'command'],
        description: '任务类型，默认 general',
      },
      task_id: {
        type: 'string',
        description: '目标任务 ID（type=supplement_task 时必填）',
      },
      supplement_content: {
        type: 'string',
        description: '提炼后的补充/纠偏内容（type=supplement_task 时必填）',
      },
    },
    required: ['type'],
  },
    isReadOnly: true,
    call: NOOP_CALL,
  }
}

export const QUERY_TASKS_TOOL: ToolDefinition = {
  name: 'query_tasks',
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

export const STORE_MEMORY_TOOL: ToolDefinition = {
  name: 'store_memory',
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
export function getAllFrontTools(allowSilent: boolean): ToolDefinition[] {
  return [
    makeDecisionTool(allowSilent),
    QUERY_TASKS_TOOL,
    CREATE_SCHEDULE_TOOL,
    LOOKUP_FRIEND_TOOL,
    LIST_CONTACTS_TOOL,
    LIST_GROUPS_TOOL,
    LIST_SESSIONS_TOOL,
    OPEN_PRIVATE_SESSION_TOOL,
    SEND_MESSAGE_TOOL,
    GET_HISTORY_TOOL,
    STORE_MEMORY_TOOL,
    SEARCH_MEMORY_TOOL,
    GET_MEMORY_DETAIL_TOOL,
  ]
}
