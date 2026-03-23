import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkerHandler } from '../../src/agent/worker-handler.js'
import { LlmClient } from '../../src/agent/llm-client.js'
import { ToolRegistry } from '../../src/agent/tool-registry.js'
import type {
  ExecuteTaskParams,
  WorkerAgentContext
} from '../../src/types.js'

vi.mock('../../src/agent/llm-client.js')

describe('WorkerHandler', () => {
  let mockLlm: LlmClient
  let mockToolRegistry: ToolRegistry
  let mockChat: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockChat = vi.fn()
    mockLlm = {
      chat: mockChat
    } as unknown as LlmClient

    mockToolRegistry = {
      toAnthropicTools: vi.fn().mockReturnValue([]),
      executeTool: vi.fn().mockResolvedValue({ success: true })
    } as unknown as ToolRegistry
  })

  describe('executeTask', () => {
    it('应该成功执行任务', async () => {
      const mockResponse = {
        content: [
          {
            type: 'text',
            text: 'Task completed successfully. The bug has been fixed.'
          }
        ],
        stop_reason: 'end_turn'
      }

      mockChat.mockResolvedValue(mockResponse)

      const handler = new WorkerHandler(mockLlm, mockToolRegistry)

      const task = {
        task_id: 'task_1',
        task_title: 'Fix login bug',
        task_description: 'Fix the authentication issue in login flow',
        task_type: 'user_request',
        priority: 'high'
      }

      const context: WorkerAgentContext = {
        admin_endpoint: { module_id: 'admin_1', port: 3001 },
        memory_endpoint: { module_id: 'memory_1', port: 3002 },
        channel_endpoints: [{ module_id: 'channel_1', port: 3003 }],
        short_term_memories: [],
        long_term_memories: [],
        available_tools: []
      }

      const params: ExecuteTaskParams = { task, context }

      const result = await handler.executeTask(params)

      expect(result.task_id).toBe('task_1')
      expect(result.outcome).toBe('completed')
      expect(result.summary).toContain('Task completed successfully')
    })

    it('应该处理执行失败', async () => {
      mockChat.mockRejectedValue(new Error('API error'))

      const handler = new WorkerHandler(mockLlm, mockToolRegistry)

      const task = {
        task_id: 'task_1',
        task_title: 'Test task',
        task_description: 'Test',
        task_type: 'user_request',
        priority: 'low'
      }

      const context: WorkerAgentContext = {
        admin_endpoint: { module_id: 'admin_1', port: 3001 },
        memory_endpoint: { module_id: 'memory_1', port: 3002 },
        channel_endpoints: [],
        short_term_memories: [],
        long_term_memories: [],
        available_tools: []
      }

      const result = await handler.executeTask({ task, context })

      expect(result.task_id).toBe('task_1')
      expect(result.outcome).toBe('failed')
      expect(result.summary).toContain('执行失败')
    })

    it('应该使用配置的 max_iterations', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'Done' }],
        stop_reason: 'end_turn'
      }

      mockChat.mockResolvedValue(mockResponse)

      const handler = new WorkerHandler(mockLlm, mockToolRegistry, { maxIterations: 10 })

      const task = {
        task_id: 'task_1',
        task_title: 'Test',
        task_description: 'Test',
        task_type: 'user_request',
        priority: 'low'
      }

      const context: WorkerAgentContext = {
        admin_endpoint: { module_id: 'admin_1', port: 3001 },
        memory_endpoint: { module_id: 'memory_1', port: 3002 },
        channel_endpoints: [],
        short_term_memories: [],
        long_term_memories: [],
        available_tools: []
      }

      await handler.executeTask({ task, context })

      expect(mockChat).toHaveBeenCalled()
    })
  })

  describe('deliverHumanResponse', () => {
    it('应该投递消息到进行中的任务', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'Processing...' }],
        stop_reason: 'end_turn'
      }

      mockChat.mockImplementation(
        () =>
          new Promise(resolve => {
            setTimeout(() => resolve(mockResponse), 100)
          })
      )

      const handler = new WorkerHandler(mockLlm, mockToolRegistry)

      const task = {
        task_id: 'task_1',
        task_title: 'Test',
        task_description: 'Test',
        task_type: 'user_request',
        priority: 'low'
      }

      const context: WorkerAgentContext = {
        admin_endpoint: { module_id: 'admin_1', port: 3001 },
        memory_endpoint: { module_id: 'memory_1', port: 3002 },
        channel_endpoints: [],
        short_term_memories: [],
        long_term_memories: [],
        available_tools: []
      }

      // 启动任务执行（不等待）
      const promise = handler.executeTask({ task, context })

      // 等待一小段时间确保任务开始
      await new Promise(resolve => setTimeout(resolve, 10))

      // 投递人类响应
      expect(() => {
        handler.deliverHumanResponse('task_1', [
          {
            platform_message_id: 'msg_human',
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
            content: { type: 'text', text: 'Here is more info' },
            features: { is_mention_crab: false },
            platform_timestamp: '2024-01-01T00:01:00Z'
          }
        ])
      }).not.toThrow()

      await promise
    })

    it('应该抛出错误如果任务不存在', () => {
      const handler = new WorkerHandler(mockLlm, mockToolRegistry)

      expect(() =>
        handler.deliverHumanResponse('nonexistent_task', [])
      ).toThrow('Task not found')
    })
  })

  describe('cancelTask', () => {
    it('应该能够取消任务', () => {
      // 取消 API 存在且不会抛出错误
      const handler = new WorkerHandler(mockLlm, mockToolRegistry)
      expect(typeof handler.cancelTask).toBe('function')

      // 取消不存在的任务不应该抛出错误
      expect(() => handler.cancelTask('nonexistent_task', 'Test')).not.toThrow()
    })

    it('取消后活跃任务数应该减少', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'Working...' }],
        stop_reason: 'end_turn'
      }

      // 使用较长的延迟模拟执行中的任务
      mockChat.mockImplementation(
        () =>
          new Promise(resolve => {
            setTimeout(() => resolve(mockResponse), 500)
          })
      )

      const handler = new WorkerHandler(mockLlm, mockToolRegistry)

      const task = {
        task_id: 'task_1',
        task_title: 'Test',
        task_description: 'Test',
        task_type: 'user_request',
        priority: 'low'
      }

      const context: WorkerAgentContext = {
        admin_endpoint: { module_id: 'admin_1', port: 3001 },
        memory_endpoint: { module_id: 'memory_1', port: 3002 },
        channel_endpoints: [],
        short_term_memories: [],
        long_term_memories: [],
        available_tools: []
      }

      // 启动任务
      const promise = handler.executeTask({ task, context })

      // 等待任务开始
      await new Promise(resolve => setTimeout(resolve, 10))

      // 验证有一个活跃任务
      expect(handler.getActiveTaskCount()).toBe(1)

      // 取消任务
      handler.cancelTask('task_1', 'User requested')

      // 等待任务完成
      await promise

      // 任务完成后活跃任务数应为 0
      expect(handler.getActiveTaskCount()).toBe(0)
    })

    it('应该静默处理不存在的任务', () => {
      const handler = new WorkerHandler(mockLlm, mockToolRegistry)

      // 取消不存在的任务不应该抛出错误
      expect(() => handler.cancelTask('nonexistent_task', 'Test')).not.toThrow()
    })
  })

  describe('getActiveTaskCount', () => {
    it('应该返回活跃任务数', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'Working...' }],
        stop_reason: 'end_turn'
      }

      mockChat.mockImplementation(
        () =>
          new Promise(resolve => {
            setTimeout(() => resolve(mockResponse), 100)
          })
      )

      const handler = new WorkerHandler(mockLlm, mockToolRegistry)

      const task = {
        task_id: 'task_1',
        task_title: 'Test',
        task_description: 'Test',
        task_type: 'user_request',
        priority: 'low'
      }

      const context: WorkerAgentContext = {
        admin_endpoint: { module_id: 'admin_1', port: 3001 },
        memory_endpoint: { module_id: 'memory_1', port: 3002 },
        channel_endpoints: [],
        short_term_memories: [],
        long_term_memories: [],
        available_tools: []
      }

      // 启动任务（不等待）
      const promise = handler.executeTask({ task, context })

      // 等待一小段时间确保任务开始
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(handler.getActiveTaskCount()).toBe(1)

      await promise

      // 任务完成后应该为 0
      expect(handler.getActiveTaskCount()).toBe(0)
    })
  })
})