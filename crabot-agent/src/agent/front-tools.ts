/**
 * Front Tools - Anthropic-format tool definitions for Front Handler v2
 *
 * Includes: make_decision, query_tasks, create_schedule,
 * and crab-messaging tools (lookup_friend, list_friends, list_sessions,
 * open_private_session, send_message, get_history)
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages'

export const MAKE_DECISION_TOOL: Tool = {
  name: 'make_decision',
  description: '做出最终决策。分析完消息后必须调用此工具输出决策。',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['direct_reply', 'create_task', 'supplement_task', 'silent'],
        description: 'direct_reply=直接回复, create_task=创建新任务, supplement_task=补充/纠偏已有任务, silent=静默',
      },
      reply_text: {
        type: 'string',
        description: '回复文本（type=direct_reply 时必填）',
      },
      task_title: { type: 'string', description: '任务标题（type=create_task 时必填）' },
      task_description: { type: 'string', description: '任务详细描述（type=create_task 时必填）' },
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
      confidence: {
        type: 'string',
        enum: ['high', 'low'],
        description: 'high=确定是纠偏直接注入, low=不确定需用户确认',
      },
      immediate_reply_text: {
        type: 'string',
        description: '即时回复文本（create_task/supplement_task 时可选）',
      },
    },
    required: ['type'],
  },
}

export const QUERY_TASKS_TOOL: Tool = {
  name: 'query_tasks',
  description: '查询当前活跃的任务列表和状态。用于回答用户关于任务进度的提问。',
  input_schema: {
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
}

export const CREATE_SCHEDULE_TOOL: Tool = {
  name: 'create_schedule',
  description: '创建定时任务或提醒。支持一次性和周期性。',
  input_schema: {
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
}

export const LOOKUP_FRIEND_TOOL: Tool = {
  name: 'lookup_friend',
  description: '搜索熟人信息，包括该熟人在哪些 Channel 上有身份。可按名称模糊搜索或按 friend_id 精确查找。',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: '按名称模糊搜索' },
      friend_id: { type: 'string', description: '按 friend_id 精确查找' },
    },
    required: [],
  },
}

export const LIST_FRIENDS_TOOL: Tool = {
  name: 'list_friends',
  description: '列出所有好友，支持分页、搜索和权限过滤。',
  input_schema: {
    type: 'object' as const,
    properties: {
      page: { type: 'number', description: '页码，默认 1' },
      page_size: { type: 'number', description: '每页条数，默认 20' },
      search: { type: 'string', description: '按名称模糊搜索' },
      permission: { type: 'string', enum: ['master', 'normal'], description: '按权限过滤' },
    },
    required: [],
  },
}

export const LIST_SESSIONS_TOOL: Tool = {
  name: 'list_sessions',
  description: '查看指定 Channel 上的会话列表。',
  input_schema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: 'Channel 模块实例 ID' },
      type: { type: 'string', enum: ['private', 'group'], description: '按类型过滤' },
    },
    required: ['channel_id'],
  },
}

export const OPEN_PRIVATE_SESSION_TOOL: Tool = {
  name: 'open_private_session',
  description: '在指定 Channel 上查找或创建与某个熟人的私聊 Session。',
  input_schema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: 'Channel 模块实例 ID' },
      friend_id: { type: 'string', description: '目标熟人 ID' },
    },
    required: ['channel_id', 'friend_id'],
  },
}

export const SEND_MESSAGE_TOOL: Tool = {
  name: 'send_message',
  description: '在指定 Channel 的指定 Session 中发送消息。',
  input_schema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: 'Channel 模块实例 ID' },
      session_id: { type: 'string', description: '目标 Session ID' },
      content: { type: 'string', description: '消息内容' },
      content_type: { type: 'string', enum: ['text', 'image', 'file'], description: '消息类型，默认 text' },
    },
    required: ['channel_id', 'session_id', 'content'],
  },
}

export const GET_HISTORY_TOOL: Tool = {
  name: 'get_history',
  description: '查看指定 Channel 上某个 Session 的历史消息。',
  input_schema: {
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
}

/** All Front tools in order */
export function getAllFrontTools(): Tool[] {
  return [
    MAKE_DECISION_TOOL,
    QUERY_TASKS_TOOL,
    CREATE_SCHEDULE_TOOL,
    LOOKUP_FRIEND_TOOL,
    LIST_FRIENDS_TOOL,
    LIST_SESSIONS_TOOL,
    OPEN_PRIVATE_SESSION_TOOL,
    SEND_MESSAGE_TOOL,
    GET_HISTORY_TOOL,
  ]
}
