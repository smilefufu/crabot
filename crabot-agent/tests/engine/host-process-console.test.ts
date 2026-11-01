import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
const calls = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn((_file, _args, _options, callback) => callback(null, '', '')) }))
vi.mock('node:child_process', () => calls)
vi.mock('../../src/core/runtime-env', () => ({ buildChildEnv: () => ({ TASK_ENV: 'preserved' }) }))
vi.mock('../../src/core/data-paths', () => ({ getDataRootDir: () => '/fixture/data' }))
vi.mock('crabot-shared', () => ({ assertWorkspaceExecutionAllowed: () => {} }))
import { launchHostProcess, terminateHostProcessTree, terminateHostProcessTreeAndWait } from '../../src/engine/host-process'
const original = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', original); vi.clearAllMocks() })
it('background host tools request no Windows console while preserving argv, cwd, pipes and environment', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  calls.spawn.mockReturnValue(new EventEmitter())
  launchHostProcess({ argv: ['powershell.exe', '-NonInteractive', '-Command', 'test'], cwd: '/fixture/project' })
  expect(calls.spawn).toHaveBeenCalledWith('powershell.exe', ['-NonInteractive', '-Command', 'test'], {
    cwd: '/fixture/project', env: { TASK_ENV: 'preserved' }, stdio: ['pipe', 'pipe', 'pipe'], detached: false, windowsHide: true,
  })
})
it('Windows controlled-tree termination does not create a taskkill terminal', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  terminateHostProcessTree(123)
  await terminateHostProcessTreeAndWait(456)
  for (const call of calls.execFile.mock.calls) expect(call[2]).toEqual({ env: { TASK_ENV: 'preserved' }, windowsHide: true })
  expect(calls.execFile).toHaveBeenCalledTimes(2)
})
