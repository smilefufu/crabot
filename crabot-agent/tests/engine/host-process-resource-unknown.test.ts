import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', () => calls)
vi.mock('../../src/core/runtime-env', () => ({ buildChildEnv: () => ({}) }))
vi.mock('../../src/core/data-paths', () => ({ getDataRootDir: () => '/fixture/data' }))
vi.mock('crabot-shared', () => ({ assertWorkspaceExecutionAllowed: () => {} }))
import * as resources from '../../src/engine/tool-resource-scope'
import { runHostProcess } from '../../src/engine/host-process'

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
it('returns unknown when a protected tree cannot be reaped, even without a child close event; does not replay', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  calls.spawn.mockReturnValue(child)
  vi.spyOn(resources, 'toolScopeForChild').mockReturnValue({ id: 'fixture' } as resources.ToolResourceScope)
  vi.spyOn(resources, 'stopResourceScope').mockResolvedValue({ status: 'unknown', exit_code: null, signal: null,
    memory_events: {}, pids_events: {}, memory_peak_bytes: null, cleanup: 'unknown', message: 'Group remains populated; partial side effects unknown' })
  const result = await runHostProcess({ argv: ['fixture'], limits: { timeoutMs: 5, stdoutBytes: 4096, stderrBytes: 4096 } })
  expect(result).toMatchObject({ kind: 'resource_limit', resources: { cleanup: 'unknown' }, message: expect.stringContaining('unknown') })
  expect(calls.spawn).toHaveBeenCalledTimes(1)
  expect(calls.execFile).not.toHaveBeenCalled()
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
})
