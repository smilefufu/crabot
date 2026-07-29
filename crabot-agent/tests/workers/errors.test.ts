import { describe, it, expect } from 'vitest'
import { WorkerExitedError, CapabilityNotSupportedError } from '../../src/workers/errors.js'
import { WorkerExitedError as BuiltinExported } from '../../src/workers/builtin/adapter.js'
import { WorkerExitedError as ClaudeCodeExported } from '../../src/workers/claude-code/adapter.js'
import { WorkerExitedError as CodexExported, CapabilityNotSupportedError as CodexCapExported } from '../../src/workers/codex/adapter.js'

describe('Shared error types', () => {
  describe('WorkerExitedError', () => {
    it('should construct with worker_id and seq fields', () => {
      const err = new WorkerExitedError('worker-123', 5)
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(WorkerExitedError)
      expect(err.worker_id).toBe('worker-123')
      expect(err.seq).toBe(5)
    })

    it('should have correct message format', () => {
      const err = new WorkerExitedError('my-worker', 42)
      expect(err.message).toBe('worker my-worker#42 has exited')
    })

    it('should have correct name property', () => {
      const err = new WorkerExitedError('w', 1)
      expect(err.name).toBe('WorkerExitedError')
    })

    it('should be recognizable as Error subclass', () => {
      const err = new WorkerExitedError('test', 0)
      expect(err instanceof Error).toBe(true)
    })
  })

  describe('CapabilityNotSupportedError', () => {
    it('should construct with impl and capability fields', () => {
      const err = new CapabilityNotSupportedError('codex', 'fork')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(CapabilityNotSupportedError)
      expect(err.impl).toBe('codex')
      expect(err.capability).toBe('fork')
    })

    it('should have correct message format', () => {
      const err = new CapabilityNotSupportedError('my-impl', 'my-capability')
      expect(err.message).toBe('my-impl does not support my-capability')
    })

    it('should have correct name property', () => {
      const err = new CapabilityNotSupportedError('x', 'y')
      expect(err.name).toBe('CapabilityNotSupportedError')
    })

    it('should be recognizable as Error subclass', () => {
      const err = new CapabilityNotSupportedError('test', 'test')
      expect(err instanceof Error).toBe(true)
    })
  })

  describe('Cross-implementation instanceof checks', () => {
    it('WorkerExitedError from builtin is the same class reference as shared WorkerExitedError', () => {
      // The builtin adapter imports and re-exports the shared error class
      // Verify they are the same class reference
      expect(BuiltinExported).toBe(WorkerExitedError)
      // Verify instances created from the exported class work correctly
      const err = new BuiltinExported('w1', 1)
      expect(err).toBeInstanceOf(WorkerExitedError)
      expect(err.worker_id).toBe('w1')
      expect(err.seq).toBe(1)
    })

    it('WorkerExitedError from claude-code is the same class reference as shared WorkerExitedError', () => {
      // The claude-code adapter imports and re-exports the shared error class
      expect(ClaudeCodeExported).toBe(WorkerExitedError)
      // Verify instances created from the exported class work correctly
      const err = new ClaudeCodeExported('w2', 2)
      expect(err).toBeInstanceOf(WorkerExitedError)
      expect(err.worker_id).toBe('w2')
      expect(err.seq).toBe(2)
    })

    it('WorkerExitedError from codex is the same class reference as shared WorkerExitedError', () => {
      // The codex adapter imports and re-exports the shared error class
      expect(CodexExported).toBe(WorkerExitedError)
      // Verify instances created from the exported class work correctly
      const err = new CodexExported('w3', 3)
      expect(err).toBeInstanceOf(WorkerExitedError)
      expect(err.worker_id).toBe('w3')
      expect(err.seq).toBe(3)
    })

    it('CapabilityNotSupportedError from codex is the same class reference as shared CapabilityNotSupportedError', () => {
      // The codex adapter imports and re-exports the shared error class
      expect(CodexCapExported).toBe(CapabilityNotSupportedError)
      // Verify instances created from the exported class work correctly
      const err = new CodexCapExported('codex', 'fork')
      expect(err).toBeInstanceOf(CapabilityNotSupportedError)
      expect(err.impl).toBe('codex')
      expect(err.capability).toBe('fork')
    })
  })
})
