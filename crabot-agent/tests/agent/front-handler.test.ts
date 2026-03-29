import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FrontHandler } from '../../src/agent/front-handler.js'
import type { HandleMessageParams, FrontAgentContext, ChannelMessage } from '../../src/types.js'

// Mock runFrontLoop so we control decision output without a real LLM
vi.mock('../../src/agent/front-loop.js', () => ({
  runFrontLoop: vi.fn(),
}))

// Mock LLMClient constructor (FrontHandler creates one internally)
vi.mock('../../src/agent/llm-client.js', () => ({
  LLMClient: vi.fn().mockImplementation(() => ({})),
}))

// Mock ToolExecutor constructor
vi.mock('../../src/agent/tool-executor.js', () => ({
  ToolExecutor: vi.fn().mockImplementation(() => ({})),
}))

import { runFrontLoop } from '../../src/agent/front-loop.js'

const mockRunFrontLoop = vi.mocked(runFrontLoop)

function makeFrontHandler() {
  const llmConfig = { endpoint: 'http://localhost:4000', apikey: 'test', model: 'test-model' }
  const toolDeps = {
    rpcClient: {} as any,
    moduleId: 'test',
    getAdminPort: async () => 3001,
    resolveChannelPort: async () => 3003,
    getActiveTasks: () => [],
  }
  const config = { systemPrompt: 'You are helpful' }
  return new FrontHandler(llmConfig, toolDeps, config)
}

function makeMessages(): ChannelMessage[] {
  return [
    {
      platform_message_id: 'msg_1',
      session: { session_id: 'session-1', channel_id: 'ch_1', type: 'private' },
      sender: { friend_id: 'friend_1', platform_user_id: 'user_1', platform_display_name: 'Test User' },
      content: { type: 'text', text: 'Hi' },
      features: { is_mention_crab: false },
      platform_timestamp: '2024-01-01T00:00:00Z',
    },
  ]
}

function makeContext(): FrontAgentContext {
  return {
    sender_friend: {
      id: 'friend-1',
      display_name: 'Test User',
      permission: 'master',
      channel_identities: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    recent_messages: [],
    short_term_memories: [],
    active_tasks: [],
    available_tools: [],
  }
}

describe('FrontHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('handleMessage', () => {
    it('应该解析 direct_reply 决策', async () => {
      mockRunFrontLoop.mockResolvedValue({
        decision: { type: 'direct_reply', reply: { type: 'text', text: 'Hello!' } },
      })

      const handler = makeFrontHandler()
      const params: HandleMessageParams = { messages: makeMessages(), context: makeContext() }
      const result = await handler.handleMessage(params)

      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0].type).toBe('direct_reply')
    })

    it('应该解析 create_task 决策', async () => {
      mockRunFrontLoop.mockResolvedValue({
        decision: {
          type: 'create_task',
          task_title: 'Fix bug',
          task_description: 'Fix the login bug',
          task_type: 'user_request',
          immediate_reply: { type: 'text', text: '好的，我来处理' },
        },
      })

      const messages: ChannelMessage[] = [{
        platform_message_id: 'msg_1',
        session: { session_id: 'session-1', channel_id: 'ch_1', type: 'private' },
        sender: { friend_id: 'friend_1', platform_user_id: 'user_1', platform_display_name: 'Test User' },
        content: { type: 'text', text: 'Please fix the login bug' },
        features: { is_mention_crab: false },
        platform_timestamp: '2024-01-01T00:00:00Z',
      }]

      const handler = makeFrontHandler()
      const result = await handler.handleMessage({ messages, context: makeContext() })

      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0].type).toBe('create_task')
      if (result.decisions[0].type === 'create_task') {
        expect(result.decisions[0].task_title).toBe('Fix bug')
      }
    })

    it('应该在 runFrontLoop 成功时正常返回决策', async () => {
      mockRunFrontLoop.mockResolvedValue({
        decision: { type: 'direct_reply', reply: { type: 'text', text: 'plain response' } },
      })

      const handler = makeFrontHandler()
      const result = await handler.handleMessage({ messages: makeMessages(), context: makeContext() })

      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0].type).toBe('direct_reply')
    })

    it('应该调用 runFrontLoop', async () => {
      mockRunFrontLoop.mockResolvedValue({
        decision: { type: 'direct_reply', reply: { type: 'text', text: 'OK' } },
      })

      const handler = makeFrontHandler()
      await handler.handleMessage({ messages: makeMessages(), context: makeContext() })

      expect(mockRunFrontLoop).toHaveBeenCalled()
    })

    it('应该处理错误并返回错误消息（私聊）', async () => {
      mockRunFrontLoop.mockRejectedValue(new Error('API error'))

      const handler = makeFrontHandler()
      const result = await handler.handleMessage({ messages: makeMessages(), context: makeContext() })

      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0].type).toBe('direct_reply')
      if (result.decisions[0].type === 'direct_reply') {
        expect(result.decisions[0].reply.text).toContain('异常')
      }
    })
  })
})