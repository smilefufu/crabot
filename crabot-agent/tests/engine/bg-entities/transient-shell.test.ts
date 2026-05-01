/**
 * Tests for TransientShellRegistry.
 *
 * Plan 2 Task 5: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md
 */

import { describe, it, expect, afterEach } from 'vitest'
import { TransientShellRegistry } from '../../../src/engine/bg-entities/bg-shell'
import type { BgEntityOwner } from '../../../src/engine/bg-entities/types'
import { BG_TRANSIENT_RING_BUFFER_BYTES } from '../../../src/engine/bg-entities/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const owner: BgEntityOwner = { friend_id: 'friend-001', session_id: 'sess-001' }
const ownerB: BgEntityOwner = { friend_id: 'friend-002', session_id: 'sess-002' }

// ---------------------------------------------------------------------------
// Cleanup tracking — afterEach kills any still-running shell
// ---------------------------------------------------------------------------

let registry: TransientShellRegistry

afterEach(() => {
  if (!registry) return
  for (const shell of registry.list()) {
    if (shell.status === 'running') {
      registry.kill(shell.entity_id)
    }
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransientShellRegistry', () => {
  it('spawn returns an entity_id with format shell_<hex>', () => {
    registry = new TransientShellRegistry()
    const id = registry.spawn({ command: 'sleep 30', owner, spawned_by_task_id: 'task-1' })
    expect(id).toMatch(/^shell_[0-9a-f]{12}$/)
  })

  it('initial status is running', () => {
    registry = new TransientShellRegistry()
    const id = registry.spawn({ command: 'sleep 30', owner, spawned_by_task_id: 'task-1' })
    expect(registry.get(id)?.status).toBe('running')
  })

  it('stdout and stderr are accumulated to ringBuffer', async () => {
    registry = new TransientShellRegistry()
    const id = registry.spawn({
      command: 'echo hello && echo world >&2',
      owner,
      spawned_by_task_id: 'task-1',
    })
    await sleep(300)
    const state = registry.get(id)
    expect(state?.ringBuffer).toContain('hello')
    expect(state?.ringBuffer).toContain('world')
  })

  it('status becomes completed after clean exit', async () => {
    registry = new TransientShellRegistry()
    const id = registry.spawn({ command: 'exit 0', owner, spawned_by_task_id: 'task-1' })
    await sleep(400)
    const state = registry.get(id)
    expect(state?.status).toBe('completed')
    expect(state?.exit_code).toBe(0)
    expect(state?.ended_at).not.toBeNull()
  })

  it('non-zero exit code marks status as failed', async () => {
    registry = new TransientShellRegistry()
    const id = registry.spawn({ command: 'exit 7', owner, spawned_by_task_id: 'task-1' })
    await sleep(400)
    const state = registry.get(id)
    expect(state?.status).toBe('failed')
    expect(state?.exit_code).toBe(7)
  })

  it('kill() terminates a running process', async () => {
    registry = new TransientShellRegistry()
    const id = registry.spawn({ command: 'sleep 30', owner, spawned_by_task_id: 'task-1' })
    await sleep(100)
    registry.kill(id)
    await sleep(300)
    expect(registry.get(id)?.status).toBe('killed')
  })

  it('kill() is a no-op on an already-exited shell', async () => {
    registry = new TransientShellRegistry()
    const id = registry.spawn({ command: 'exit 0', owner, spawned_by_task_id: 'task-1' })
    await sleep(400)
    expect(registry.get(id)?.status).toBe('completed')
    // Should not throw or change status
    registry.kill(id)
    expect(registry.get(id)?.status).toBe('completed')
  })

  it('killAllOwnedBy() kills only shells owned by given task_id', async () => {
    registry = new TransientShellRegistry()
    const idsA: string[] = []
    const idsB: string[] = []

    for (let i = 0; i < 3; i++) {
      idsA.push(registry.spawn({ command: 'sleep 30', owner, spawned_by_task_id: 'task-A' }))
    }
    for (let i = 0; i < 2; i++) {
      idsB.push(registry.spawn({ command: 'sleep 30', owner: ownerB, spawned_by_task_id: 'task-B' }))
    }

    await sleep(100)
    registry.killAllOwnedBy('task-A')
    await sleep(300)

    for (const id of idsA) {
      expect(registry.get(id)?.status).toBe('killed')
    }
    for (const id of idsB) {
      expect(registry.get(id)?.status).toBe('running')
    }
  })

  it('list() filters by owner_friend_id', async () => {
    registry = new TransientShellRegistry()
    registry.spawn({ command: 'sleep 30', owner, spawned_by_task_id: 'task-1' })
    registry.spawn({ command: 'sleep 30', owner: ownerB, spawned_by_task_id: 'task-2' })

    const results = registry.list({ owner_friend_id: 'friend-001' })
    expect(results).toHaveLength(1)
    expect(results[0].owner.friend_id).toBe('friend-001')
  })

  it('list() filters by status', async () => {
    registry = new TransientShellRegistry()
    const idRunning = registry.spawn({ command: 'sleep 30', owner, spawned_by_task_id: 'task-1' })
    const idDone = registry.spawn({ command: 'exit 0', owner, spawned_by_task_id: 'task-2' })
    await sleep(400)

    const running = registry.list({ status: ['running'] })
    expect(running.every((s) => s.status === 'running')).toBe(true)
    expect(running.some((s) => s.entity_id === idRunning)).toBe(true)

    const completed = registry.list({ status: ['completed'] })
    expect(completed.some((s) => s.entity_id === idDone)).toBe(true)
  })

  it('ringBuffer is capped at BG_TRANSIENT_RING_BUFFER_BYTES', async () => {
    registry = new TransientShellRegistry()
    // Produce ~300KB of output. `yes` prints "y\n" repeatedly.
    // head -c 300000 terminates it.
    const id = registry.spawn({
      command: 'yes | head -c 300000',
      owner,
      spawned_by_task_id: 'task-1',
    })
    await sleep(800)
    const state = registry.get(id)
    expect(state?.ringBuffer.length).toBeLessThanOrEqual(BG_TRANSIENT_RING_BUFFER_BYTES)
    // Should still have content (not empty)
    expect((state?.ringBuffer.length ?? 0)).toBeGreaterThan(0)
  }, 5000)

  it('size() returns total registered entity count', () => {
    registry = new TransientShellRegistry()
    expect(registry.size()).toBe(0)
    registry.spawn({ command: 'sleep 30', owner, spawned_by_task_id: 'task-1' })
    registry.spawn({ command: 'sleep 30', owner, spawned_by_task_id: 'task-2' })
    expect(registry.size()).toBe(2)
  })
})
