import { describe, expect, it, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { LedgerStore } from '../../src/workers/harness/ledger-store.js'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager.js'
import { importV2LegacyTasks } from '../../src/workers/legacy-importer.js'
import { readLegacyTraces } from '../../src/workers/legacy-source-reader.js'
import { WorkerEventLog } from '../../src/workers/harness/worker-events.js'

const dirs: string[] = []
async function fixture(tasks?: unknown): Promise<{ root: string; admin: string; agent: string; traces: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'legacy-import-')); dirs.push(root)
  const admin = join(root, 'admin'); const agent = join(root, 'agent'); const traces = join(agent, 'traces')
  await fs.mkdir(admin, { recursive: true }); await fs.mkdir(traces, { recursive: true })
  if (tasks !== undefined) await fs.writeFile(join(admin, 'tasks.json'), JSON.stringify(tasks))
  return { root, admin, agent, traces }
}
function task(id: string, overrides: Record<string, unknown> = {}) { return { id, title: `title ${id}`, status: 'completed', created_at: '2026-01-01T00:00:00.000Z', priority: 'high', source: { channel_id: 'wechat', session_id: 's', friend_id: 'f', trigger_type: 'message' }, result: { outcome_brief: 'done', finished_at: '2026-01-01T01:00:00.000Z' }, ...overrides } }
function deps(f: Awaited<ReturnType<typeof fixture>>) { return { adminDataDir: f.admin, traceDir: f.traces, agentDataDir: f.agent, ledger: new LedgerStore(join(f.agent, 'worker-ledgers')), workspaces: new WorkspaceManager(join(f.root, 'workspaces')), now: () => '2026-08-10T00:00:00.000Z' } }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))) })

describe('v2 legacy importer', () => {
  it('fails closed when Admin root is absent, but absent tasks and empty tasks complete zero imports', async () => {
    const missingRoot = await fixture()
    await fs.rm(missingRoot.admin, { recursive: true })
    await expect(importV2LegacyTasks(deps(missingRoot))).rejects.toThrow('Admin data directory')

    const absent = await fixture()
    expect(await importV2LegacyTasks(deps(absent))).toMatchObject({ imported: 0 })
    const empty = await fixture([])
    expect(await importV2LegacyTasks(deps(empty))).toMatchObject({ imported: 0 })
  })

  it('builds the ledger index once and does not rescan it for every new imported worker', async () => {
    const f = await fixture([task('one'), task('two'), task('three')])
    const d = deps(f)
    const fullLookup = vi.spyOn(d.ledger, 'findWorker')

    await expect(importV2LegacyTasks(d)).resolves.toMatchObject({ imported: 3 })

    expect(fullLookup).not.toHaveBeenCalled()
    expect(await d.ledger.listAllWorkers()).toHaveLength(3)
  })

  it('imports task authority only, maps source/statuses, writes one local event and never mutates sources', async () => {
    const f = await fixture([
      task('complete', { type: 'analysis', input: { q: 1 }, tags: ['legacy'], goal: { objective: 'finish' } }),
      task('failed', { status: 'failed' }), task('cancel', { status: 'cancelled' }),
      task('old', { status: 'executing', source: { trigger_type: 'auto' } }),
      task('pending', { status: 'pending' }), task('planning', { status: 'planning' }),
      task('waiting-human', { status: 'waiting_human' }), task('waiting', { status: 'waiting' }),
      task('scheduled', { source: { channel_id: 'x', session_id: 'y', trigger_type: 'scheduled' } }),
      task('manual', { source: { channel_id: 'x', session_id: 'manual', trigger_type: 'manual' } }),
      task('unknown-trigger', { source: { trigger_type: 'unknown' } }),
      task('chat', { source: { origin: 'admin_chat', trigger_type: 'event' } }),
    ])
    const sourceBefore = await fs.readFile(join(f.admin, 'tasks.json'), 'utf8')
    await fs.writeFile(join(f.traces, 'traces-2026-01-01.jsonl'), JSON.stringify({ trace_id: 't1', related_task_id: 'complete', started_at: '2026-01-01T00:01:00.000Z', ended_at: '2026-01-01T00:02:00.000Z', resume_checkpoint: { worker_state: { cwd: '/does/not/exist' } } }) + '\n' + JSON.stringify({ trace_id: 'orphan', related_task_id: 'none' }) + '\n')
    const traceBefore = await fs.readFile(join(f.traces, 'traces-2026-01-01.jsonl'), 'utf8')
    const oldRunningPath = join(f.traces, 'traces-running.jsonl'); await fs.writeFile(oldRunningPath, JSON.stringify({ trace_id: 'old-running', related_task_id: 'complete' }) + '\n')
    const oldRunningHash = createHash('sha256').update(await fs.readFile(oldRunningPath)).digest('hex')
    const d = deps(f); const result = await importV2LegacyTasks(d)
    expect(result.imported).toBe(12)
    const id = `w-legacy-${createHash('sha256').update('complete').digest('hex').slice(0, 32)}`
    const complete = await d.ledger.findWorker(id)
    expect(complete?.worker.task).toMatchObject({
      status: 'completed', type: 'analysis', input: { q: 1 }, tags: ['legacy'], goal: 'finish',
      priority: 'high', outcome: 'done',
    })
    expect(complete?.worker.legacy_source?.trace_ids).toEqual(['t1', 'old-running'])
    expect(complete?.worker.incarnations[0]).not.toHaveProperty('session_ref')
    const old = await d.ledger.findWorker(`w-legacy-${createHash('sha256').update('old').digest('hex').slice(0, 32)}`); expect(old?.worker.task).toMatchObject({ status: 'failed', error: expect.stringContaining('v3') })
    for (const legacyStatus of ['pending', 'planning', 'waiting-human', 'waiting']) {
      const imported = await d.ledger.findWorker(`w-legacy-${createHash('sha256').update(legacyStatus).digest('hex').slice(0, 32)}`)
      expect(imported?.worker.task.status).toBe('failed')
      expect(imported?.worker.incarnations[0]?.ended_reason).toBe('pre_migration')
    }
    const manual = await d.ledger.findWorker(`w-legacy-${createHash('sha256').update('manual').digest('hex').slice(0, 32)}`)
    expect(manual?.worker.origin.trigger_type).toBe('message')
    const unknownTrigger = await d.ledger.findWorker(`w-legacy-${createHash('sha256').update('unknown-trigger').digest('hex').slice(0, 32)}`)
    expect(unknownTrigger?.worker.origin.trigger_type).toBe('system')
    const chat = await d.ledger.findWorker(`w-legacy-${createHash('sha256').update('chat').digest('hex').slice(0, 32)}`); expect(chat?.worker.manager_key).toBe('admin-web::system-tasks'); expect(chat?.worker.origin.trigger_type).toBe('message')
    const importedWorkers = await d.ledger.listAllWorkers()
    expect(importedWorkers).toHaveLength(12)
    expect(await d.ledger.findWorker(`w-legacy-${createHash('sha256').update('none').digest('hex').slice(0, 32)}`)).toBeUndefined()
    let importEventCount = 0
    for (const { worker } of importedWorkers) {
      const events = await new WorkerEventLog(join(f.agent, 'workers', worker.worker_id)).readAll()
      importEventCount += events.filter((event) => event.kind === 'legacy_imported').length
    }
    expect(importEventCount).toBe(12)
    expect(await fs.readFile(join(f.admin, 'tasks.json'), 'utf8')).toBe(sourceBefore); expect(await fs.readFile(join(f.traces, 'traces-2026-01-01.jsonl'), 'utf8')).toBe(traceBefore)
    expect(createHash('sha256').update(await fs.readFile(oldRunningPath)).digest('hex')).toBe(oldRunningHash)
  })

  it('in_progress detects task and selected trace changes; completed does zero source scans or writes', async () => {
    const f = await fixture([task('one')]); const d = deps(f)
    await importV2LegacyTasks(d)
    const marker = join(f.agent, 'migrations', 'v2-legacy-import-v1.json'); const completed = await fs.readFile(marker, 'utf8')
    await fs.rm(f.admin, { recursive: true })
    await fs.rm(f.traces, { recursive: true })
    expect(await importV2LegacyTasks(d)).toEqual({ skipped: true, imported: 0 })
    expect(await fs.readFile(marker, 'utf8')).toBe(completed)
    const second = await fixture([task('two')]); const secondDeps = deps(second)
    const markerPath = join(second.agent, 'migrations', 'v2-legacy-import-v1.json'); await fs.mkdir(join(second.agent, 'migrations'), { recursive: true })
    await fs.writeFile(markerPath, JSON.stringify({ version: 1, state: 'in_progress', imported_at: '2026-08-10T00:00:00.000Z', fingerprint: 'absent', manifest: [] }))
    await expect(importV2LegacyTasks(secondDeps)).rejects.toThrow('source changed')
  })

  it('rejects duplicate task IDs, unknown statuses, invalid created_at and corrupt completed markers', async () => {
    const duplicate = await fixture([task('same'), task('same')])
    await expect(importV2LegacyTasks(deps(duplicate))).rejects.toThrow('duplicate task id')
    const unknown = await fixture([task('unknown', { status: 'mystery' })])
    await expect(importV2LegacyTasks(deps(unknown))).rejects.toThrow('invalid required task fields')
    const badTime = await fixture([task('bad-time', { created_at: '2026-01-01' })])
    await expect(importV2LegacyTasks(deps(badTime))).rejects.toThrow('invalid required task fields')
    const corrupt = await fixture([task('one')]); const marker = join(corrupt.agent, 'migrations', 'v2-legacy-import-v1.json')
    await fs.mkdir(join(corrupt.agent, 'migrations'), { recursive: true })
    await fs.writeFile(marker, JSON.stringify({ version: 1, state: 'completed', imported_at: '2026-08-10T00:00:00.000Z', fingerprint: 'absent', manifest: [], source_task_count: 1, imported_count: 1, by_manager_key: { 'admin-web::system-tasks': 1 } }))
    await expect(importV2LegacyTasks(deps(corrupt))).rejects.toThrow('invalid migration marker')
  })

  it('retries after a crash without duplicate events and preserves cancelled completion time', async () => {
    const f = await fixture([task('cancel', { status: 'cancelled', completed_at: '2026-01-01T02:00:00.000Z' })])
    let crashed = false
    await expect(importV2LegacyTasks({ ...deps(f), afterWorkerImported: () => { if (!crashed) { crashed = true; throw new Error('crash') } } })).rejects.toThrow('crash')
    const secondPass = {
      ...deps(f),
      now: () => '2026-08-11T00:00:00.000Z',
    }
    await expect(importV2LegacyTasks(secondPass)).resolves.toMatchObject({ imported: 0 })
    const id = `w-legacy-${createHash('sha256').update('cancel').digest('hex').slice(0, 32)}`
    const worker = await deps(f).ledger.findWorker(id)
    expect(worker?.worker.task).toMatchObject({ status: 'cancelled', completed_at: '2026-01-01T02:00:00.000Z' })
    const events = (await new WorkerEventLog(join(f.agent, 'workers', id)).readAll()).filter(event => event.kind === 'legacy_imported')
    expect(events).toEqual([expect.objectContaining({ ts: '2026-08-10T00:00:00.000Z', detail: { admin_task_id: 'cancel', trace_count: 0, imported_at: '2026-08-10T00:00:00.000Z' } })])
  })

  it('in_progress rejects task changes and selected trace content, removal, or corruption', async () => {
    async function interruptedFixture(): Promise<{
      f: Awaited<ReturnType<typeof fixture>>
      tracePath: string
      originalTrace: Record<string, unknown>
    }> {
      const f = await fixture([task('source')])
      const tracePath = join(f.traces, 'traces-2026-01-01.jsonl')
      const originalTrace = {
        trace_id: 'selected',
        related_task_id: 'source',
        started_at: '2026-01-01T00:00:00.000Z',
        outcome: { summary: 'original' },
      }
      await fs.writeFile(tracePath, `${JSON.stringify(originalTrace)}\n`)
      await expect(importV2LegacyTasks({
        ...deps(f),
        afterWorkerImported: () => { throw new Error('interrupt') },
      })).rejects.toThrow('interrupt')
      return { f, tracePath, originalTrace }
    }

    const changedTask = await interruptedFixture()
    await fs.writeFile(join(changedTask.f.admin, 'tasks.json'), JSON.stringify([
      task('source', { title: 'changed title' }),
    ]))
    await expect(importV2LegacyTasks(deps(changedTask.f))).rejects.toThrow('source changed')

    const changedTrace = await interruptedFixture()
    await fs.writeFile(changedTrace.tracePath, `${JSON.stringify({
      ...changedTrace.originalTrace,
      outcome: { summary: 'changed' },
    })}\n`)
    await expect(importV2LegacyTasks(deps(changedTrace.f))).rejects.toThrow('source changed')

    const missingTrace = await interruptedFixture()
    await fs.rm(missingTrace.tracePath)
    await expect(importV2LegacyTasks(deps(missingTrace.f))).rejects.toThrow('source changed')

    const corruptTrace = await interruptedFixture()
    await fs.writeFile(corruptTrace.tracePath, 'not-json\n')
    await expect(importV2LegacyTasks(deps(corruptTrace.f))).rejects.toThrow('source changed')
  })

  it('chooses the earliest trace start and the independently latest trace end', async () => {
    const f = await fixture([task('timeline', { result: { outcome_brief: 'done' } })])
    const traces = [
      {
        trace_id: 'early-start-late-end', related_task_id: 'timeline',
        started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T04:00:00.000Z',
      },
      {
        trace_id: 'late-start-early-end', related_task_id: 'timeline',
        started_at: '2026-01-01T01:00:00.000Z', ended_at: '2026-01-01T02:00:00.000Z',
      },
    ]
    await fs.writeFile(
      join(f.traces, 'traces-2026-01-01.jsonl'),
      traces.map((trace) => JSON.stringify(trace)).join('\n') + '\n',
    )

    const d = deps(f)
    await importV2LegacyTasks(d)
    const workerId = `w-legacy-${createHash('sha256').update('timeline').digest('hex').slice(0, 32)}`
    const worker = (await d.ledger.findWorker(workerId))!.worker
    expect(worker.incarnations[0]).toMatchObject({
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T04:00:00.000Z',
    })
    expect(worker.task.completed_at).toBe('2026-01-01T04:00:00.000Z')
  })

  it('uses the latest same-task trace, skips v3/malformed input, and rejects cross-task trace IDs', async () => {
    const f = await fixture()
    const old = { trace_id: 'same', related_task_id: 'one', started_at: '2026-01-01T00:00:00.000Z', outcome: { summary: 'old' } }
    const latest = { ...old, outcome: { summary: 'latest' } }
    await fs.writeFile(join(f.traces, 'traces-2026-01-01.jsonl'), `${JSON.stringify(old)}\nnot-json\n${JSON.stringify(latest)}\n`)
    await fs.writeFile(join(f.traces, 'traces-running.jsonl'), JSON.stringify({ ...old, outcome: { summary: 'global' } }) + '\n')
    await fs.writeFile(join(f.traces, 'traces-running-one.jsonl'), JSON.stringify({ ...old, outcome: { summary: 'checkpoint' } }) + '\n')
    await fs.writeFile(join(f.traces, 'traces-running-v3.jsonl'), JSON.stringify({ trace_id: 'v3', related_task_id: 'one' }) + '\n')
    const traces = await readLegacyTraces(f.traces)
    expect(traces.get('one')?.map(trace => trace.trace_id)).toEqual(['same'])
    expect(traces.get('one')?.[0].outcome?.summary).toBe('checkpoint')
    await fs.writeFile(join(f.traces, 'traces-running-other.jsonl'), JSON.stringify({ trace_id: 'same', related_task_id: 'two' }) + '\n')
    await expect(readLegacyTraces(f.traces)).rejects.toThrow('belongs to both')
  })
})
