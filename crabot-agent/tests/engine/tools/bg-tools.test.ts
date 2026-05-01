/**
 * Tests for Output / Kill / ListEntities bg entity tools.
 *
 * Plan 2 Tasks 7–9: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry'
import { spawnPersistentShell, TransientShellRegistry } from '../../../src/engine/bg-entities/bg-shell'
import { createOutputTool } from '../../../src/engine/tools/output-tool'
import { createKillTool } from '../../../src/engine/tools/kill-tool'
import { createListEntitiesTool } from '../../../src/engine/tools/list-entities-tool'
import type { BgToolDeps } from '../../../src/engine/tools/output-tool'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const TASK_ID = 'task-test-001'
const OWNER_FRIEND_ID = 'friend-A'
const OWNER_A = { friend_id: 'friend-A', session_id: 'sess-A' }
const OWNER_B = { friend_id: 'friend-B', session_id: 'sess-B' }

// ---------------------------------------------------------------------------
// State shared across tests
// ---------------------------------------------------------------------------

let tmpDir: string
let registry: BgEntityRegistry
let transient: TransientShellRegistry
let cursorMap: Map<string, number>
let deps: BgToolDeps

const spawnedPids: number[] = []

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'bg-tools-test-'))
  process.env.DATA_DIR = tmpDir

  registry = new BgEntityRegistry()
  transient = new TransientShellRegistry()
  cursorMap = new Map()

  deps = {
    registry,
    transient,
    cursorMap,
    taskId: TASK_ID,
    ownerFriendId: OWNER_FRIEND_ID,
  }
})

afterEach(() => {
  // Kill any still-running transient shells
  for (const shell of transient.list()) {
    if (shell.status === 'running') {
      transient.kill(shell.entity_id)
    }
  }

  // Kill any tracked persistent shell pids
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already dead
    }
  }
  spawnedPids.length = 0

  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.DATA_DIR
})

// ---------------------------------------------------------------------------
// Output tool tests
// ---------------------------------------------------------------------------

describe('Output tool', () => {
  it('persistent shell: reads output after process completes', async () => {
    const entityId = await spawnPersistentShell({
      command: 'echo hello',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      registry,
    })

    const rec = await registry.get(entityId)
    if (rec?.type === 'shell') spawnedPids.push(rec.pid)

    // Wait for process to complete
    await sleep(400)

    const tool = createOutputTool(deps)
    const result = await tool.call({ entity_id: entityId }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello')
  })

  it('persistent shell: incremental read — second call does not repeat first output', async () => {
    const entityId = await spawnPersistentShell({
      command: 'echo first; sleep 0.3; echo second',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      registry,
    })

    const rec = await registry.get(entityId)
    if (rec?.type === 'shell') spawnedPids.push(rec.pid)

    const tool = createOutputTool(deps)

    // First read after ~100ms — should get "first"
    await sleep(150)
    const result1 = await tool.call({ entity_id: entityId }, {})
    expect(result1.isError).toBe(false)
    expect(result1.output).toContain('first')

    // Second read after ~500ms total — should get "second" only
    await sleep(400)
    const result2 = await tool.call({ entity_id: entityId }, {})
    expect(result2.isError).toBe(false)
    expect(result2.output).toContain('second')
    expect(result2.output).not.toContain('first')
  })

  it('transient shell: reads ringBuffer content', async () => {
    const entityId = transient.spawn({
      command: 'echo transient_output',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
    })

    await sleep(300)

    const tool = createOutputTool(deps)
    const result = await tool.call({ entity_id: entityId }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('transient_output')
  })

  it('non-existent entity_id returns error', async () => {
    const tool = createOutputTool(deps)
    const result = await tool.call({ entity_id: 'shell_000000000000' }, {})

    expect(result.isError).toBe(true)
    expect(result.output).toContain('Entity not found')
  })

  it('invalid prefix returns format error', async () => {
    const tool = createOutputTool(deps)
    const result = await tool.call({ entity_id: 'proc_12345' }, {})

    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid entity_id format')
  })

  it('agent_xxx returns not-yet-implemented placeholder with isError=true', async () => {
    const tool = createOutputTool(deps)
    const result = await tool.call({ entity_id: 'agent_aabbccdd1122' }, {})

    expect(result.isError).toBe(true)
    expect(result.output).toContain('not yet implemented')
    expect(result.output).toContain('Task 14')
  })

  it('two tasks reading the same persistent shell do not share cursors', async () => {
    const entityId = await spawnPersistentShell({
      command: 'echo shared_data',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      registry,
    })

    const rec = await registry.get(entityId)
    if (rec?.type === 'shell') spawnedPids.push(rec.pid)

    await sleep(300)

    const cursorMap2 = new Map<string, number>()
    const deps2: BgToolDeps = { ...deps, taskId: 'task-other-999', cursorMap: cursorMap2 }

    const tool1 = createOutputTool(deps)
    const tool2 = createOutputTool(deps2)

    const result1 = await tool1.call({ entity_id: entityId }, {})
    const result2 = await tool2.call({ entity_id: entityId }, {})

    expect(result1.isError).toBe(false)
    expect(result1.output).toContain('shared_data')
    expect(result2.isError).toBe(false)
    expect(result2.output).toContain('shared_data')

    // Cursors are stored separately per task
    const key1 = `${TASK_ID}:${entityId}`
    const key2 = `task-other-999:${entityId}`
    expect(cursorMap.has(key1)).toBe(true)
    expect(cursorMap2.has(key2)).toBe(true)
    expect(cursorMap.has(key2)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Kill tool tests
// ---------------------------------------------------------------------------

describe('Kill tool', () => {
  it('persistent running shell is killed — registry status becomes killed', async () => {
    const entityId = await spawnPersistentShell({
      command: 'sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      registry,
    })

    const rec = await registry.get(entityId)
    if (rec?.type === 'shell') spawnedPids.push(rec.pid)

    const tool = createKillTool(deps)
    const result = await tool.call({ entity_id: entityId }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('SIGTERM')

    await sleep(200)

    const updated = await registry.get(entityId)
    expect(updated?.status).toBe('killed')
  })

  it('persistent already-completed shell returns no-op message', async () => {
    const entityId = await spawnPersistentShell({
      command: 'exit 0',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      registry,
    })

    // Wait for completion
    for (let i = 0; i < 20; i++) {
      await sleep(50)
      const rec = await registry.get(entityId)
      if (rec?.status !== 'running') break
    }

    const tool = createKillTool(deps)
    const result = await tool.call({ entity_id: entityId }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Already completed')
    expect(result.output).toContain('no-op')
  })

  it('transient running shell is killed via TransientShellRegistry.kill()', async () => {
    const entityId = transient.spawn({
      command: 'sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
    })

    await sleep(100)

    const tool = createKillTool(deps)
    const result = await tool.call({ entity_id: entityId }, {})

    expect(result.isError).toBe(false)

    await sleep(200)
    expect(transient.get(entityId)?.status).toBe('killed')
  })

  it('agent_xxx returns not-yet-implemented placeholder', async () => {
    const tool = createKillTool(deps)
    const result = await tool.call({ entity_id: 'agent_aabbccdd1122' }, {})

    expect(result.isError).toBe(true)
    expect(result.output).toContain('not yet implemented')
    expect(result.output).toContain('Task 14')
  })

  it('invalid entity_id prefix returns error', async () => {
    const tool = createKillTool(deps)
    const result = await tool.call({ entity_id: 'job_12345' }, {})

    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid entity_id')
  })
})

// ---------------------------------------------------------------------------
// ListEntities tool tests
// ---------------------------------------------------------------------------

describe('ListEntities tool', () => {
  it('lists both persistent and transient running entities', async () => {
    const persistId = await spawnPersistentShell({
      command: 'sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      registry,
    })

    const rec = await registry.get(persistId)
    if (rec?.type === 'shell') spawnedPids.push(rec.pid)

    const transientId = transient.spawn({
      command: 'sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
    })

    const tool = createListEntitiesTool(deps)
    const result = await tool.call({ status: 'running' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain(persistId)
    expect(result.output).toContain(transientId)
  })

  it('owner_friend_id filter: only returns entities for owner A', async () => {
    // Two entities for owner A (one persistent, one transient)
    const persistIdA = await spawnPersistentShell({
      command: 'sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      registry,
    })

    const recA = await registry.get(persistIdA)
    if (recA?.type === 'shell') spawnedPids.push(recA.pid)

    const transientIdA = transient.spawn({
      command: 'sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
    })

    // One entity for owner B
    const persistIdB = await spawnPersistentShell({
      command: 'sleep 30',
      owner: OWNER_B,
      spawned_by_task_id: 'task-B',
      registry,
    })

    const recB = await registry.get(persistIdB)
    if (recB?.type === 'shell') spawnedPids.push(recB.pid)

    const tool = createListEntitiesTool(deps) // ownerFriendId = 'friend-A'
    const result = await tool.call({ status: 'running' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain(persistIdA)
    expect(result.output).toContain(transientIdA)
    expect(result.output).not.toContain(persistIdB)
  })

  it('status=all returns running and completed and killed entities', async () => {
    // Running entity
    const runningId = await spawnPersistentShell({
      command: 'sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      registry,
    })

    const recRunning = await registry.get(runningId)
    if (recRunning?.type === 'shell') spawnedPids.push(recRunning.pid)

    // Completed entity
    const completedId = await spawnPersistentShell({
      command: 'exit 0',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      registry,
    })

    // Wait for completion
    for (let i = 0; i < 20; i++) {
      await sleep(50)
      const rec = await registry.get(completedId)
      if (rec?.status !== 'running') break
    }

    // Killed entity
    const killedId = await spawnPersistentShell({
      command: 'sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      registry,
    })

    const recKilled = await registry.get(killedId)
    if (recKilled?.type === 'shell') spawnedPids.push(recKilled.pid)

    const killTool = createKillTool(deps)
    await killTool.call({ entity_id: killedId }, {})

    const tool = createListEntitiesTool(deps)
    const result = await tool.call({ status: 'all' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain(runningId)
    expect(result.output).toContain(completedId)
    expect(result.output).toContain(killedId)
  })

  it('empty list returns placeholder message', async () => {
    const tool = createListEntitiesTool(deps)
    const result = await tool.call({ status: 'running' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toBe('(no entities matching filter)')
  })

  it('transient entities filtered to current task only', async () => {
    // This task's transient shell
    const myTransientId = transient.spawn({
      command: 'sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
    })

    // Another task's transient shell (same owner, different task)
    const otherTransientId = transient.spawn({
      command: 'sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: 'task-other-xyz',
    })

    const tool = createListEntitiesTool(deps) // taskId = TASK_ID
    const result = await tool.call({ status: 'running' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain(myTransientId)
    expect(result.output).not.toContain(otherTransientId)
  })
})
