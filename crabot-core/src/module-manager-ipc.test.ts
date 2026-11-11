import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import ModuleManager from './index.js'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const control = require('../../scripts/lib/runtime-control.cjs')
const native = require('../../scripts/lib/process-identity.cjs')
const { openModuleRuntimeRpc } = require('../../scripts/lib/module-runtime-rpc.cjs')

const active: { mm: any; directory: string }[] = []
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Managed IPC fixture timed out')
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { mm, directory } of active.splice(0)) {
    await mm.stop()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
async function start() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-ipc-'))
  const fixture = path.join(directory, 'module.mjs')
  const shared = pathToFileURL(path.resolve('node_modules/crabot-shared/dist/index.js')).href
  await fs.writeFile(fixture, `
    import { ModuleBase } from ${JSON.stringify(shared)}
    class Fixture extends ModuleBase {
      constructor() {
        super({ moduleId: process.env.Crabot_MODULE_ID, moduleType: 'channel', version: '0.1.0', protocolVersion: '0.2.0', port: Number(process.env.Crabot_PORT) })
        this.registerMethod('echo', params => ({ ...params, owner: this.config.moduleId, pid: process.pid }))
        this.registerMethod('forward', params => this.rpcClient.call(params.target, 'echo', params.value, this.config.moduleId))
      }
      async onStart() {}
      async onStop() {}
      createServer() { throw new Error('Managed module opened HTTP') }
    }
    const module = new Fixture()
    await module.start()
    await module.register()
  `)
  const mm = new ModuleManager({ port: 19339, port_range: { range_start: 24001, range_end: 24010 },
    shutdown_timeout: 1, health_check_interval: 3600, modules: ['fixture-a', 'fixture-b'].map(module_id => ({
      module_id, module_type: 'channel', entry: `"${process.execPath}" "${fixture}"`,
      cwd: directory, auto_start: false, start_priority: 1,
    })),
  }, directory, { transport: 'ipc' }) as any
  mm.fixtureDirectory = directory
  active.push({ mm, directory })
  const listener = vi.spyOn(http, 'createServer').mockImplementation(() => { throw new Error('IPC MM opened HTTP') })
  await mm.start()
  expect(listener).not.toHaveBeenCalled()
  listener.mockRestore()
  await mm.handleStartModule({ module_id: 'fixture-a' })
  await mm.handleStartModule({ module_id: 'fixture-b' })
  await waitFor(() => [...mm.modules.values()].every((runtime: any) => runtime.status === 'running') ? true : undefined)
  return mm
}
describe('actual MM managed IPC integration', () => {
  it('pins local control calls to the original runtime and rejects replacement routing', async () => {
    const mm = await start()
    const a = mm.modules.get('fixture-a')
    const connection = await control.openRuntimeControl(mm.fixtureDirectory)
    const runtime = mm.childStates.get(mm.processes.get('fixture-a'))
    const nativeProcess = native.inspectProcess(a.pid)
    const rpc = await openModuleRuntimeRpc(nativeProcess, a.port,
      { instance_id: mm.runtimeRegistry.getInstanceId(), module_id: 'fixture-a', runtime_id: runtime.runtimeId },
      { dataDir: mm.fixtureDirectory, timeoutMs: 1000 })
    try {
      expect(await rpc.call('echo', { text: 'pinned' })).toMatchObject({ text: 'pinned', pid: a.pid })
      expect(await connection.call({ target: a.port, source: 'fixture', method: 'echo', params: {} })).toMatchObject({ pid: a.pid })
      await mm.stopModuleProcess('fixture-a', 'shutdown')
      await mm.handleStartModule({ module_id: 'fixture-a' })
      await waitFor(() => a.status === 'running' ? true : undefined)
      await expect(rpc.call('echo', {})).rejects.toMatchObject({ code: 'CRABOT_PROCESS_RPC' })
      await expect(connection.call({ target: a.port, source: 'fixture', method: 'echo', params: {} })).rejects.toMatchObject({ code: 'STALE_INSTANCE' })
      expect(await mm.sendToModule(a.port, 'echo', {})).toMatchObject({ pid: a.pid })
    } finally { rpc.close(); connection.close() }
  })

  it('starts, registers, routes between children and checks real health with no internal HTTP', async () => {
    const mm = await start()
    const a = mm.modules.get('fixture-a')
    const b = mm.modules.get('fixture-b')
    expect(await mm.sendToModule(a.port, 'forward', { target: b.port, value: { text: 'hello', number: 321n } })).toEqual({ text: 'hello', number: 321n, owner: 'fixture-b', pid: b.pid })
    expect(await mm.sendToModule(a.port, 'health', {})).toMatchObject({ status: 'healthy' })
    expect(mm.server).toBeNull()
  })
  it('stops one exact child, preserves the other and routes restart to its new process', async () => {
    const mm = await start()
    const a = mm.modules.get('fixture-a')
    const b = mm.modules.get('fixture-b')
    const old = mm.processes.get('fixture-a')
    const oldPid = a.pid
    await mm.stopModuleProcess('fixture-a', 'shutdown')
    expect(a.status).toBe('stopped')
    expect(old.exitCode).toBe(0)
    expect(await mm.sendToModule(b.port, 'health', {})).toMatchObject({ status: 'healthy' })
    await mm.handleStartModule({ module_id: 'fixture-a' })
    await waitFor(() => a.status === 'running' ? true : undefined)
    expect(a.pid).not.toBe(oldPid)
    expect(await mm.sendToModule(a.port, 'echo', {})).toEqual({ owner: 'fixture-a', pid: a.pid })
    await expect(mm.runtimePeers.get(old).call({ target: a.port, source: 'test', method: 'health', params: {} })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
})
