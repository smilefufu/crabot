import { describe, it, expect, beforeEach } from 'vitest'
import { SessionManager } from '../../src/orchestration/session-manager.js'

describe('SessionManager', () => {
  let manager: SessionManager

  beforeEach(() => {
    manager = new SessionManager(300)
  })

  describe('getOrCreateSession', () => {
    it('should create a new session if not exists', () => {
      const session = manager.getOrCreateSession('session-1')
      expect(session.session_id).toBe('session-1')
      expect(session.pending_request_id).toBeUndefined()
      expect(session.message_count).toBe(0)
    })

    it('should return existing session', () => {
      const first = manager.getOrCreateSession('session-1')
      first.message_count = 5
      const second = manager.getOrCreateSession('session-1')
      expect(second.message_count).toBe(5)
    })
  })

  describe('pending request', () => {
    it('should set and get pending request', () => {
      manager.setPendingRequest('session-1', 'req-1')
      expect(manager.getPendingRequest('session-1')).toBe('req-1')
    })

    it('should clear pending request', () => {
      manager.setPendingRequest('session-1', 'req-1')
      manager.clearPendingRequest('session-1')
      expect(manager.getPendingRequest('session-1')).toBeUndefined()
    })

    it('should return undefined for non-existent session', () => {
      expect(manager.getPendingRequest('no-such')).toBeUndefined()
    })
  })

  describe('updateLastMessageTime', () => {
    it('should increment message count', () => {
      manager.updateLastMessageTime('session-1')
      manager.updateLastMessageTime('session-1')
      const session = manager.getSession('session-1')
      expect(session?.message_count).toBe(2)
    })
  })

  describe('cleanup', () => {
    it('should remove expired sessions', () => {
      const shortTtl = new SessionManager(1)
      const session = shortTtl.getOrCreateSession('session-1')
      // 手动将 last_message_time 设为过去
      session.last_message_time = Date.now() - 2000
      shortTtl.cleanup()
      expect(shortTtl.getSession('session-1')).toBeUndefined()
    })

    it('should keep active sessions', () => {
      manager.getOrCreateSession('session-1')
      manager.cleanup()
      expect(manager.getSession('session-1')).toBeDefined()
    })
  })

  describe('counts', () => {
    it('should count active sessions', () => {
      manager.getOrCreateSession('s1')
      manager.getOrCreateSession('s2')
      expect(manager.getActiveSessionCount()).toBe(2)
    })

    it('should count pending sessions', () => {
      manager.getOrCreateSession('s1')
      manager.setPendingRequest('s2', 'req-1')
      expect(manager.getPendingSessionCount()).toBe(1)
    })
  })
})