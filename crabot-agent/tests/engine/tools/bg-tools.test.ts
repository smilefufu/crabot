/**
 * Tests for Output / Kill / ListEntities bg entity tools.
 *
 * Plan 2 Tasks 7–9: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md
 * 后台 shell / sub-agent 现在统一为持久实体（bgRegistry + 磁盘日志）；transient 已移除。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry'
import { spawnPersistentShell, runShellWithGrace } from '../../../src/engine/bg-entities/bg-shell'
import { createOutputTool } from '../../../src/engine/tools/output-tool'
import { createKillTool } from '../../../src/engine/tools/kill-tool'
import { createListEntitiesTool } from '../../../src/engine/tools/list-entities-tool'
import type { BgToolDeps } from '../../../src/engine/tools/output-tool'
import type { BgAgentRegistryRecord } from '../../../src/engine/bg-entities/types'

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
let cursorMap: Map<string, number>
let deps: BgToolDeps

const spawnedPids: number[] = []

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'bg-tools-test-'))
  process.env.DATA_DIR = tmpDir

  registry = new BgEntityRegistry()
  cursorMap = new Map()

  deps = {
    registry,
    cursorMap,
    taskId: TASK_ID,
    ownerFriendId: OWNER_FRIEND_ID,
  }
})

afterEach(() => {
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
      cwd: process.cwd(),
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
      cwd: process.cwd(),
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

  it('persistent shell: no new output since last read returns (no new output) marker', async () => {
    const entityId = await spawnPersistentShell({
      command: 'echo once; sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      cwd: process.cwd(),
      registry,
    })

    const rec = await registry.get(entityId)
    if (rec?.type === 'shell') spawnedPids.push(rec.pid)

    const tool = createOutputTool(deps)

    await sleep(300)
    const result1 = await tool.call({ entity_id: entityId }, {})
    expect(result1.output).toContain('once')

    const result2 = await tool.call({ entity_id: entityId }, {})
    expect(result2.isError).toBe(false)
    expect(result2.output).toContain('(no new output)')
    expect(result2.output).toContain('[status: running')
  })

  it('persistent shell: block=true waits for next output instead of returning immediately (trace ec8618b8 bug)', async () => {
    const entityId = await spawnPersistentShell({
      command: 'sleep 2.5; echo late_output',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      cwd: process.cwd(),
      registry,
    })

    const rec = await registry.get(entityId)
    if (rec?.type === 'shell') spawnedPids.push(rec.pid)

    const tool = createOutputTool(deps)

    await sleep(100)
    const startMs = Date.now()
    const result = await tool.call(
      { entity_id: entityId, block: true, timeout_ms: 8_000 },
      {},
    )
    const elapsed = Date.now() - startMs
    expect(result.isError).toBe(false)
    expect(result.output).toContain('late_output')
    // bug 形态是秒回 [status: running] 空内容；修复后应真正等到输出（>2s）
    expect(elapsed).toBeGreaterThan(2_000)
  }, 15_000)

  it('block=true documents the 600s maximum used by timeout clamping', () => {
    const tool = createOutputTool(deps)
    const properties = (tool.inputSchema as {
      properties: Record<string, { description?: string }>
    }).properties
    expect(properties.timeout_ms?.description).toContain('600000')
  })

  it('runShellWithGrace promoted shell still feeds combined log output into Output', async () => {
    const result = await runShellWithGrace({
      command: 'sleep 0.15; printf "after-promotion-out\\n"; printf "after-promotion-err\\n" >&2',
      cwd: process.cwd(),
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      registry,
      gracePeriodMs: 50,
    })

    expect(result.kind).toBe('background')
    if (result.kind !== 'background') {
      return
    }

    for (let i = 0; i < 20; i++) {
      const rec = await registry.get(result.entity_id)
      if (rec?.type === 'shell' && rec.status !== 'running') {
        break
      }
      await sleep(50)
    }

    const tool = createOutputTool(deps)
    const output = await tool.call({ entity_id: result.entity_id }, {})

    expect(output.isError).toBe(false)
    expect(output.output).toContain('after-promotion-out')
    expect(output.output).toContain('after-promotion-err')
    expect(output.output).toContain('[status: completed, exit_code: 0]')
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

  it('agent_xxx 被拒：Output 只读 shell，指向 get_subagent_output', async () => {
    const tool = createOutputTool(deps)
    const result = await tool.call({ entity_id: 'agent_aabbccdd1122' }, {})

    expect(result.isError).toBe(true)
    expect(result.output).toContain('get_subagent_output')
  })

  it('two tasks reading the same persistent shell do not share cursors', async () => {
    const entityId = await spawnPersistentShell({
      command: 'echo shared_data',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      cwd: process.cwd(),
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
      cwd: process.cwd(),
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
      cwd: process.cwd(),
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

  it('agent_xxx not in registry returns entity-not-found error', async () => {
    const tool = createKillTool(deps)
    const result = await tool.call({ entity_id: 'agent_aabbccdd1122' }, {})

    expect(result.isError).toBe(true)
    expect(result.output).toContain('Entity not found')
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
  it('lists persistent running entities', async () => {
    const persistId = await spawnPersistentShell({
      command: 'sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      cwd: process.cwd(),
      registry,
    })

    const rec = await registry.get(persistId)
    if (rec?.type === 'shell') spawnedPids.push(rec.pid)

    const tool = createListEntitiesTool(deps)
    const result = await tool.call({ status: 'running' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain(persistId)
  })

  it('owner_friend_id filter: only returns entities for owner A', async () => {
    const persistIdA = await spawnPersistentShell({
      command: 'sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      cwd: process.cwd(),
      registry,
    })

    const recA = await registry.get(persistIdA)
    if (recA?.type === 'shell') spawnedPids.push(recA.pid)

    // One entity for owner B
    const persistIdB = await spawnPersistentShell({
      command: 'sleep 30',
      owner: OWNER_B,
      spawned_by_task_id: 'task-B',
      cwd: process.cwd(),
      registry,
    })

    const recB = await registry.get(persistIdB)
    if (recB?.type === 'shell') spawnedPids.push(recB.pid)

    const tool = createListEntitiesTool(deps) // ownerFriendId = 'friend-A'
    const result = await tool.call({ status: 'running' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain(persistIdA)
    expect(result.output).not.toContain(persistIdB)
  })

  it('status=all returns running and completed and killed entities', async () => {
    // Running entity
    const runningId = await spawnPersistentShell({
      command: 'sleep 30',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      cwd: process.cwd(),
      registry,
    })

    const recRunning = await registry.get(runningId)
    if (recRunning?.type === 'shell') spawnedPids.push(recRunning.pid)

    // Completed entity
    const completedId = await spawnPersistentShell({
      command: 'exit 0',
      owner: OWNER_A,
      spawned_by_task_id: TASK_ID,
      cwd: process.cwd(),
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
      cwd: process.cwd(),
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
})

// ---------------------------------------------------------------------------
// Agent entity type branch tests (Plan 2 Task 14)
// ---------------------------------------------------------------------------

function makeAgentRecord(
  overrides: Partial<BgAgentRegistryRecord> & { entity_id: string; messages_log_file: string },
): BgAgentRegistryRecord {
  return {
    type: 'agent',
    entity_id: overrides.entity_id,
    status: overrides.status ?? 'running',
    owner: overrides.owner ?? { friend_id: OWNER_FRIEND_ID, session_id: 'sess-A' },
    spawned_by_task_id: overrides.spawned_by_task_id ?? TASK_ID,
    spawned_at: overrides.spawned_at ?? new Date().toISOString(),
    exit_code: overrides.exit_code ?? null,
    ended_at: overrides.ended_at ?? null,
    last_activity_at: overrides.last_activity_at ?? new Date().toISOString(),
    task_description: overrides.task_description ?? 'do some work',
    messages_log_file: overrides.messages_log_file,
    result_file: overrides.result_file ?? null,
  }
}

describe('agent type branch', () => {
  // Output 不再支持 agent_xxx（与 get_subagent_output 重复，已移除）；这里只测 Kill / ListEntities 的 agent 分支。

  it('Kill running agent — aborts controller and marks registry status=killed', async () => {
    const messagesLog = path.join(tmpDir, 'agent_kill.jsonl')
    writeFileSync(messagesLog, '')

    const agentId = 'agent_kill001'
    const record = makeAgentRecord({
      entity_id: agentId,
      status: 'running',
      messages_log_file: messagesLog,
    })
    await registry.register(record)

    const controller = new AbortController()
    const agentAbortControllers = new Map<string, AbortController>([[agentId, controller]])
    const depsWithControllers: BgToolDeps = { ...deps, agentAbortControllers }

    const tool = createKillTool(depsWithControllers)
    const result = await tool.call({ entity_id: agentId }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('killed')
    expect(controller.signal.aborted).toBe(true)

    const updated = await registry.get(agentId)
    expect(updated?.status).toBe('killed')
  })

  it('Kill already-completed agent — returns no-op message', async () => {
    const messagesLog = path.join(tmpDir, 'agent_completed.jsonl')
    writeFileSync(messagesLog, '')

    const agentId = 'agent_done001'
    const record = makeAgentRecord({
      entity_id: agentId,
      status: 'completed',
      exit_code: 0,
      messages_log_file: messagesLog,
    })
    await registry.register(record)

    const tool = createKillTool(deps)
    const result = await tool.call({ entity_id: agentId }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Already completed')
    expect(result.output).toContain('no-op')
  })

  it('ListEntities includes both shell and agent rows with correct type column', async () => {
    // Register a persistent shell
    const shellId = await spawnPersistentShell({
      command: 'sleep 30',
      owner: { friend_id: OWNER_FRIEND_ID, session_id: 'sess-A' },
      spawned_by_task_id: TASK_ID,
      cwd: process.cwd(),
      registry,
    })
    const shellRec = await registry.get(shellId)
    if (shellRec?.type === 'shell') spawnedPids.push(shellRec.pid)

    // Register an agent record
    const messagesLog = path.join(tmpDir, 'agent_list.jsonl')
    writeFileSync(messagesLog, '')
    const agentId = 'agent_list001'
    const agentRecord = makeAgentRecord({
      entity_id: agentId,
      status: 'running',
      task_description: 'analyze the data thoroughly',
      messages_log_file: messagesLog,
    })
    await registry.register(agentRecord)

    const tool = createListEntitiesTool(deps)
    const result = await tool.call({ status: 'running' }, {})

    expect(result.isError).toBe(false)
    // Both IDs appear
    expect(result.output).toContain(shellId)
    expect(result.output).toContain(agentId)
    // Type column distinguishes them
    expect(result.output).toContain('shell')
    expect(result.output).toContain('agent')
    // Agent description visible
    expect(result.output).toContain('analyze the data')
  })
})
