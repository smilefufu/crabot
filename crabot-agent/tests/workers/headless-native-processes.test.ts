import { expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { captureHeadlessNativeProcesses } from '../../src/workers/headless-native-processes.js'

for (const mode of ['code', 'signal'] as const) it('observes actual child ' + mode + ' exit only in the qualified context', async () => {
  const child = spawn(process.execPath, ['-e', 'process.send("ready");process.on("message",()=>process.exit(0));setTimeout(()=>process.exit(0),30000)'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const ended = once(child, 'exit')
  try {
    await once(child, 'message')
    expect(captureHeadlessNativeProcesses(child, true)).toMatchObject([{ pid: child.pid, parent: process.pid }])
    if (mode === 'code') child.send('end')
    else child.kill('SIGTERM')
    await ended
    expect(captureHeadlessNativeProcesses(child, true)).toEqual({ carrier_exited: true })
    expect(Object.isFrozen(captureHeadlessNativeProcesses(child, true))).toBe(true)
    expect(() => captureHeadlessNativeProcesses(child)).toThrow()
    expect(() => captureHeadlessNativeProcesses(child, false as any)).toThrow()
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended }
})
for (const fake of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: 'SIGTERM' }, {}]) it('refuses a structural exit assertion without an actual child: ' + JSON.stringify(fake), () => {
  expect(() => captureHeadlessNativeProcesses({ pid: process.pid, ...fake } as ChildProcess, true)).toThrow()
})
it('does not treat a failed spawn without a generated PID as an exited carrier', async () => {
  const child = spawn(join(tmpdir(), 'absent-crabot-child-' + randomUUID()), [], { stdio: 'ignore' })
  await once(child, 'error')
  expect(child.pid).toBeUndefined()
  expect(() => captureHeadlessNativeProcesses(child, true)).toThrow()
})
