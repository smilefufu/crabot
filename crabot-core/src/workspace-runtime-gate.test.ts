import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'
import { spawn } from 'node:child_process'

const native = require('../../scripts/lib/process-identity.cjs')

describe('fixed idle workspace runtime gate', () => {
  it('exits its unregistered idle carrier after the actual parent process dies', async () => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-gate-parent-')), script = path.join(data, 'finite-parent.cjs')
    const helper = path.resolve('../scripts/lib/workspace-runtime-gate.mjs'), identity = path.resolve('../scripts/lib/process-identity.cjs')
    await fs.writeFile(script, `const gate=require(${JSON.stringify(helper)}).createWorkspaceRuntimeGate();gate.ready().then(()=>process.send(require(${JSON.stringify(identity)}).inspectProcess(gate.child.pid))).catch(()=>process.exit(1));setTimeout(()=>process.exit(1),10000).unref()`)
    const parent = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), exited = once(parent, 'exit')
    let root: any
    try {
      const received = await Promise.race([once(parent, 'message'), exited.then(() => { throw new Error('Finite parent exited before idle gate readiness') })])
      root = received[0]
      expect(root.parent).toBe(parent.pid)
      expect(native.sameProcess(root, native.inspectProcess(root.pid))).toBe(true)
      const actualParent = native.inspectProcess(parent.pid)
      expect(actualParent.parent).toBe(process.pid)
      parent.kill('SIGKILL'); await exited
      await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([root]).state).toBe('stopped'), { timeout: 10000 })
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
      await exited
      if (root && native.sameProcess(root, native.inspectProcess(root.pid))) native.terminateKnownProcess(root)
      await fs.rm(data, { recursive: true, force: true })
    }
  }, process.platform === 'win32' ? 60000 : 15000)

  it.each(['disconnect', 'unknown message', 'missing receipt', 'loader isolation'])('does not run a business program before durable registration: %s', async mode => {
    const { createWorkspaceRuntimeGate } = require('../../scripts/lib/workspace-runtime-gate.mjs')
    const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-gate-')), marker = path.join(data, 'must-not-run')
    const oldOptions = process.env.NODE_OPTIONS
    let gate: any
    try {
      if (mode === 'loader isolation') {
        const loader = path.join(data, 'inherited.cjs')
        await fs.writeFile(loader, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe preload')`)
        process.env.NODE_OPTIONS = '--require ' + loader
      }
      try { gate = createWorkspaceRuntimeGate() }
      finally { if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions }
      const exited = once(gate.child, 'exit')
      const ready = await gate.ready()
      expect(ready).toEqual({ nonce: expect.stringMatching(/^[a-f0-9-]{36}$/) })
      const root = native.inspectProcess(gate.child.pid)
      expect(root.parent).toBe(process.pid)
      expect(root.executable).toBe(native.inspectProcess(process.pid).executable)
      if (mode === 'unknown message') gate.child.send({ kind: 'run', command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`] })
      else if (mode === 'missing receipt') {
        await expect(gate.start({ dataDir: data, recoveryId: '00000000-0000-4000-8000-000000000000', moduleId: 'crabot-agent', recordHash: '0'.repeat(64),
          invocation: { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`], cwd: data, env: {} },
          verify: async () => {}, assertCurrent: () => {} })).rejects.toBeDefined()
        gate.close()
      } else gate.close()
      await exited
      expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([root]).state).toBe('stopped')
      await expect(fs.lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      gate?.close()
      if (gate?.child.exitCode === null && gate?.child.signalCode === null) { const exited = once(gate.child, 'exit'); gate.child.kill('SIGTERM'); await exited }
      await fs.rm(data, { recursive: true, force: true })
    }
  }, process.platform === 'win32' ? 60000 : 15000)
})
