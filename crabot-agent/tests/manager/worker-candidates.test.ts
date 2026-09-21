import { describe, expect, it } from 'vitest'

import { selectWorkerView as select, resolveWorkerProjects, type WorkerViewFacts } from '../../src/manager/worker-candidates.js'
import { filterAndPageWorkers } from '../../src/manager/read-model.js'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ManagerWorkboard } from '../../src/manager/workboard-store.js'
import type { LedgerWorker } from '../../src/workers/harness/ledger-types.js'

const board: ManagerWorkboard = {
  manager_key: 'test::session',
  objectives: [{
    objective_id: 'objective-1',
    title: '项目工作',
    completion_criteria: ['done'],
    updated_at: '2026-09-21T00:00:00.000Z',
    work_items: [
      { work_item_id: 'item-a', title: 'A', status: 'in_progress', project_root: '/repo/a', next_action: 'continue', updated_at: '2026-09-21T00:00:00.000Z' },
      { work_item_id: 'item-b', title: 'B', status: 'in_progress', project_root: '/repo/b', next_action: 'continue', updated_at: '2026-09-21T00:00:00.000Z' },
    ],
  }],
  archive: [],
}

function worker(id: string, project: string, haltedAt: string): LedgerWorker {
  return {
    worker_id: id,
    manager_key: 'test::session',
    task: { id: `task-${id}`, title: id, status: 'halted', created_at: haltedAt, halt: { halted_at: haltedAt, halt_reason: 'turn_end' } },
    origin: { trigger_type: 'message' },
    report_to: { channel_id: 'test', session_id: 'session' },
    incarnations: [{
      seq: 1,
      state: 'idle',
      impl: 'builtin',
      workspace: project,
      session_ref: `session-${id}`,
      started_at: haltedAt,
    }],
    updated_at: haltedAt,
  }
}

function selectWorkerView(workers: LedgerWorker[], scope: ManagerWorkboard, override: Partial<WorkerViewFacts> = {}) {
  return select(workers, scope, {
    projects: new Map(['/repo/a', '/repo/b'].map(directory => [directory, { directory }])),
    execution: new Map(workers.map(item => [item.worker_id, item.incarnations.some(inc => inc.state === 'running') ? 'running' : 'idle'])),
    blocked: new Set(),
    ...override,
  })
}

describe('selectWorkerView', () => {
  it('limits candidates independently per deduplicated project', () => {
    const workers = [
      worker('a-1', '/repo/a', '2026-09-21T00:01:00.000Z'),
      worker('a-2', '/repo/a', '2026-09-21T00:02:00.000Z'),
      worker('a-3', '/repo/a', '2026-09-21T00:03:00.000Z'),
      worker('a-4', '/repo/a', '2026-09-21T00:04:00.000Z'),
      worker('b-1', '/repo/b', '2026-09-21T00:01:00.000Z'),
    ]
    const view = selectWorkerView(workers, board)
    expect(view.candidates.map((item) => item.worker_id).sort()).toEqual(['a-2', 'a-3', 'a-4', 'b-1'])
    expect(view.excludedIdle.map((item) => item.worker_id)).toEqual(['a-1'])
  })

  it('keeps a worker executing while a fork is still running', () => {
    const runningFork = worker('forked', '/repo/a', '2026-09-21T00:01:00.000Z')
    runningFork.incarnations.push({
      seq: 2,
      state: 'running',
      impl: 'builtin',
      workspace: '/repo/a',
      session_ref: 'fork',
      started_at: '2026-09-21T00:02:00.000Z',
      forked_from: 1,
    })
    const view = selectWorkerView([runningFork], board)
    expect(view.executing.map((item) => item.worker_id)).toEqual(['forked'])
    expect(view.candidates).toHaveLength(0)
  })

  it('does not guess when project binding is unavailable', () => {
    const unknown = worker('unknown', '/other', '2026-09-21T00:01:00.000Z')
    const view = selectWorkerView([unknown], board)
    expect(view.attention.map((item) => item.worker_id)).toEqual(['unknown'])
    expect(view.excludedIdle).toHaveLength(0)
  })

  it('deduplicates projects across objectives and does not lend unused slots', () => {
    const workers = Array.from({ length: 10 }, (_, index) => worker(`b-${index}`, '/repo/b', `2026-09-21T00:0${index}:00Z`))
    workers.push(worker('a', '/repo/a', '2026-09-21T01:00:00Z'))
    const view = selectWorkerView(workers, { ...board, objectives: [...board.objectives, ...board.objectives] })
    expect(view.projectKeys).toHaveLength(2)
    expect(view.candidates).toHaveLength(4)
  })

  it('ranks missing and invalid halt times last, ignoring audit timestamps', () => {
    const workers = ['invalid', '', '2026-09-21T01:00:00Z', '2026-09-21T02:00:00Z'].map((date, i) => worker(`w-${i}`, '/repo/a', date))
    workers[0].updated_at = '2099-01-01T00:00:00Z'
    const view = selectWorkerView(workers.reverse(), board)
    expect(view.candidates.map(item => item.worker_id).sort()).toEqual(['w-0', 'w-2', 'w-3'])
    expect(view.excludedIdle[0].worker_id).toBe('w-1')
  })

  it('retires known idle projects when no current objectives remain, but protects incomplete scope', () => {
    const workers = [worker('a', '/repo/a', '2026-09-21T01:00:00Z')]
    expect(selectWorkerView(workers, { ...board, objectives: [] }).excludedIdle).toHaveLength(1)
    const incomplete = { ...board, objectives: [{ ...board.objectives[0], work_items: [] }] }
    expect(selectWorkerView(workers, incomplete).attention).toHaveLength(1)
  })

  it('keeps unknown execution and failed stops out of the idle pool', () => {
    const workers = [worker('unknown', '/repo/a', ''), worker('failed', '/repo/a', '')]
    const view = selectWorkerView(workers, board, { execution: new Map([['unknown', 'unknown'], ['failed', 'idle']]), blocked: new Set(['failed']) })
    expect(view.attention).toHaveLength(2)
    expect(view.candidates).toHaveLength(0)
    expect(view.excludedIdle).toHaveLength(0)
  })

  it('does not guess nested non-Git roots', () => {
    const scope = { ...board, objectives: [{ ...board.objectives[0], work_items: board.objectives[0].work_items.map((item, i) => ({ ...item, project_root: i ? '/repo/a/sub' : '/repo/a' })) }] }
    const view = selectWorkerView([worker('ambiguous', '/repo/a/sub', '')], scope, { projects: new Map(['/repo/a', '/repo/a/sub'].map(directory => [directory, { directory }])) })
    expect(view.attention).toHaveLength(1)
  })

  it('Admin filters cannot promote an excluded worker and compatibility counts retain all nonterminal workers', () => {
    const workers = Array.from({ length: 4 }, (_, i) => worker(`a-${i}`, '/repo/a', `2026-09-21T00:0${i}:00Z`))
    const view = selectWorkerView(workers, board)
    const entries = workers.map(item => ({ managerKey: board.manager_key, worker: item }))
    const views = new Map([[board.manager_key, view]])
    expect(filterAndPageWorkers(entries, { q: 'a-0' }, views)).toMatchObject({ items: [], total_active: 1, total_candidates: 0 })
    expect(filterAndPageWorkers(entries, {}, views)).toMatchObject({ total_active: 4, total_candidates: 3, total_running: 0 })
    expect(filterAndPageWorkers(entries, { include_terminal: true }, views).items).toHaveLength(4)
  })

  it('resolves real Git worktrees, symlinks, and subdirectories to one project', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'worker-projects-'))
    try {
      const main = join(root, 'main'), linked = join(root, 'linked'), alias = join(root, 'alias')
      await fs.mkdir(main)
      const git = (...args: string[]) => execFileSync('git', ['-C', main, ...args], { stdio: 'pipe' })
      git('init')
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init')
      git('worktree', 'add', '--detach', linked)
      await fs.symlink(main, alias)
      await fs.mkdir(join(linked, 'sub'))
      const paths = [main, linked, alias, join(linked, 'sub')]
      const workers = paths.map((directory, i) => worker(`w-${i}`, directory, `2026-09-21T00:0${i}:00Z`))
      const scope = { ...board, objectives: [{ ...board.objectives[0], work_items: paths.map((directory, i) => ({ ...board.objectives[0].work_items[0], work_item_id: `i-${i}`, project_root: directory })) }] }
      const projects = await resolveWorkerProjects(workers, scope)
      const view = selectWorkerView(workers, scope, { projects })
      expect(view.projectKeys).toHaveLength(1)
      expect(view.candidates).toHaveLength(3)
      expect(view.excludedIdle.map(item => item.worker_id)).toEqual(['w-0'])
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})
