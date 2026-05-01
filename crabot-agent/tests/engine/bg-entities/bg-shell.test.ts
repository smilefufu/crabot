import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry'
import { spawnPersistentShell } from '../../../src/engine/bg-entities/bg-shell'
import type { BgShellRegistryRecord } from '../../../src/engine/bg-entities/types'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let tmpDir: string
let registry: BgEntityRegistry
const spawnedPids: number[] = []

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'bg-shell-test-'))
  process.env.DATA_DIR = tmpDir
  registry = new BgEntityRegistry()
})

afterEach(() => {
  // Kill any still-running child processes so vitest doesn't hang.
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already dead — ignore
    }
  }
  spawnedPids.length = 0

  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.DATA_DIR
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('spawnPersistentShell', () => {
  it('returns entity_id immediately in shell_<hex> format', async () => {
    const entityId = await spawnPersistentShell({
      command: 'sleep 5',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-1',
      registry,
    })

    expect(entityId).toMatch(/^shell_[0-9a-f]{12}$/)

    // track pid for cleanup
    const rec = await registry.get(entityId)
    if (rec && rec.type === 'shell') spawnedPids.push(rec.pid)
  })

  it('registry immediately contains a running record after spawn', async () => {
    const entityId = await spawnPersistentShell({
      command: 'sleep 5',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-2',
      registry,
    })

    const rec = await registry.get(entityId)
    expect(rec).not.toBeNull()
    expect(rec?.status).toBe('running')
    expect(rec?.type).toBe('shell')
    expect((rec as BgShellRegistryRecord).command).toBe('sleep 5')
    expect((rec as BgShellRegistryRecord).pid).toBeGreaterThan(0)

    if (rec && rec.type === 'shell') spawnedPids.push(rec.pid)
  })

  it('log file is created on disk immediately after spawn', async () => {
    const entityId = await spawnPersistentShell({
      command: 'sleep 5',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-3',
      registry,
    })

    const rec = await registry.get(entityId)
    expect(rec).not.toBeNull()

    const { existsSync } = await import('node:fs')
    expect(existsSync((rec as BgShellRegistryRecord).log_file)).toBe(true)

    if (rec && rec.type === 'shell') spawnedPids.push(rec.pid)
  })

  it('process stdout is written to the log file', async () => {
    const entityId = await spawnPersistentShell({
      command: 'echo hello_bg_shell',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-4',
      registry,
    })

    // Give process time to write output and exit.
    await sleep(200)

    const rec = await registry.get(entityId)
    expect(rec).not.toBeNull()

    const logContent = readFileSync((rec as BgShellRegistryRecord).log_file, 'utf8')
    expect(logContent).toContain('hello_bg_shell')
  })

  it('registry status becomes completed with exit_code=0 after clean exit', async () => {
    const entityId = await spawnPersistentShell({
      command: 'exit 0',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-5',
      registry,
    })

    // Wait for process to exit and registry to be updated.
    // Uses poll loop to avoid flakiness from variable process startup time.
    for (let i = 0; i < 20; i++) {
      await sleep(50)
      const rec = await registry.get(entityId)
      if (rec?.status !== 'running') break
    }

    const rec = await registry.get(entityId)
    expect(rec?.status).toBe('completed')
    expect(rec?.exit_code).toBe(0)
    expect(rec?.ended_at).not.toBeNull()
  })

  it('registry status becomes failed with non-zero exit_code', async () => {
    const entityId = await spawnPersistentShell({
      command: 'exit 7',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-6',
      registry,
    })

    // Poll for status change (up to 1s).
    for (let i = 0; i < 20; i++) {
      await sleep(50)
      const rec = await registry.get(entityId)
      if (rec?.status !== 'running') break
    }

    const rec = await registry.get(entityId)
    expect(rec?.status).toBe('failed')
    expect(rec?.exit_code).toBe(7)
    expect(rec?.ended_at).not.toBeNull()
  })

  it('owner and spawned_by_task_id are correctly persisted in registry', async () => {
    const owner = { friend_id: 'user-X', session_id: 'ses-99', channel_id: 'chan-1' }
    const entityId = await spawnPersistentShell({
      command: 'sleep 5',
      owner,
      spawned_by_task_id: 'task-7',
      registry,
    })

    const rec = await registry.get(entityId)
    expect(rec?.owner).toEqual(owner)
    expect(rec?.spawned_by_task_id).toBe('task-7')

    if (rec && rec.type === 'shell') spawnedPids.push(rec.pid)
  })

  it('detached process survives after caller closes its fd (log still written)', async () => {
    // Spawn a process that sleeps briefly then writes output — the caller has
    // already closed its copy of the log fd by the time writing happens.
    const entityId = await spawnPersistentShell({
      command: 'sleep 0.1 && echo survived_detach',
      owner: { friend_id: 'user-A' },
      spawned_by_task_id: 'task-8',
      registry,
    })

    // Wait enough for the process to complete and write.
    await sleep(500)

    const rec = await registry.get(entityId)
    expect(rec).not.toBeNull()

    const logContent = readFileSync((rec as BgShellRegistryRecord).log_file, 'utf8')
    expect(logContent).toContain('survived_detach')
    expect(rec?.status).toBe('completed')
  })
})
