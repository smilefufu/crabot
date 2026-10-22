import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { terminateProcessTree } from './process-tree.js'

afterEach(() => vi.restoreAllMocks())

const failure = (code: string) => Object.assign(new Error(code), { code })

describe.skipIf(process.platform === 'win32')('POSIX group signal and exit race', () => {
  it.each([false, true])('confirms the same group disappeared after a denied signal without resubmission (force=%s)', async forceImmediately => {
    const root = 2147000000, denied = failure('EPERM')
    let gone = false
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-root)
      if (gone) throw failure('ESRCH')
      if (signal === 0) return true
      setImmediate(() => { gone = true })
      throw denied
    })
    await expect(terminateProcessTree(root, { gracefulTimeoutMs: 0, pollIntervalMs: 5, forceImmediately })).resolves.toBeUndefined()
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[-root, forceImmediately ? 'SIGKILL' : 'SIGTERM']])
  })

  it.each([false, true])('keeps a persistent permission denial and never retries the signal (force=%s)', async forceImmediately => {
    const root = 2147000000, denied = failure('EPERM')
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-root)
      if (signal === 0) throw failure('EPERM')
      throw denied
    })
    await expect(terminateProcessTree(root, { gracefulTimeoutMs: 0, pollIntervalMs: 5, forceImmediately })).rejects.toBe(denied)
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[-root, forceImmediately ? 'SIGKILL' : 'SIGTERM']])
  })

  it.each(['initial probe', 'after denied signal'])('never turns an unknown %s into confirmed exit', async stage => {
    const root = 2147000000, unknown = failure('EIO')
    let signalled = false
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-root)
      if (signal === 0) {
        if (stage === 'initial probe' || signalled) throw unknown
        return true
      }
      signalled = true
      throw failure('EPERM')
    })
    await expect(terminateProcessTree(root, { gracefulTimeoutMs: 0 })).rejects.toBe(unknown)
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toHaveLength(stage === 'initial probe' ? 0 : 1)
  })

  it.skipIf(process.platform !== 'darwin')('reaps its actual zombie root before confirming the detached group exited', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 20)'], { detached: true, stdio: 'ignore' })
    const exited = once(child, 'exit')
    await once(child, 'spawn')
    try {
      // Hold this parent event loop so the finite child can exit but cannot be reaped yet.
      const deadline = Date.now() + 5000, pause = new Int32Array(new SharedArrayBuffer(4))
      let code: string | undefined
      do {
        Atomics.wait(pause, 0, 0, 10)
        try { process.kill(-child.pid!, 0) } catch (error) { code = (error as NodeJS.ErrnoException).code }
      } while (code !== 'EPERM' && Date.now() < deadline)
      expect(code).toBe('EPERM')
      await terminateProcessTree(child.pid!, { gracefulTimeoutMs: 0 })
      await exited
      expect(() => process.kill(-child.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
    } finally { await exited }
  })
})
