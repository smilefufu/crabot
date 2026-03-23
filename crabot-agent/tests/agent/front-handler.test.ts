import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FrontHandler } from '../../src/agent/front-handler.js'
import { LlmClient } from '../../src/agent/llm-client.js'
import type { HandleMessageParams, FrontAgentContext, ChannelMessage } from '../../src/types.js'

vi.mock('../../src/agent/llm-client.js')

describe('FrontHandler', () => {
  let mockLlm: LlmClient
  let mockChat: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockChat = vi.fn()
    mockLlm = {
      chat: mockChat
    } as unknown as LlmClient
  })

  describe('handleMessage', () => {
    it('应该解析 direct_reply 决策', async () => {
      // 第一次调用返回 tool_use，第二次返回 end_turn
      const toolUseResponse = {
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'make_decision',
            input: {
              decisions: [
                {
                  type: 'direct_reply',
                  reply: { type: 'text', text: 'Hello!' }
                }
              ]
            }
          }
        ],
        stop_reason: 'tool_use'
      }

      const endTurnResponse = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              decisions: [
                {
                  type: 'direct_reply',
                  reply: { type: 'text', text: 'Hello!' }
                }
              ]
            })
          }
        ],
        stop_reason: 'end_turn'
      }

      mockChat
        .mockResolvedValueOnce(toolUseResponse)
        .mockResolvedValueOnce(endTurnResponse)

      const handler = new FrontHandler(mockLlm)

      const friend = {
        id: 'friend-1',
        display_name: 'Test User',
        permission: 'master' as const,
        channel_identities: [],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z'
      }

      const context: FrontAgentContext = {
        sender_friend: friend,
        recent_messages: [],
        short_term_memories: [],
        active_tasks: [],
        available_tools: []
      }

      const messages: ChannelMessage[] = [
        {
          platform_message_id: 'msg_1',
          session: {
            session_id: 'session-1',
            channel_id: 'ch_1',
            type: 'private'
          },
          sender: {
            friend_id: 'friend_1',
            platform_user_id: 'user_1',
            platform_display_name: 'Test User'
          },
          content: { type: 'text', text: 'Hi' },
          features: { is_mention_crab: false },
          platform_timestamp: '2024-01-01T00:00:00Z'
        }
      ]

      const params: HandleMessageParams = { messages, context }

      const result = await handler.handleMessage(params)

      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0].type).toBe('direct_reply')
    })

    it('应该解析 create_task 决策', async () => {
      const toolUseResponse = {
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'make_decision',
            input: {
              decisions: [
                {
                  type: 'create_task',
                  task_title: 'Fix bug',
                  task_description: 'Fix the login bug',
                  task_type: 'user_request',
                  priority: 'high'
                }
              ]
            }
          }
        ],
        stop_reason: 'tool_use'
      }

      const endTurnResponse = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              decisions: [
                {
                  type: 'create_task',
                  task_title: 'Fix bug',
                  task_description: 'Fix the login bug',
                  task_type: 'user_request',
                  priority: 'high'
                }
              ]
            })
          }
        ],
        stop_reason: 'end_turn'
      }

      mockChat
        .mockResolvedValueOnce(toolUseResponse)
        .mockResolvedValueOnce(endTurnResponse)

      const handler = new FrontHandler(mockLlm)

      const friend = {
        id: 'friend-1',
        display_name: 'Test User',
        permission: 'master' as const,
        channel_identities: [],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z'
      }

      const context: FrontAgentContext = {
        sender_friend: friend,
        recent_messages: [],
        short_term_memories: [],
        active_tasks: [],
        available_tools: []
      }

      const messages: ChannelMessage[] = [
        {
          platform_message_id: 'msg_1',
          session: {
            session_id: 'session-1',
            channel_id: 'ch_1',
            type: 'private'
          },
          sender: {
            friend_id: 'friend_1',
            platform_user_id: 'user_1',
            platform_display_name: 'Test User'
          },
          content: { type: 'text', text: 'Please fix the login bug' },
          features: { is_mention_crab: false },
          platform_timestamp: '2024-01-01T00:00:00Z'
        }
      ]

      const params: HandleMessageParams = { messages, context }

      const result = await handler.handleMessage(params)

      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0].type).toBe('create_task')
      if (result.decisions[0].type === 'create_task') {
        expect(result.decisions[0].task_title).toBe('Fix bug')
      }
    })

    it('应该 fallback 为 direct_reply 如果解析失败', async () => {
      const mockResponse = {
        content: [
          {
            type: 'text',
            text: 'This is a plain response without decision tags'
          }
        ],
        stop_reason: 'end_turn'
      }

      mockChat.mockResolvedValue(mockResponse)

      const handler = new FrontHandler(mockLlm)

      const friend = {
        id: 'friend-1',
        display_name: 'Test User',
        permission: 'master' as const,
        channel_identities: [],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z'
      }

      const context: FrontAgentContext = {
        sender_friend: friend,
        recent_messages: [],
        short_term_memories: [],
        active_tasks: [],
        available_tools: []
      }

      const messages: ChannelMessage[] = [
        {
          platform_message_id: 'msg_1',
          session: {
            session_id: 'session-1',
            channel_id: 'ch_1',
            type: 'private'
          },
          sender: {
            friend_id: 'friend_1',
            platform_user_id: 'user_1',
            platform_display_name: 'Test User'
          },
          content: { type: 'text', text: 'Hi' },
          features: { is_mention_crab: false },
          platform_timestamp: '2024-01-01T00:00:00Z'
        }
      ]

      const params: HandleMessageParams = { messages, context }

      const result = await handler.handleMessage(params)

      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0].type).toBe('direct_reply')
    })

    it('应该使用配置的 max_iterations', async () => {
      const toolUseResponse = {
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'make_decision',
            input: {
              decisions: [{ type: 'direct_reply', reply: { type: 'text', text: 'OK' } }]
            }
          }
        ],
        stop_reason: 'tool_use'
      }

      const endTurnResponse = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ decisions: [{ type: 'direct_reply', reply: { type: 'text', text: 'OK' } }] })
          }
        ],
        stop_reason: 'end_turn'
      }

      mockChat
        .mockResolvedValueOnce(toolUseResponse)
        .mockResolvedValueOnce(endTurnResponse)

      const handler = new FrontHandler(mockLlm, { maxIterations: 5 })

      const friend = {
        id: 'friend-1',
        display_name: 'Test User',
        permission: 'master' as const,
        channel_identities: [],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z'
      }

      const context: FrontAgentContext = {
        sender_friend: friend,
        recent_messages: [],
        short_term_memories: [],
        active_tasks: [],
        available_tools: []
      }

      const messages: ChannelMessage[] = [
        {
          platform_message_id: 'msg_1',
          session: {
            session_id: 'session-1',
            channel_id: 'ch_1',
            type: 'private'
          },
          sender: {
            friend_id: 'friend_1',
            platform_user_id: 'user_1',
            platform_display_name: 'Test User'
          },
          content: { type: 'text', text: 'Hi' },
          features: { is_mention_crab: false },
          platform_timestamp: '2024-01-01T00:00:00Z'
        }
      ]

      await handler.handleMessage({ messages, context })

      expect(mockChat).toHaveBeenCalled()
    })

    it('应该处理错误并返回错误消息', async () => {
      mockChat.mockRejectedValue(new Error('API error'))

      const handler = new FrontHandler(mockLlm)

      const friend = {
        id: 'friend-1',
        display_name: 'Test User',
        permission: 'master' as const,
        channel_identities: [],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z'
      }

      const context: FrontAgentContext = {
        sender_friend: friend,
        recent_messages: [],
        short_term_memories: [],
        active_tasks: [],
        available_tools: []
      }

      const messages: ChannelMessage[] = [
        {
          platform_message_id: 'msg_1',
          session: {
            session_id: 'session-1',
            channel_id: 'ch_1',
            type: 'private'
          },
          sender: {
            friend_id: 'friend_1',
            platform_user_id: 'user_1',
            platform_display_name: 'Test User'
          },
          content: { type: 'text', text: 'Hi' },
          features: { is_mention_crab: false },
          platform_timestamp: '2024-01-01T00:00:00Z'
        }
      ]

      const result = await handler.handleMessage({ messages, context })

      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0].type).toBe('direct_reply')
      if (result.decisions[0].type === 'direct_reply') {
        expect(result.decisions[0].reply.text).toContain('错误')
      }
    })
  })
})