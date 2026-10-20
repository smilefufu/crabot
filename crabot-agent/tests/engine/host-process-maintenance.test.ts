import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { launchHostProcess, runHostProcess } from '../../src/engine/host-process.js'
import { spawnPersistentShell, runShellWithGrace } from '../../src/engine/bg-entities/bg-shell.js'
import { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'

let data: string
const children: Array<{ child: ChildProcess; closed: Promise<unknown> }> = []
const limits = { timeoutMs: 2000, stdoutBytes: 1024, stderrBytes: 1024, killGraceMs: 25 }
function track(child: ChildProcess) {
  children.push({ child, closed: once(child, 'close') })
  return child
}
async function fence(root = data, record = 'relocation.json') {
  await fs.mkdir(path.join(root, 'workspace-control'), { recursive: true })
  await fs.writeFile(path.join(root, 'workspace-control', record), 'fixed maintenance')
}
beforeEach(async () => {
  data = await fs.mkdtemp(path.join(tmpdir(), 'host-maintenance-'))
  vi.stubEnv('DATA_DIR', data); vi.stubEnv('CRABOT_AGENT_DATA_DIR', path.join(data, 'agent'))
})
afterEach(async () => {
  for (const { child, closed } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  await fs.rm(data, { recursive: true, force: true })
})

describe('local host launches during workspace maintenance', () => {
  it.each(['relocation.json', 'relocation-workers.json', 'relocation-worker-processes.json'])('rejects direct launch before any payload executes: %s', async record => {
    await fence(data, record)
    expect(() => track(launchHostProcess({ argv: [process.execPath, '-e', 'setTimeout(()=>{},30000)'], stdio: 'ignore' })))
      .toThrowError(expect.objectContaining({ code: 'WORKSPACE_MAINTENANCE' }))
  })
  it('returns the existing finite spawn failure without executing a command', async () => {
    const marker = path.join(data, 'must-not-run')
    await fence()
    const result = await runHostProcess({ argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`], limits })
    expect(result).toMatchObject({ kind: 'spawn_error', message: expect.stringContaining('迁移') })
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['original root', 'changed environment'])('rechecks the original instance after asynchronous preparation: %s', async mode => {
    let release!: () => void, admitted!: () => void
    const wait = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { admitted = resolve })
    const marker = path.join(data, 'stdin-must-not-run')
    const result = runHostProcess({ argv: [process.execPath, '-e', `process.stdin.on('data',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran'));process.stdin.on('end',()=>process.exit(0));setTimeout(()=>process.exit(0),30000)`],
      stdin: 'operation', limits, beforeStdin: async child => {
        track(child); admitted(); await wait
        if (mode === 'changed environment') {
          vi.stubEnv('DATA_DIR', path.join(data, 'replacement')); vi.stubEnv('CRABOT_AGENT_DATA_DIR', path.join(data, 'replacement/agent'))
        }
      } })
    try {
      await entered; await fence(); release()
      expect(await result).toMatchObject({ kind: 'spawn_error', message: expect.stringContaining('迁移') })
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { release(); await result }
  })
  it('keeps a previously accepted command when no operation is sent through stdin', async () => {
    let release!: () => void, admitted!: () => void
    const wait = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { admitted = resolve })
    const result = runHostProcess({ argv: [process.execPath, '-e', 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("accepted"))'], limits,
      beforeStdin: async child => { track(child); admitted(); await wait } })
    try {
      await entered; await fence(); release()
      expect(await result).toMatchObject({ kind: 'exit', exitCode: 0, stdout: 'accepted' })
    } finally { release(); await result }
  })
  it('does not stop an existing carrier or block another instance', async () => {
    const child = track(launchHostProcess({ argv: [process.execPath, '-e', 'process.send("ready");setTimeout(()=>{},30000)'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }))
    await once(child, 'message'); await fence(path.join(data, 'other-instance'))
    expect(await runHostProcess({ argv: [process.execPath, '-e', 'process.stdout.write("ok")'], limits })).toMatchObject({ kind: 'exit', exitCode: 0, stdout: 'ok' })
    await fence(); expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull()
  })
  it('rejects persistent and grace shells without commands and closes the parent log handle', async () => {
    const marker = path.join(data, 'shell-must-not-run'), registry = new BgEntityRegistry(path.join(data, 'registry.json'))
    const opened: Array<ReturnType<typeof vi.spyOn>> = [], originalOpen = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]).endsWith('.log')) opened.push(vi.spyOn(handle, 'close'))
      return handle
    })
    await fence()
    const options = { command: `printf ran > ${JSON.stringify(marker)}`, owner: { friend_id: 'original-owner', worker_id: 'original-worker' }, spawned_by_task_id: 'original-task', cwd: data, registry }
    const persistent = spawnPersistentShell(options)
    try { await expect(persistent).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' }) }
    finally {
      const id = await persistent.catch(() => undefined)
      if (id) await vi.waitFor(async () => expect((await registry.get(id))?.ended_at).not.toBeNull())
    }
    expect(await runShellWithGrace({ ...options, gracePeriodMs: 25 })).toMatchObject({ kind: 'spawn_error', message: expect.stringContaining('迁移') })
    expect(opened).toHaveLength(2)
    for (const close of opened) expect(close).toHaveBeenCalledOnce()
    expect(await registry.list()).toEqual([])
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
