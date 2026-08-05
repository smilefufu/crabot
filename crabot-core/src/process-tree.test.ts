import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessTreeAlive, terminateProcessTree } from './process-tree.js'

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'uv-python-sleeper.py')
const children: ChildProcess[] = []
const tempDirs: string[] = []

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for fixture')
}

async function startFixture(ignoreTerm = false): Promise<{
  child: ChildProcess
  pythonPid: number
  processGroup: number
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-process-tree-'))
  tempDirs.push(dir)
  const pidFile = path.join(dir, 'python.json')
  const child = spawn('uv', [
    'run', '--no-project', 'python', fixture, pidFile,
    ...(ignoreTerm ? ['ignore-term'] : []),
  ], {
    detached: true,
    stdio: 'ignore',
  })
  children.push(child)

  const info = await waitFor(async () => {
    try {
      return JSON.parse(await fs.readFile(pidFile, 'utf8')) as { pid: number; pgid: number }
    } catch {
      return undefined
    }
  })
  expect(child.pid).toBeDefined()
  expect(info.pgid).toBe(child.pid)
  return { child, pythonPid: info.pid, processGroup: info.pgid }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && isProcessTreeAlive(child.pid)) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('POSIX process-tree termination', () => {
  it('gracefully removes the real uv -> python tree', async () => {
    const { child, pythonPid, processGroup } = await startFixture()
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))

    await terminateProcessTree(processGroup, { gracefulTimeoutMs: 1000 })
    await exited

    expect(isProcessTreeAlive(processGroup)).toBe(false)
    expect(pidAlive(pythonPid)).toBe(false)
  })

  it('escalates to SIGKILL and confirms an ignoring descendant is gone', async () => {
    const { child, pythonPid, processGroup } = await startFixture(true)
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))

    await terminateProcessTree(processGroup, { gracefulTimeoutMs: 100 })
    await exited

    expect(isProcessTreeAlive(processGroup)).toBe(false)
    expect(pidAlive(pythonPid)).toBe(false)
  })
})
