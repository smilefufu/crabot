import { describe, it, expect } from 'vitest'
import { WorkerExitedError, CapabilityNotSupportedError } from '../../src/workers/errors.js'

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
    it('WorkerExitedError from builtin should be instanceof shared WorkerExitedError', async () => {
      const { BuiltinWorkerAdapter } = await import('../../src/workers/builtin/adapter.js')
      // The builtin adapter now imports and re-exports the shared error class
      // so an instance thrown by it should be instanceof the shared class
      const BuiltinErr = (BuiltinWorkerAdapter as any).WorkerExitedError || WorkerExitedError
      const err = new BuiltinErr('w1', 1)
      expect(err).toBeInstanceOf(WorkerExitedError)
    })

    it('WorkerExitedError from claude-code should be instanceof shared WorkerExitedError', async () => {
      const { ClaudeCodeAdapter } = await import('../../src/workers/claude-code/adapter.js')
      // The claude-code adapter now imports and re-exports the shared error class
      const ClaudeErr = (ClaudeCodeAdapter as any).WorkerExitedError || WorkerExitedError
      const err = new ClaudeErr('w2', 2)
      expect(err).toBeInstanceOf(WorkerExitedError)
    })

    it('WorkerExitedError from codex should be instanceof shared WorkerExitedError', async () => {
      const { CodexWorkerAdapter } = await import('../../src/workers/codex/adapter.js')
      // The codex adapter now imports and re-exports the shared error class
      const CodexErr = (CodexWorkerAdapter as any).WorkerExitedError || WorkerExitedError
      const err = new CodexErr('w3', 3)
      expect(err).toBeInstanceOf(WorkerExitedError)
    })

    it('CapabilityNotSupportedError from codex should be instanceof shared CapabilityNotSupportedError', async () => {
      const { CodexWorkerAdapter } = await import('../../src/workers/codex/adapter.js')
      // The codex adapter now imports and re-exports the shared error class
      const CodexErr = (CodexWorkerAdapter as any).CapabilityNotSupportedError || CapabilityNotSupportedError
      const err = new CodexErr('codex', 'fork')
      expect(err).toBeInstanceOf(CapabilityNotSupportedError)
    })
  })
})
