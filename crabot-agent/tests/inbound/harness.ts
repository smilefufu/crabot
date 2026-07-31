/**
 * 入站链路测试网的共享装配（P7 / PR A）。
 *
 * 计划：`crabot-docs/superpowers/plans/2026-07-31-mw-p7-a-inbound-test-net.md`
 *
 * 这里只放**纯 fixture 与环境装配**：消息 / friend / 事件 payload 的构造，
 * `UnifiedAgentConfig` 的组装，以及 tmp `DATA_DIR` 的开关。
 * 各个测试文件自己决定要覆盖哪些实例字段——那部分是每个被测函数的语义边界，不共享。
 */
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type {
  ChannelMessage,
  Friend,
  LLMConnectionInfo,
  ModuleId,
  OrchestrationConfig,
  UnifiedAgentConfig,
} from '../../src/types.js'
import type { Event } from 'crabot-shared'

export const ORCHESTRATION: OrchestrationConfig = {
  front_context_recent_messages_window_hours: 24,
  front_context_recent_messages_max_cap: 50,
  front_context_short_term_memory_window_hours: 24,
  front_context_short_term_memory_max_cap: 20,
  worker_recent_messages_window_hours: 24,
  worker_recent_messages_max_cap: 50,
  worker_short_term_memory_window_hours: 24,
  worker_long_term_memory_limit: 10,
  worker_short_term_memory_max_cap: 20,
  front_agent_timeout: 60,
  session_state_ttl: 3600,
  worker_config_refresh_interval: 300,
  front_agent_queue_max_length: 10,
  front_agent_queue_timeout: 60,
}

export const CONFIGURED_MODELS: Record<string, LLMConnectionInfo> = {
  powerful: { endpoint: 'https://example.invalid', apikey: 'k', model_id: 'm-x', format: 'anthropic' },
}

export function makeFriend(id: string, overrides: Partial<Friend> = {}): Friend {
  return {
    id,
    display_name: `好友 ${id}`,
    permission: 'normal',
    channel_identities: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function makeMessage(p: {
  id: string
  channelId?: string
  sessionId?: string
  type: 'private' | 'group'
  text?: string
  mention?: boolean
  /** 发言人（不传则统一 u-1 / 张三） */
  senderId?: string
  senderName?: string
  friendId?: string
  /** features.reply_to_message_id：引用预取用 */
  replyTo?: string
  timestamp?: string
}): ChannelMessage {
  return {
    platform_message_id: p.id,
    session: {
      session_id: (p.sessionId ?? 'sess-1') as string,
      channel_id: (p.channelId ?? 'wechat') as ModuleId,
      type: p.type,
    },
    sender: {
      friend_id: p.friendId ?? 'f-1',
      platform_user_id: p.senderId ?? 'u-1',
      platform_display_name: p.senderName ?? '张三',
    },
    content: { type: 'text', text: p.text ?? '你好' },
    features: {
      is_mention_crab: p.mention ?? false,
      ...(p.replyTo ? { reply_to_message_id: p.replyTo } : {}),
    },
    platform_timestamp: p.timestamp ?? '2026-07-31T00:00:00.000Z',
  }
}

/** 与 `crabot-admin/src/index.ts:4114-4130` 的 payload 逐字段对齐。 */
export function authorizedEvent(payload: {
  message: ChannelMessage
  friend: Friend
  crab_display_name?: string
  crab_self_handle?: string
}): Event {
  return {
    id: 'evt-1',
    type: 'channel.message_authorized',
    source: 'admin' as ModuleId,
    payload: { channel_id: payload.message.session.channel_id, ...payload },
    timestamp: '2026-07-31T00:00:00.000Z',
  }
}

/**
 * 真实构造函数用的配置。`roles: []` → 不建 AgentHandler、不起 LSP 子进程；
 * 需要 handler 的测试自己往实例上塞桩。
 */
export function makeAgentConfig(opts: {
  configured: boolean
  moduleId: string
  port: number
  attentionMinMs?: number
  attentionMaxMs?: number
}): UnifiedAgentConfig {
  const attentionExtra = {
    ...(opts.attentionMinMs !== undefined ? { group_attention_min_ms: opts.attentionMinMs } : {}),
    ...(opts.attentionMaxMs !== undefined ? { group_attention_max_ms: opts.attentionMaxMs } : {}),
  }
  return {
    module_id: opts.moduleId as ModuleId,
    module_type: 'agent',
    version: '0.0.0-test',
    protocol_version: '1.0',
    port: opts.port,
    orchestration: ORCHESTRATION,
    agent_config: {
      instance_id: opts.moduleId,
      roles: [],
      system_prompt: '你是测试用 Crabot',
      model_config: opts.configured ? CONFIGURED_MODELS : {},
    },
    ...(Object.keys(attentionExtra).length > 0 ? { extra: attentionExtra } : {}),
  }
}

export interface DataDirGuard {
  root: string
  restore(): Promise<void>
}

/**
 * 把 `DATA_DIR` 指向一个 tmp 目录（TraceStore / manager 栈构造时会建目录），
 * 返回的 `restore()` 负责还原环境变量并删目录。
 */
export async function useTmpDataDir(prefix: string): Promise<DataDirGuard> {
  const root = await fs.mkdtemp(join(tmpdir(), prefix))
  const prevDataDir = process.env.DATA_DIR
  const prevAgentDataDir = process.env.CRABOT_AGENT_DATA_DIR
  delete process.env.CRABOT_AGENT_DATA_DIR
  process.env.DATA_DIR = join(root, 'data')
  return {
    root,
    async restore() {
      if (prevDataDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = prevDataDir
      if (prevAgentDataDir === undefined) delete process.env.CRABOT_AGENT_DATA_DIR
      else process.env.CRABOT_AGENT_DATA_DIR = prevAgentDataDir
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
