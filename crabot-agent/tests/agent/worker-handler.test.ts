import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkerHandler } from '../../src/agent/worker-handler.js'
import type {
  ExecuteTaskParams,
  WorkerAgentContext,
  EngineResult,
} from '../../src/types.js'

// Mock the engine's runEngine function
vi.mock('../../src/engine/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    runEngine: vi.fn(),
  }
})

import { runEngine } from '../../src/engine/index.js'
const mockRunEngine = vi.mocked(runEngine)

function makeHandler() {
  const sdkEnv = {
    modelId: 'test-model',
    format: 'anthropic' as const,
    env: {
      ANTHROPIC_BASE_URL: 'http://localhost:4000',
      ANTHROPIC_API_KEY: 'test-key',
    },
  }
  const config = {
    systemPrompt: 'You are a helpful worker.',
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

function makeEngineResult(overrides?: Partial<{
  outcome: string
  finalText: string
  totalTurns: number
  error?: string
}>): { outcome: 'completed' | 'failed' | 'max_turns' | 'aborted'; finalText: string; totalTurns: number; usage: { inputTokens: number; outputTokens: number }; error?: string } {
  return {
    outcome: (overrides?.outcome ?? 'completed') as 'completed' | 'failed' | 'max_turns' | 'aborted',
    finalText: overrides?.finalText ?? 'Task completed successfully.',
    totalTurns: overrides?.totalTurns ?? 1,
    usage: { inputTokens: 100, outputTokens: 50 },
    ...(overrides?.error ? { error: overrides.error } : {}),
  }
}

describe('WorkerHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('executeTask', () => {
    it('should successfully execute a task', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult({
        finalText: 'Task completed successfully. The bug has been fixed.',
      }))

      const handler = makeHandler()
      const result = await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(result.task_id).toBe('task_1')
      expect(result.outcome).toBe('completed')
      expect(result.summary).toContain('Task completed successfully')
    })

    it('should handle execution failure', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult({
        outcome: 'failed',
        finalText: 'API error',
        error: 'API error',
      }))

      const handler = makeHandler()
      const result = await handler.executeTask({
        task: makeTask({ task_id: 'task_1' }),
        context: makeContext(),
      })

      expect(result.task_id).toBe('task_1')
      expect(result.outcome).toBe('failed')
    })

    it('should call runEngine with correct parameters', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const handler = makeHandler()
      await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(mockRunEngine).toHaveBeenCalledTimes(1)
      const callArgs = mockRunEngine.mock.calls[0][0]
      expect(callArgs.prompt).toContain('Fix login bug')
      expect(callArgs.options.model).toBe('test-model')
      expect(callArgs.options.systemPrompt).toContain('You are a helpful worker.')
    })

    it('should handle aborted result', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult({
        outcome: 'aborted',
        finalText: '',
      }))

      const handler = makeHandler()
      const result = await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(result.outcome).toBe('failed')
      expect(result.summary).toContain('取消')
    })

    it('should handle engine exception', async () => {
      mockRunEngine.mockRejectedValue(new Error('Connection failed'))

      const handler = makeHandler()
      const result = await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(result.outcome).toBe('failed')
      expect(result.summary).toContain('Connection failed')
    })
  })

  describe('deliverHumanResponse', () => {
    it('should throw error if task does not exist', () => {
      const handler = makeHandler()
      expect(() => handler.deliverHumanResponse('nonexistent_task', [])).toThrow('Task not found')
    })

    it('should deliver messages to an in-progress task', async () => {
      let resolveEngine: (value: ReturnType<typeof makeEngineResult>) => void
      mockRunEngine.mockReturnValue(
        new Promise(resolve => { resolveEngine = resolve }),
      )

      const handler = makeHandler()
      const promise = handler.executeTask({ task: makeTask(), context: makeContext() })

      // Wait briefly so the task is registered
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

      resolveEngine!(makeEngineResult())
      await promise
    })
  })

  describe('cancelTask', () => {
    it('should not throw for non-existent task', () => {
      const handler = makeHandler()
      expect(() => handler.cancelTask('nonexistent_task', 'Test')).not.toThrow()
    })
  })

  describe('getActiveTaskCount', () => {
    it('should be 0 after task completes', async () => {
      mockRunEngine.mockResolvedValue(makeEngineResult())

      const handler = makeHandler()
      await handler.executeTask({ task: makeTask(), context: makeContext() })

      expect(handler.getActiveTaskCount()).toBe(0)
    })
  })
})
