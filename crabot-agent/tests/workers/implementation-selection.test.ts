import { describe, it, expect } from 'vitest'
import { selectWorkerImplementation, WorkerNotReadyError, FIXED_FALLBACK_ORDER } from '../../src/workers/implementation-selection.js'
import type { WorkerImplementationConfig, WorkerImplementationStatus, WorkerImplId } from '../../src/workers/types.js'

function config(defaultImpl: WorkerImplId = 'builtin'): WorkerImplementationConfig {
  return {
    revision: 1,
    default_impl: defaultImpl,
    implementations: {
      builtin: { enabled: true },
      'claude-code': { enabled: true, connection: { mode: 'existing_host' } },
      codex: { enabled: true, connection: { mode: 'existing_host' } },
    },
  }
}

function status(impl: WorkerImplId, ready: boolean, detail?: string): WorkerImplementationStatus {
  return {
    impl, installed: ready, configured: true, policy_revision: 1,
    verification: 'never', ready,
    capabilities: { fork: false, revive: true, goalMode: false, subagent: false, structuredTrace: false },
    connection_capabilities: [], observed_at: '2026-08-16T00:00:00Z',
    ...(detail ? { detail } : {}),
  }
}

describe('selectWorkerImplementation（P6-C §2 固定选择语义）', () => {
  it('显式 ready → 用它自己', () => {
    const statuses = [status('builtin', true), status('claude-code', true), status('codex', false)]
    expect(selectWorkerImplementation({ requestedImpl: 'codex', config: config(), statuses: [status('builtin', true), status('claude-code', true), status('codex', true)] })).toBe('codex')
    expect(selectWorkerImplementation({ requestedImpl: 'claude-code', config: config(), statuses })).toBe('claude-code')
  })

  it('显式不可用 → 结构化错误，绝不 fallback；details 带 ready list/reasons', () => {
    const statuses = [status('builtin', true), status('claude-code', false, 'not installed'), status('codex', false, 'disabled by policy')]
    try {
      selectWorkerImplementation({ requestedImpl: 'claude-code', config: config(), statuses })
      expect.unreachable()
    } catch (error) {
      const err = error as WorkerNotReadyError
      expect(err.code).toBe('WORKER_IMPLEMENTATION_NOT_READY')
      expect(err.details.requested_impl).toBe('claude-code')
      expect(err.details.ready_impls).toEqual(['builtin'])
      expect(err.details.reasons['claude-code']).toBe('not installed')
    }
  })

  it('省略：ready default 优先；default 不 ready 按固定顺序', () => {
    const allReady = [status('builtin', true), status('claude-code', true), status('codex', true)]
    expect(selectWorkerImplementation({ config: config('claude-code'), statuses: allReady })).toBe('claude-code')
    // default=claude-code 不 ready → builtin 第一
    expect(selectWorkerImplementation({
      config: config('claude-code'),
      statuses: [status('builtin', true), status('claude-code', false), status('codex', true)],
    })).toBe('builtin')
    // builtin 也不 ready → codex
    expect(selectWorkerImplementation({
      config: config('builtin'),
      statuses: [status('builtin', false), status('claude-code', false), status('codex', true)],
    })).toBe('codex')
    expect(FIXED_FALLBACK_ORDER).toEqual(['builtin', 'claude-code', 'codex'])
  })

  it('excludedImpls 只用于 handoff 已用实现排除，不影响全局 ready', () => {
    const statuses = [status('builtin', true), status('claude-code', true)]
    expect(selectWorkerImplementation({
      config: config('builtin'), statuses, excludedImpls: new Set(['builtin']),
    })).toBe('claude-code')
    // 显式请求被排除的 impl → 同样拒绝
    expect(() => selectWorkerImplementation({
      requestedImpl: 'builtin', config: config('builtin'), statuses, excludedImpls: new Set(['builtin']),
    })).toThrow(/not ready/)
  })

  it('无 ready → WORKER_IMPLEMENTATION_NOT_READY（无 requested_impl）', () => {
    const statuses = [status('builtin', false), status('claude-code', false), status('codex', false)]
    try {
      selectWorkerImplementation({ config: config(), statuses })
      expect.unreachable()
    } catch (error) {
      const err = error as WorkerNotReadyError
      expect(err.code).toBe('WORKER_IMPLEMENTATION_NOT_READY')
      expect(err.details.requested_impl).toBeUndefined()
      expect(err.details.ready_impls).toEqual([])
    }
  })
})
