import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SwitchMapHandler } from '../../src/orchestration/switchmap-handler.js'
import { SessionManager } from '../../src/orchestration/session-manager.js'

function createMockRpcClient() {
  return {
    call: vi.fn().mockResolvedValue({}),
    resolve: vi.fn().mockResolvedValue([]),
    publishEvent: vi.fn().mockResolvedValue(0),
    registerModuleDefinition: vi.fn().mockResolvedValue({}),
    startModule: vi.fn().mockResolvedValue({}),
  }
}

describe('SwitchMapHandler', () => {
  let sessionManager: SessionManager
  let handler: SwitchMapHandler
  let mockRpc: ReturnType<typeof createMockRpcClient>

  beforeEach(() => {
    sessionManager = new SessionManager(300)
    mockRpc = createMockRpcClient()
    handler = new SwitchMapHandler(
      sessionManager,
      mockRpc as any,
      'flow-default',
      () => 19100
    )
  })

  it('should set pending request for new session', async () => {
    await handler.handleNewMessage('session-1', 'req-1')
    expect(sessionManager.getPendingRequest('session-1')).toBe('req-1')
  })

  it('should cancel old request when new message arrives', async () => {
    sessionManager.setPendingRequest('session-1', 'req-old')

    await handler.handleNewMessage('session-1', 'req-new')

    expect(mockRpc.call).toHaveBeenCalledWith(
      19100,
      'cancel_task',
      { task_id: 'req-old' },
      'flow-default'
    )
    expect(sessionManager.getPendingRequest('session-1')).toBe('req-new')
  })

  it('should not cancel if no pending request', async () => {
    await handler.handleNewMessage('session-1', 'req-1')
    expect(mockRpc.call).not.toHaveBeenCalled()
  })

  it('should handle cancel failure gracefully', async () => {
    mockRpc.call.mockRejectedValueOnce(new Error('network error'))
    sessionManager.setPendingRequest('session-1', 'req-old')

    await handler.handleNewMessage('session-1', 'req-new')
    expect(sessionManager.getPendingRequest('session-1')).toBe('req-new')
  })

  describe('completeRequest', () => {
    it('should clear pending if request matches', () => {
      sessionManager.setPendingRequest('session-1', 'req-1')
      handler.completeRequest('session-1', 'req-1')
      expect(sessionManager.getPendingRequest('session-1')).toBeUndefined()
    })

    it('should not clear if request does not match', () => {
      sessionManager.setPendingRequest('session-1', 'req-2')
      handler.completeRequest('session-1', 'req-1')
      expect(sessionManager.getPendingRequest('session-1')).toBe('req-2')
    })
  })
})