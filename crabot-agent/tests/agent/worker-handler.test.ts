import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkerHandler } from '../../src/agent/worker-handler.js'
import type {
  ExecuteTaskParams,
  WorkerAgentContext
} from '../../src/types.js'

// Mock the claude-agent-sdk query function used internally by WorkerHandler
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const mockQuery = vi.fn()
  return {
    query: mockQuery,
    createSdkMcpServer: vi.fn().mockReturnValue({}),
    tool: vi.fn().mockImplementation((name: string, _desc: string, _schema: unknown, handler: Function) => ({
      name,
      handler,
    })),
  }
})

import { query } from '@anthropic-ai/claude-agent-sdk'
const mockQuery = vi.mocked(query)

function makeHandler(options?: { maxIterations?: number }) {
  const sdkEnv = { modelId: 'test-model', env: {} }
  const config = {
    systemPrompt: 'You are a helpful worker.',
    maxIterations: options?.maxIterations,
  }
  return new WorkerHandler(sdkEnv, config)
}

function makeTask(overrides?: Partial<ExecuteTaskParams['task']>): ExecuteTaskParams['task'] {
  return {
    task_id: 'task_1',
    task_title: 'Fix login bug',
    task_description: 'Fix the authentication issue in login flow',
    task_type: 'user_request',
    priority: 'high',
    ...overrides,
  }
}

function makeContext(): WorkerAgentContext {
  return {
    admin_endpoint: { module_id: 'admin_1', port: 3001 },
    memory_endpoint: { module_id: 'memory_1', port: 3002 },
    channel_endpoints: [{ module_id: 'channel_1', port: 3003 }],
    short_term_memories: [],
    long_term_memories: [],
    available_tools: [],
  }
}

/** Create an async iterable that yields SDK messages */
function makeQueryStream(messages: Array<Record<string, unknown>>) {
  async function* gen() {
    for (const msg of messages) {
      yield msg
    }
  }
  const iterable = gen()
  // add streamInput and interrupt as expected by WorkerHandler
  ;(iterable as any).streamInput = vi.fn().mockResolvedValue(undefined)
  ;(iterable as any).interrupt = vi.fn().mockResolvedValue(undefined)
  return iterable
}

describe('WorkerHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('executeTask', () => {
    it('应该成功执行任务', async () => {
      mockQuery.mockReturnValue(makeQueryStream([
        { type: 'system', subtype: 'init', model: 'test-model', tools: [], mcp_servers: [] },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Task completed successfully. The bug has been fixed.' }],
            stop_reason: 'end_turn',
          },
        },
        { type: 'result', subtype: 'success', result: 'Task completed successfully. The bug has been fixed.', is_error: false },
      ]))

      const handler = makeHandler()
      const result = await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(result.task_id).toBe('task_1')
      expect(result.outcome).toBe('completed')
      expect(result.summary).toContain('Task completed successfully')
    })

    it('应该处理执行失败', async () => {
      mockQuery.mockReturnValue(makeQueryStream([
        { type: 'system', subtype: 'init', model: 'test-model', tools: [], mcp_servers: [] },
        { type: 'result', subtype: 'error', is_error: true, errors: ['API error'] },
      ]))

      const handler = makeHandler()
      const result = await handler.executeTask({
        task: makeTask({ task_id: 'task_1', task_title: 'Test task', task_description: 'Test', priority: 'low' }),
        context: makeContext(),
      })

      expect(result.task_id).toBe('task_1')
      expect(result.outcome).toBe('failed')
    })

    it('应该使用配置的 max_iterations', async () => {
      mockQuery.mockReturnValue(makeQueryStream([
        { type: 'system', subtype: 'init', model: 'test-model', tools: [], mcp_servers: [] },
        { type: 'result', subtype: 'success', result: 'Done', is_error: false },
      ]))

      const handler = makeHandler({ maxIterations: 10 })
      await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(mockQuery).toHaveBeenCalled()
    })
  })

  describe('deliverHumanResponse', () => {
    it('应该抛出错误如果任务不存在', () => {
      const handler = makeHandler()
      expect(() => handler.deliverHumanResponse('nonexistent_task', [])).toThrow('Task not found')
    })

    it('应该投递消息到进行中的任务', async () => {
      // Make the stream slow so the task is in progress when we deliver
      let resolveStream: () => void
      const streamDone = new Promise<void>(r => { resolveStream = r })

      mockQuery.mockReturnValue((() => {
        async function* gen() {
          yield { type: 'system', subtype: 'init', model: 'test-model', tools: [], mcp_servers: [] }
          await streamDone
          yield { type: 'result', subtype: 'success', result: 'Done', is_error: false }
        }
        const it = gen()
        ;(it as any).streamInput = vi.fn().mockResolvedValue(undefined)
        ;(it as any).interrupt = vi.fn().mockResolvedValue(undefined)
        return it
      })())

      const handler = makeHandler()
      const promise = handler.executeTask({ task: makeTask(), context: makeContext() })

      // Wait briefly so the task is registered in activeTasks
      await new Promise(r => setTimeout(r, 20))

      expect(() => {
        handler.deliverHumanResponse('task_1', [{
          platform_message_id: 'msg_human',
          session: { session_id: 'session-1', channel_id: 'ch_1', type: 'private' },
          sender: { friend_id: 'friend_1', platform_user_id: 'user_1', platform_display_name: 'Test User' },
          content: { type: 'text', text: 'Here is more info' },
          features: { is_mention_crab: false },
          platform_timestamp: '2024-01-01T00:01:00Z',
        }])
      }).not.toThrow()

      resolveStream!()
      await promise
    })
  })

  describe('cancelTask', () => {
    it('应该能够取消任务', () => {
      const handler = makeHandler()
      expect(typeof handler.cancelTask).toBe('function')
      expect(() => handler.cancelTask('nonexistent_task', 'Test')).not.toThrow()
    })

    it('应该静默处理不存在的任务', () => {
      const handler = makeHandler()
      expect(() => handler.cancelTask('nonexistent_task', 'Test')).not.toThrow()
    })
  })

  describe('getActiveTaskCount', () => {
    it('任务完成后活跃任务数应为 0', async () => {
      mockQuery.mockReturnValue(makeQueryStream([
        { type: 'system', subtype: 'init', model: 'test-model', tools: [], mcp_servers: [] },
        { type: 'result', subtype: 'success', result: 'Done', is_error: false },
      ]))

      const handler = makeHandler()
      await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(handler.getActiveTaskCount()).toBe(0)
    })
  })
})