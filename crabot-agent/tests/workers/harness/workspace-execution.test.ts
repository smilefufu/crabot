import { expect, it, vi } from 'vitest'
import type { LedgerWorker } from '../../../src/workers/harness/ledger-types.js'
import type { WorkerExecutionObservation } from '../../../src/workers/types.js'
import { projectWorkspaceExecution } from '../../../src/workers/harness/workspace-execution.js'
const project = '12345678-1234-4123-8123-123456789abc'
const worker = (id: string, workspace_id?: string) => ({ worker_id: id, workspace_id } as LedgerWorker)
const idle = (): WorkerExecutionObservation => ({ observed_at: '2026-10-19T00:00:00.000Z', state: 'idle', reasons: [], active_subagents: [], active_background: [], notification_pending: false, unavailable_reasons: [] })
it('uses all stable project bindings, including closed workers, without inferring legacy titles or paths', async () => {
  const read = vi.fn(async () => idle())
  const result = await projectWorkspaceExecution([worker('a', project), worker('b', project), worker('c', 'default'), worker('legacy')], read)
  expect(result[project]).toMatchObject({ status: 'idle', worker_count: 2, running_worker_count: 0 })
  expect(result.default).toMatchObject({ worker_count: 1 })
  expect(Object.keys(result).sort()).toEqual(['default', project].sort())
  expect(read).toHaveBeenCalledTimes(3)
})
it.each(['fork_running', 'mainline_running'] as const)('a known %s keeps a workspace running even if the main task is idle', async reason => {
  const result = await projectWorkspaceExecution([worker('a', project)], async () => ({ ...idle(), state: 'running', reasons: [reason] }))
  expect(result[project]).toMatchObject({ status: 'running', running_worker_count: 1 })
})
it('background shells and native children matter; queued inputs and notifications alone are not running file users', async () => {
  const queued = { ...idle(), state: 'running' as const, reasons: ['queued', 'notification_pending'] as WorkerExecutionObservation['reasons'], notification_pending: true }
  expect((await projectWorkspaceExecution([worker('a', project)], async () => queued))[project].status).toBe('idle')
  const shell = { ...idle(), reasons: ['background_running'] as WorkerExecutionObservation['reasons'], active_background: [{ entity_id: 'shell', status: 'running' as const }] }
  expect((await projectWorkspaceExecution([worker('a', project)], async () => shell))[project].status).toBe('running')
  const stalled = { ...shell, active_background: [{ entity_id: 'shell', status: 'stalled' as const }] }
  expect((await projectWorkspaceExecution([worker('a', project)], async () => stalled))[project].status).toBe('unknown')
})
it('partial evidence never fabricates an exact running count or idle, and readers remain bounded', async () => {
  let active = 0, peak = 0
  const result = await projectWorkspaceExecution(Array.from({ length: 12 }, (_, index) => worker(String(index), project)), async id => {
    active++; peak = Math.max(active, peak); await new Promise(resolve => setTimeout(resolve, 2)); active--
    if (id === '1') throw new Error('unavailable')
    return id === '0' ? { ...idle(), reasons: ['mainline_running'] } : idle()
  })
  expect(result[project]).toMatchObject({ status: 'running', worker_count: 12 })
  expect(result[project].running_worker_count).toBeUndefined()
  expect(peak).toBeLessThanOrEqual(4)
  const unknown = await projectWorkspaceExecution([worker('a', project)], async () => ({ ...idle(), unavailable_reasons: ['subagents_require_explicit_read'] }))
  expect(unknown[project]).toMatchObject({ status: 'unknown', worker_count: 1 })
})
