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

/** Phase A (2026-04-25): user_attitude 字段 — reply / create_task 用 4 档完整版 */
const USER_ATTITUDE_FIELD_FULL = {
  type: 'string' as const,
  enum: ['strong_pass', 'pass', 'fail', 'strong_fail'] as const,
  description:
    '【可选】用户对【前一个已完成 task】的态度。指的是用户对那个 task 的反馈，' +
    '不是对你这次回复的自评。判断不出来就不填。',
}

/** Phase A (2026-04-25): user_attitude 字段 — supplement_task 仅负反馈版 */
const USER_ATTITUDE_FIELD_NEG_ONLY = {
  type: 'string' as const,
  enum: ['fail', 'strong_fail'] as const,
  description:
    '【可选】用户对【正在 supplement 的这个 current task】的否定程度。' +
    '用户在 supplement 时若是补充信息（不是纠偏）就不填字段。',
}

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
      user_attitude: USER_ATTITUDE_FIELD_FULL,
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
      ack_text: {
        type: 'string',
        description: '立即发给用户的确认文本。必须简短自然，让用户知道你已收到并开始处理，如"好的，我来对比一下这几个产品"、"收到，正在分析代码"。',
      },
      user_attitude: {
        ...USER_ATTITUDE_FIELD_FULL,
        description:
          '【可选】用户对【前一个已完成 task】的态度。' +
          '注意：不是对你正在创建的新 task 的评价（你无法预知一个还没开始的 task 的成败）。' +
          '判断不出来就不填。',
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
        user_attitude: USER_ATTITUDE_FIELD_NEG_ONLY,
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
  description: '创建定时任务或提醒。支持一次性（trigger_at）和周期性（cron）。创建后由系统在到达指定时间时自动执行，无需额外操作。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: '任务/提醒标题' },
      description: { type: 'string', description: '详细描述' },
      trigger_at: { type: 'string', description: '触发时间，必须是完整的 ISO 8601 格式含时区，如 "2026-04-15T16:45:00+08:00"。一次性提醒用此字段' },
      cron: { type: 'string', description: 'Cron 表达式（分 时 日 月 周），如 "0 9 * * *"。周期性任务用此字段' },
      action: {
        type: 'string',
        enum: ['send_reminder', 'create_task'],
        description: 'send_reminder=到时间后发送提醒消息给用户, create_task=到时间后创建后台任务执行',
      },
      target_channel_id: { type: 'string', description: '提醒发送到的 channel（send_reminder 时必填，使用当前 Channel ID）' },
      target_session_id: { type: 'string', description: '提醒发送到的 session（send_reminder 时必填，使用当前 Session ID）' },
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
  description: '将信息写入长期记忆 inbox。当用户要求记住/记录某些信息时使用。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      content: { type: 'string', description: '要记忆的完整内容，应包含足够上下文（成为 body）' },
      brief: { type: 'string', description: '召回标题（≤80 字符）。不传则自动从 content 首行截取' },
      type: {
        type: 'string',
        enum: ['fact', 'lesson', 'concept'],
        description: '记忆类型：fact=客观事实, lesson=经验教训, concept=概念定义（默认 fact）',
      },
      importance: {
        type: 'number',
        description: '重要性（1-10），日常偏好 3-5，重要决策 6-8，关键信息 9-10（用于推断 importance_factors）',
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
  description: '搜索记忆，返回 brief 列表。可按语义查询。',
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
      memory_id: { type: 'string', description: '记忆 ID' },
      include: {
        type: 'string',
        enum: ['brief', 'full'],
        description: '详细程度：brief=仅返回标识与 brief, full=附带 body 与 frontmatter（默认 full）',
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
