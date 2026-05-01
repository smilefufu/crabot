import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry'
import type {
  BgShellRegistryRecord,
  BgAgentRegistryRecord,
} from '../../../src/engine/bg-entities/types'

// Helper to build a shell record
function makeShellRecord(
  overrides: Partial<BgShellRegistryRecord> = {}
): BgShellRegistryRecord {
  return {
    entity_id: 'shell-001',
    type: 'shell',
    status: 'running',
    owner: { friend_id: 'user-A', session_id: 'ses-1' },
    spawned_by_task_id: 'task-1',
    spawned_at: new Date().toISOString(),
    exit_code: null,
    ended_at: null,
    last_activity_at: new Date().toISOString(),
    command: 'echo hello',
    log_file: '/tmp/shell-001.log',
    pid: process.pid, // use current pid so kill -0 succeeds
    pgid: process.pid,
    process_started_at: new Date().toISOString(), // will be overridden in alive test
    ...overrides,
  }
}

// Helper to build an agent record
function makeAgentRecord(
  overrides: Partial<BgAgentRegistryRecord> = {}
): BgAgentRegistryRecord {
  return {
    entity_id: 'agent-001',
    type: 'agent',
    status: 'running',
    owner: { friend_id: 'user-A', session_id: 'ses-1' },
    spawned_by_task_id: 'task-2',
    spawned_at: new Date().toISOString(),
    exit_code: null,
    ended_at: null,
    last_activity_at: new Date().toISOString(),
    task_description: 'do something',
    messages_log_file: '/tmp/agent-001.log',
    result_file: null,
    ...overrides,
  }
}

let tmpDir: string
let registry: BgEntityRegistry

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'bg-registry-test-'))
  // Override DATA_DIR so getBgEntitiesRegistryPath() resolves to our tmpDir
  process.env.DATA_DIR = tmpDir
  // registryPath = <tmpDir>/bg-entities/registry.json
  registry = new BgEntityRegistry()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.DATA_DIR
})

describe('BgEntityRegistry', () => {
  it('register: writes record that get() can retrieve', async () => {
    const rec = makeShellRecord()
    await registry.register(rec)
    const found = await registry.get('shell-001')
    expect(found).toMatchObject({ entity_id: 'shell-001', type: 'shell' })
  })

  it('update: patches partial fields without affecting others', async () => {
    const rec = makeShellRecord()
    await registry.register(rec)

    const endedAt = new Date().toISOString()
    await registry.update('shell-001', {
      status: 'completed',
      exit_code: 0,
      ended_at: endedAt,
    })

    const updated = await registry.get('shell-001')
    expect(updated?.status).toBe('completed')
    expect(updated?.exit_code).toBe(0)
    expect(updated?.ended_at).toBe(endedAt)
    // original fields untouched
    expect(updated?.entity_id).toBe('shell-001')
    expect((updated as BgShellRegistryRecord).command).toBe('echo hello')
  })

  it('get: returns null for unknown entity_id', async () => {
    const found = await registry.get('does-not-exist')
    expect(found).toBeNull()
  })

  it('list: filters by owner_friend_id', async () => {
    await registry.register(makeShellRecord({ entity_id: 'shell-A', owner: { friend_id: 'user-A' } }))
    await registry.register(makeShellRecord({ entity_id: 'shell-B', owner: { friend_id: 'user-B' } }))

    const results = await registry.list({ owner_friend_id: 'user-A' })
    expect(results).toHaveLength(1)
    expect(results[0].entity_id).toBe('shell-A')
  })

  it('list: filters by status array (inclusion semantics)', async () => {
    await registry.register(makeShellRecord({ entity_id: 's1', status: 'running' }))
    await registry.register(makeShellRecord({ entity_id: 's2', status: 'completed', exit_code: 0, ended_at: new Date().toISOString() }))
    await registry.register(makeShellRecord({ entity_id: 's3', status: 'failed', exit_code: 1, ended_at: new Date().toISOString() }))

    const results = await registry.list({ status: ['completed', 'failed'] })
    const ids = results.map((r) => r.entity_id).sort()
    expect(ids).toEqual(['s2', 's3'])
  })

  it('list: filters by type', async () => {
    await registry.register(makeShellRecord({ entity_id: 'shell-X' }))
    await registry.register(makeAgentRecord({ entity_id: 'agent-X' }))

    const shells = await registry.list({ type: 'shell' })
    expect(shells).toHaveLength(1)
    expect(shells[0].type).toBe('shell')

    const agents = await registry.list({ type: 'agent' })
    expect(agents).toHaveLength(1)
    expect(agents[0].type).toBe('agent')
  })

  it('list: no filter returns all entities', async () => {
    await registry.register(makeShellRecord({ entity_id: 'e1' }))
    await registry.register(makeAgentRecord({ entity_id: 'e2' }))
    const all = await registry.list()
    expect(all).toHaveLength(2)
  })

  it('recoverPersistent: marks running agents as stalled', async () => {
    const agentRec = makeAgentRecord({ entity_id: 'agent-stall', status: 'running' })
    await registry.register(agentRec)

    const { alive, deadShells, stalledAgents } = await registry.recoverPersistent()
    expect(stalledAgents).toHaveLength(1)
    expect(stalledAgents[0].entity_id).toBe('agent-stall')
    expect(deadShells).toHaveLength(0)
    expect(alive.filter((r) => r.entity_id === 'agent-stall')).toHaveLength(0)

    const updated = await registry.get('agent-stall')
    expect(updated?.status).toBe('stalled')
  })

  it('recoverPersistent: shell with current pid is classified as alive', async () => {
    // Get the actual start time of the current process so starttime comparison passes
    const { execFile } = await import('child_process')
    const starttime = await new Promise<string>((resolve, reject) => {
      execFile('ps', ['-o', 'lstart=', '-p', String(process.pid)], (err, stdout) => {
        if (err) reject(err)
        else resolve(new Date(stdout.trim()).toISOString())
      })
    })

    const shellRec = makeShellRecord({
      entity_id: 'shell-alive',
      pid: process.pid,
      pgid: process.pid,
      process_started_at: starttime,
    })
    await registry.register(shellRec)

    const { alive, deadShells } = await registry.recoverPersistent()
    expect(alive.some((r) => r.entity_id === 'shell-alive')).toBe(true)
    expect(deadShells.some((r) => r.entity_id === 'shell-alive')).toBe(false)

    // status should remain running
    const rec = await registry.get('shell-alive')
    expect(rec?.status).toBe('running')
  })

  it('recoverPersistent: shell with non-existent pid is classified as dead', async () => {
    const shellRec = makeShellRecord({
      entity_id: 'shell-dead',
      pid: 999999,
      pgid: 999999,
      process_started_at: new Date(Date.now() - 10000).toISOString(),
    })
    await registry.register(shellRec)

    const { alive, deadShells } = await registry.recoverPersistent()
    expect(deadShells.some((r) => r.entity_id === 'shell-dead')).toBe(true)
    expect(alive.some((r) => r.entity_id === 'shell-dead')).toBe(false)

    const rec = await registry.get('shell-dead')
    expect(rec?.status).toBe('failed')
    expect(rec?.exit_code).toBe(-1)
  })

  it('recoverPersistent: skips already-terminal entities', async () => {
    const completedShell = makeShellRecord({
      entity_id: 'shell-done',
      status: 'completed',
      exit_code: 0,
      ended_at: new Date().toISOString(),
    })
    await registry.register(completedShell)

    const { alive, deadShells, stalledAgents } = await registry.recoverPersistent()
    expect(alive).toHaveLength(0)
    expect(deadShells).toHaveLength(0)
    expect(stalledAgents).toHaveLength(0)
  })

  it('gcDeadEntities: removes entities ended more than 7 days ago', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const oldRec = makeShellRecord({
      entity_id: 'old-shell',
      status: 'completed',
      exit_code: 0,
      ended_at: eightDaysAgo,
      last_activity_at: eightDaysAgo,
    })
    await registry.register(oldRec)

    const { removed } = await registry.gcDeadEntities(new Date())
    expect(removed).toContain('old-shell')
    expect(await registry.get('old-shell')).toBeNull()
  })

  it('gcDeadEntities: keeps entities ended less than 7 days ago', async () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString()
    const recentRec = makeShellRecord({
      entity_id: 'recent-shell',
      status: 'completed',
      exit_code: 0,
      ended_at: sixDaysAgo,
      last_activity_at: sixDaysAgo,
    })
    await registry.register(recentRec)

    const { removed } = await registry.gcDeadEntities(new Date())
    expect(removed).not.toContain('recent-shell')
    expect(await registry.get('recent-shell')).not.toBeNull()
  })

  it('gcDeadEntities: does not remove status=running entities even with old last_activity_at', async () => {
    const veryOld = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const runningRec = makeShellRecord({
      entity_id: 'running-old',
      status: 'running',
      last_activity_at: veryOld,
    })
    await registry.register(runningRec)

    const { removed } = await registry.gcDeadEntities(new Date())
    expect(removed).not.toContain('running-old')
    expect(await registry.get('running-old')).not.toBeNull()
  })

  it('countActiveByOwner: counts only running entities for that owner', async () => {
    await registry.register(makeShellRecord({ entity_id: 'r1', owner: { friend_id: 'user-A' }, status: 'running' }))
    await registry.register(makeShellRecord({ entity_id: 'r2', owner: { friend_id: 'user-A' }, status: 'running' }))
    await registry.register(makeShellRecord({
      entity_id: 'r3',
      owner: { friend_id: 'user-A' },
      status: 'completed',
      exit_code: 0,
      ended_at: new Date().toISOString(),
    }))
    await registry.register(makeShellRecord({ entity_id: 'r4', owner: { friend_id: 'user-B' }, status: 'running' }))

    const count = await registry.countActiveByOwner('user-A')
    expect(count).toBe(2)
  })

  it('atomic write: no .tmp.* files remain after 100 concurrent registers', async () => {
    const records = Array.from({ length: 100 }, (_, i) =>
      makeShellRecord({ entity_id: `shell-${i}`, owner: { friend_id: `user-${i}` } })
    )
    await Promise.all(records.map((r) => registry.register(r)))

    const { readdir } = await import('node:fs/promises')
    const bgEntitiesDir = path.join(tmpDir, 'bg-entities')
    const files = await readdir(bgEntitiesDir)
    const tmpFiles = files.filter((f) => f.includes('.tmp.'))
    expect(tmpFiles).toHaveLength(0)

    // all 100 entities should be registered
    const all = await registry.list()
    expect(all).toHaveLength(100)
  })
})
