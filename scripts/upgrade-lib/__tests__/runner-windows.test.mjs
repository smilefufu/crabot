import { it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('../../lib/memory-deps.mjs', () => ({ preparedMemoryPython: vi.fn() }))
import { spawn } from 'node:child_process'
import { preparedMemoryPython } from '../../lib/memory-deps.mjs'
import { runScript } from '../runner.mjs'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.resetAllMocks() })
it('prepared Windows Python is an executable argv, including spaces and ampersands; no command shell', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const python = 'C:\\Users\\A&B User\\memory\\.venv\\Scripts\\python.exe'
  preparedMemoryPython.mockResolvedValue(python)
  spawn.mockImplementation(() => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    queueMicrotask(() => child.emit('exit', 0))
    return child
  })
  expect((await runScript('/test/crabot-memory/upgrade/from_v4_to_v5.py', 'C:\\Data & Tasks\\memory')).exitCode).toBe(0)
  expect(spawn).toHaveBeenCalledWith(python, ['/test/crabot-memory/upgrade/from_v4_to_v5.py', '--data-dir=C:\\Data & Tasks\\memory'], expect.objectContaining({ cwd: '/test/crabot-memory' }))
  expect(spawn.mock.calls[0][2].shell).toBeUndefined()
})
