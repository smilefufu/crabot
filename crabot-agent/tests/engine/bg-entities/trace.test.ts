/**
 * Tests for bg-entity trace span emission (Plan 3 Task 20).
 *
 * Verifies that spawn / exit / output / kill paths emit the correct spans
 * when a traceContext is provided, and that they are gracefully no-ops when
 * traceContext is undefined.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnPersistentShell, TransientShellRegistry } from '../../../src/engine/bg-entities/bg-shell'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry'
import type { BgEntityTraceContext } from '../../../src/engine/bg-entities/trace'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Build a minimal mock TraceStore with vi.fn() spies for startSpan / endSpan. */
function makeMockTraceStore() {
  const spans: Array<{ span_id: string; type: string; details: Record<string, unknown> }> = []
  let spanCounter = 0

  const startSpan = vi.fn((_traceId: string, params: { type: string; details: Record<string, unknown> }) => {
    const span_id = `span-${++spanCounter}`
    spans.push({ span_id, type: params.type, details: params.details as Record<string, unknown> })
    return { span_id, trace_id: _traceId, ...params, started_at: new Date().toISOString(), status: 'running' }
  })

  const endSpan = vi.fn()

  return { startSpan, endSpan, spans }
}

function makeTraceCtx(store: ReturnType<typeof makeMockTraceStore>): BgEntityTraceContext {
  return {
    traceStore: store as unknown as BgEntityTraceContext['traceStore'],
    traceId: 'trace-test-001',
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string
let registry: BgEntityRegistry
const spawnedPids: number[] = []

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'bg-trace-test-'))
  process.env.DATA_DIR = tmpDir
  registry = new BgEntityRegistry()
})

afterEach(() => {
  for (const pid of spawnedPids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already dead */ }
  }
  spawnedPids.length = 0
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.DATA_DIR
})

// ---------------------------------------------------------------------------
// spawnPersistentShell with traceContext
// ---------------------------------------------------------------------------

describe('spawnPersistentShell with traceContext', () => {
  it('does not emit bg_entity_spawn span (deprecated emission)', async () => {
    const store = makeMockTraceStore()
    const traceContext = makeTraceCtx(store)

    const entityId = await spawnPersistentShell({
      command: 'sleep 10',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-1',
      registry,
      traceContext,
    })

    const rec = await registry.get(entityId)
    if (rec && rec.type === 'shell') spawnedPids.push(rec.pid)

    // spawn 不再 emit span；只有进程 exit 才 emit
    expect(store.startSpan).not.toHaveBeenCalled()
  })

  it('emits bg_entity_exit span when process exits cleanly', async () => {
    const store = makeMockTraceStore()
    const traceContext = makeTraceCtx(store)

    const entityId = await spawnPersistentShell({
      command: 'exit 0',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-2',
      registry,
      traceContext,
    })

    // Poll for exit.
    for (let i = 0; i < 20; i++) {
      await sleep(50)
      const rec = await registry.get(entityId)
      if (rec?.status !== 'running') break
    }

    // 仅 exit span（spawn 已废弃）
    expect(store.startSpan).toHaveBeenCalledOnce()
    const exitCall = store.startSpan.mock.calls[0]
    expect(exitCall[1].type).toBe('bg_entity_exit')
    const exitDetails = exitCall[1].details as Record<string, unknown>
    expect(exitDetails.entity_id).toBe(entityId)
    expect(exitDetails.type).toBe('shell')
    expect(exitDetails.exit_code).toBe(0)
    expect(exitDetails.status).toBe('completed')
    expect(typeof exitDetails.runtime_ms).toBe('number')
    expect(store.endSpan).toHaveBeenCalledOnce()
  })

  it('emits bg_entity_exit with failed status on non-zero exit', async () => {
    const store = makeMockTraceStore()
    const traceContext = makeTraceCtx(store)

    const entityId = await spawnPersistentShell({
      command: 'exit 7',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-3',
      registry,
      traceContext,
    })

    for (let i = 0; i < 20; i++) {
      await sleep(50)
      const rec = await registry.get(entityId)
      if (rec?.status !== 'running') break
    }

    expect(store.startSpan).toHaveBeenCalledOnce()
    const exitCall = store.startSpan.mock.calls[0]
    expect(exitCall[1].type).toBe('bg_entity_exit')
    const exitDetails = exitCall[1].details as Record<string, unknown>
    expect(exitDetails.exit_code).toBe(7)
    expect(exitDetails.status).toBe('failed')
  })

  it('does not throw and does not call traceStore when traceContext is undefined', async () => {
    const store = makeMockTraceStore()

    const entityId = await spawnPersistentShell({
      command: 'sleep 10',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-4',
      registry,
      // no traceContext
    })

    const rec = await registry.get(entityId)
    if (rec && rec.type === 'shell') spawnedPids.push(rec.pid)

    expect(entityId).toMatch(/^shell_[0-9a-f]{12}$/)
    expect(store.startSpan).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// TransientShellRegistry.spawn with traceContext
// ---------------------------------------------------------------------------

describe('TransientShellRegistry.spawn with traceContext', () => {
  it('does not emit bg_entity_spawn span (deprecated emission)', () => {
    const store = makeMockTraceStore()
    const traceContext = makeTraceCtx(store)
    const transient = new TransientShellRegistry()

    const entityId = transient.spawn({
      command: 'sleep 10',
      owner: { friend_id: 'user-B' },
      spawned_by_task_id: 'task-5',
      traceContext,
    })
    transient.kill(entityId)

    expect(entityId).toMatch(/^shell_[0-9a-f]{12}$/)
    // spawn 不 emit；exit 因为是被 kill 也不会经过 child.on('exit') 的成功路径
    // (kill 通过 status guard 把 status 改成 killed，状态保护防覆写)
  })

  it('emits bg_entity_exit span when transient process exits', async () => {
    const store = makeMockTraceStore()
    const traceContext = makeTraceCtx(store)
    const transient = new TransientShellRegistry()

    const entityId = transient.spawn({
      command: 'exit 0',
      owner: { friend_id: 'user-B' },
      spawned_by_task_id: 'task-6',
      traceContext,
    })

    // Poll for exit.
    for (let i = 0; i < 20; i++) {
      await sleep(50)
      const state = transient.get(entityId)
      if (state?.status !== 'running') break
    }

    // 仅 exit span（spawn 已废弃）
    expect(store.startSpan).toHaveBeenCalledOnce()
    const exitCall = store.startSpan.mock.calls[0]
    expect(exitCall[1].type).toBe('bg_entity_exit')
    const exitDetails = exitCall[1].details as Record<string, unknown>
    expect(exitDetails.entity_id).toBe(entityId)
    expect(exitDetails.exit_code).toBe(0)
    expect(exitDetails.status).toBe('completed')
    expect(typeof exitDetails.runtime_ms).toBe('number')
  })

  it('does not throw and does not call traceStore when traceContext is undefined', () => {
    const store = makeMockTraceStore()
    const transient = new TransientShellRegistry()

    const entityId = transient.spawn({
      command: 'sleep 10',
      owner: { friend_id: 'user-B' },
      spawned_by_task_id: 'task-7',
      // no traceContext
    })

    transient.kill(entityId)

    expect(entityId).toMatch(/^shell_[0-9a-f]{12}$/)
    expect(store.startSpan).not.toHaveBeenCalled()
  })
})

// Output / Kill 工具不再发 bg_entity_output / bg_entity_kill span（和 tool_call 重复，纯噪声）。
// 这两个 span 类型仍在 union 里保留，但实际 emission 已移除——参 commit 9b6ad11 后续优化。
