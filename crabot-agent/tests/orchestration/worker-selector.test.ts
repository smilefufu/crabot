import { describe, it, expect, beforeEach, vi } from 'vitest'
import { WorkerSelector } from '../../src/orchestration/worker-selector.js'

function createMockRpcClient() {
  return {
    call: vi.fn(),
    resolve: vi.fn(),
    publishEvent: vi.fn().mockResolvedValue(0),
    registerModuleDefinition: vi.fn().mockResolvedValue({}),
    startModule: vi.fn().mockResolvedValue({}),
  }
}

describe('WorkerSelector', () => {
  let selector: WorkerSelector
  let mockRpc: ReturnType<typeof createMockRpcClient>

  beforeEach(() => {
    mockRpc = createMockRpcClient()
    selector = new WorkerSelector(mockRpc as any, 'flow-default')
  })

  it('should select worker with highest capacity', async () => {
    mockRpc.resolve.mockResolvedValueOnce([
      { module_id: 'worker-1', port: 19401 },
      { module_id: 'worker-2', port: 19402 },
    ])
    mockRpc.call
      .mockResolvedValueOnce({ available_capacity: 2, specialization: 'general', supported_task_types: ['user_request'] })
      .mockResolvedValueOnce({ available_capacity: 5, specialization: 'general', supported_task_types: ['user_request'] })

    const workerId = await selector.selectWorker({})
    expect(workerId).toBe('worker-2')
  })

  it('should filter by task_type', async () => {
    mockRpc.resolve.mockResolvedValueOnce([
      { module_id: 'worker-1', port: 19401 },
      { module_id: 'worker-2', port: 19402 },
    ])
    mockRpc.call
      .mockResolvedValueOnce({ available_capacity: 5, specialization: 'general', supported_task_types: ['user_request'] })
      .mockResolvedValueOnce({ available_capacity: 3, specialization: 'code', supported_task_types: ['code_review'] })

    const workerId = await selector.selectWorker({ task_type: 'code_review' })
    expect(workerId).toBe('worker-2')
  })

  it('should prefer specialization hint', async () => {
    mockRpc.resolve.mockResolvedValueOnce([
      { module_id: 'worker-1', port: 19401 },
      { module_id: 'worker-2', port: 19402 },
    ])
    mockRpc.call
      .mockResolvedValueOnce({ available_capacity: 10, specialization: 'general', supported_task_types: ['user_request'] })
      .mockResolvedValueOnce({ available_capacity: 3, specialization: 'code', supported_task_types: ['user_request'] })

    const workerId = await selector.selectWorker({ specialization_hint: 'code' })
    expect(workerId).toBe('worker-2')
  })

  it('should throw if no workers available', async () => {
    mockRpc.resolve.mockResolvedValueOnce([
      { module_id: 'worker-1', port: 19401 },
    ])
    mockRpc.call.mockResolvedValueOnce({ available_capacity: 0, specialization: 'general', supported_task_types: ['user_request'] })

    await expect(selector.selectWorker({})).rejects.toThrow('No available workers')
  })

  it('should skip unreachable workers', async () => {
    mockRpc.resolve.mockResolvedValueOnce([
      { module_id: 'worker-1', port: 19401 },
      { module_id: 'worker-2', port: 19402 },
    ])
    mockRpc.call
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ available_capacity: 3, specialization: 'general', supported_task_types: ['user_request'] })

    const workerId = await selector.selectWorker({})
    expect(workerId).toBe('worker-2')
  })
})