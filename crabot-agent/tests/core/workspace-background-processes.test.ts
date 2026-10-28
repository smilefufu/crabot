import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
import { spawnPersistentShell, runShellWithGrace, killShellTree } from '../../src/engine/bg-entities/bg-shell.js'
import { stopTrackedTestShells } from './fixtures/owned-shell-cleanup.js'
import type { BgShellRegistryRecord } from '../../src/engine/bg-entities/types.js'

const native = require('../../../scripts/lib/process-identity.cjs')
const owner = { friend_id: 'original-friend', worker_id: 'original-worker', incarnation_id: 'original-incarnation' }
let data: string, registry: BgEntityRegistry, file: string
const exits: Promise<void>[] = []
const failed = { code: 'WORKSPACE_MAINTENANCE' }
beforeEach(async () => {
  data = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'workspace-bg-native-')))
  vi.stubEnv('DATA_DIR', data); vi.stubEnv('CRABOT_AGENT_DATA_DIR', path.join(data, 'agent'))
  file = path.join(data, 'registry.json'); registry = new BgEntityRegistry(file)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await stopTrackedTestShells(registry)
  try { await Promise.all(exits.splice(0)) }
  finally { vi.unstubAllEnvs(); await fs.rm(data, { recursive: true, force: true }) }
})
async function start(kind = 'persistent', command = `"${process.execPath}" -e 'setTimeout(()=>{},30000)'`) {
  let exited!: () => void
  const exit = new Promise<void>(resolve => { exited = resolve })
  const options = { command, cwd: data, owner, spawned_by_task_id: 'original-task', registry, onExit: exited, onShellExit: exited }
  const result = kind === 'persistent' ? await spawnPersistentShell(options) : await runShellWithGrace({ ...options, gracePeriodMs: 10 })
  const id = typeof result === 'string' ? result : result.kind === 'background' ? result.entity_id : ''
  const record = await registry.get(id) as BgShellRegistryRecord
  if (record) exits.push(exit)
  return record
}
async function capture(target = registry): Promise<ReadonlyArray<any>> {
  return (target as any).captureWorkspaceShellProcesses()
}
describe('registered background Shell native scope', () => {
  it.each(['persistent', ...Array<string>(process.platform === 'win32' ? 8 : 1).fill('grace')])('observes the actual %s tree without signals or registry mutation', async kind => {
    const marker = path.join(data, 'payload-ready'), script = path.join(data, 'ready-payload.cjs')
    await fs.writeFile(script, "require('node:fs').writeFileSync(process.argv[2],String(process.pid));setTimeout(()=>{},30000)")
    const record = await start(kind, `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}" "${marker.replaceAll('\\', '/')}"`)
    let payload: any
    await vi.waitFor(async () => { payload = native.inspectProcess(Number(await fs.readFile(marker, 'utf8'))); expect(payload).not.toBeNull() }, { timeout: 4000 })
    const before = await fs.readFile(file), signal = vi.spyOn(native, 'terminateKnownProcess')
    const scope = await capture()
    expect(scope).toContainEqual(expect.objectContaining({ pid: payload.pid, started: payload.started, owner: payload.owner }))
    expect(scope).toEqual(expect.arrayContaining([expect.objectContaining({ pid: record.pid, owner: native.inspectProcess(process.pid).owner })]))
    expect(scope.every(item => Object.keys(item).sort().join(',') === 'executable,owner,parent,pid,started')).toBe(true)
    expect(await fs.readFile(file)).toEqual(before); expect(signal).not.toHaveBeenCalled()
    expect(await registry.get(record.entity_id)).toMatchObject({ owner, spawned_by_task_id: 'original-task', status: 'running' })
  })
  it('retains an observed child that exits during registry readback without treating it as a live root', async () => {
    const marker = path.join(data, 'child.pid'), script = path.join(data, 'parent.cjs')
    await fs.writeFile(script, `const {spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[2],String(child.pid));setTimeout(()=>{},30000);`)
    const record = await start('persistent', `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}" "${marker.replaceAll('\\', '/')}"`)
    let child: any
    await vi.waitFor(async () => { child = native.inspectProcess(Number(await fs.readFile(marker, 'utf8'))); expect(child).not.toBeNull() }, { timeout: 4000 })
    const before = await fs.readFile(file), read = (registry as any).readFile.bind(registry)
    let reads = 0, interrupted = false
    vi.spyOn(registry as any, 'readFile').mockImplementation(async () => {
      const value = await read()
      if (++reads === 2) {
        interrupted = true; native.terminateKnownProcess(child)
        await vi.waitFor(() => expect(native.isProcessExited(child.pid)).toBe(true))
      }
      return value
    })
    const scope = await capture()
    expect(interrupted).toBe(true)
    expect(scope).toContainEqual(expect.objectContaining({ pid: child.pid, started: child.started, owner: child.owner }))
    expect(scope).toContainEqual(expect.objectContaining({ pid: record.pid }))
    expect(native.isProcessExited(child.pid)).toBe(true)
    expect(await fs.readFile(file)).toEqual(before)
  })
  it('does not treat a completed registry status as actual process exit', async () => {
    const record = await start(); await registry.update(record.entity_id, { status: 'completed', ended_at: new Date().toISOString() })
    expect(await capture()).toEqual(expect.arrayContaining([expect.objectContaining({ pid: record.pid })]))
  })
  it('accepts a real current child exit even if ordinary exit-status persistence is delayed', async () => {
    await start('persistent', 'exit 0')
    await vi.waitFor(async () => expect((await registry.list())[0].status).toBe('completed'))
    const before = await fs.readFile(file)
    expect(await capture()).toEqual([]); expect(await fs.readFile(file)).toEqual(before)
  })
  it('releases the actual ChildProcess after observed exit and drops its small fact with normal registry cleanup', async () => {
    const record = await start('persistent', 'exit 0')
    await vi.waitFor(async () => expect((await registry.get(record.entity_id))?.status).toBe('completed'))
    const bindings = (registry as any).shellProcesses
    expect(bindings.get(record.entity_id)).toMatchObject({ exited: true, child: undefined })
    await registry.update(record.entity_id, { exit_notification: { status: 'delivered', updated_at: new Date().toISOString(), attempts: 1 } })
    expect(await registry.removeTerminalShellsByTask('original-task')).toEqual([record.entity_id])
    expect(bindings.size).toBe(0); expect(await capture()).toEqual([])
  })
  it('retains a still-live carrier after ordinary cleanup deletes a falsely terminal row, then releases it at actual exit', async () => {
    const record = await start(), bindings = (registry as any).shellProcesses
    await registry.update(record.entity_id, { status: 'completed', exit_notification: { status: 'delivered', updated_at: new Date().toISOString(), attempts: 1 } })
    expect(await registry.removeTerminalShellsByTask('original-task')).toEqual([record.entity_id])
    expect(bindings.size).toBe(1); await expect(capture()).rejects.toMatchObject(failed)
    killShellTree(record.pgid); await exits[0]
    expect(bindings.size).toBe(0); expect(await capture()).toEqual([])
  })
  it('keeps a cold live PID unknown, regardless of the recorded task status or approximate birth time', async () => {
    const record = await start(); await registry.update(record.entity_id, { status: 'completed' })
    const before = await fs.readFile(file), cold = new BgEntityRegistry(file)
    await expect(capture(cold)).rejects.toMatchObject(failed)
    expect(await fs.readFile(file)).toEqual(before)
  })
  it('uses an independent kernel observation for a cold disappeared root without claiming global exit', async () => {
    const record = await start('persistent', 'exit 0')
    await vi.waitFor(() => expect(native.isProcessExited(record.pid)).toBe(true))
    const cold = new BgEntityRegistry(file)
    expect(await capture(cold)).toEqual([])
  })
  it.each(['owner', 'missing', 'malformed', 'array', 'wrong key', 'unknown type'])('rejects changed background evidence: %s', async kind => {
    const record = await start()
    if (kind === 'owner') await registry.update(record.entity_id, { owner: { ...owner, worker_id: 'replacement' } })
    else if (kind === 'missing') await fs.writeFile(file, JSON.stringify({ entities: {} }))
    else if (kind === 'malformed') await fs.writeFile(file, '{broken')
    else if (kind === 'array') await fs.writeFile(file, JSON.stringify({ entities: [record] }))
    else if (kind === 'wrong key') await fs.writeFile(file, JSON.stringify({ entities: { replacement: record } }))
    else await fs.writeFile(file, JSON.stringify({ entities: { [record.entity_id]: { ...record, type: 'unknown' } } }))
    const before = await fs.readFile(file)
    try {
      await expect(capture()).rejects.toMatchObject(failed)
      expect(await fs.readFile(file)).toEqual(before)
    } finally { if (kind !== 'owner') await fs.writeFile(file, JSON.stringify({ entities: { [record.entity_id]: record } })) }
  })
  it('rechecks the stable registry after asynchronous observation while normal status settlement remains allowed', async () => {
    const record = await start(), read = (registry as any).readFile.bind(registry); let count = 0
    vi.spyOn(registry as any, 'readFile').mockImplementation(async () => {
      if (++count === 2) await registry.update(record.entity_id, { owner: { ...owner, worker_id: 'changed while observing' } })
      return read()
    })
    await expect(capture()).rejects.toMatchObject(failed)
  })
})
