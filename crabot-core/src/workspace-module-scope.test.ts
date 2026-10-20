import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import ModuleManager from './index.js'

// Native Windows registry/cleanup queries share the existing finite-process budget.
const nativeTimeout = process.platform === 'win32' ? 30_000 : 5_000

async function fixture() {
  const data = await fs.mkdtemp(path.join(tmpdir(), 'crabot-module-scope-'))
  const script = path.join(data, 'finite-module.cjs')
  await fs.writeFile(script, `if (process.env.FIXTURE_CHILD) {
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(process.env.FIXTURE_CHILD, String(child.pid));
  }
  setInterval(() => {}, 1000)`)
  const manager = new ModuleManager({ port: 0, modules: [], shutdown_timeout: 0.1 }, data) as any
  manager.managementOnly = false
  for (const id of ['admin-web', 'fixture-memory', 'stopped-channel']) manager.modules.set(id, {
    module_id: id, module_type: 'service', entry: `"${process.execPath}" "${script}"`,
    start_priority: 1, auto_start: false, auto_restart: false, skip_health_check: true,
    status: 'stopped', port: id === 'fixture-memory' ? 19802 : 19801,
  })
  const freeze = async () => {
    await fs.mkdir(path.join(data, 'workspace-control'), { recursive: true })
    await fs.writeFile(path.join(data, 'workspace-control/relocation.json'), 'fixture-maintenance')
  }
  const cleanup = async () => {
    for (const child of manager.processes.values()) manager.childStates.get(child).termination = undefined
    await manager.stop(); await fs.rm(data, { recursive: true, force: true })
  }
  return { data, manager, freeze, cleanup }
}
describe('fixed workspace execution module scope', () => {
  it('requires the fence before registry initialization', async () => {
    const f = await fixture(), read = vi.spyOn(f.manager.runtimeRegistry, 'listRecords')
    try {
      await expect(f.manager.captureWorkspaceRelocationModules()).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_MODULE_SCOPE' })
      expect(read).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })
  it('captures owned execution processes and stopped definitions while preserving Admin', async () => {
    const f = await fixture()
    try {
      f.manager.modules.get('fixture-memory').env = { FIXTURE_CHILD: path.join(f.data, 'descendant.pid') }
      await f.manager.startModuleProcess('fixture-memory'); await f.manager.startModuleProcess('admin-web')
      let descendant = 0
      await vi.waitFor(async () => { descendant = Number(await fs.readFile(path.join(f.data, 'descendant.pid'), 'utf8')); expect(descendant).toBeGreaterThan(0) })
      const child = f.manager.processes.get('fixture-memory'), admin = f.manager.processes.get('admin-web')
      const before = await f.manager.runtimeRegistry.listRecords()
      await f.freeze()
      const scope = await f.manager.captureWorkspaceRelocationModules()
      expect(scope.map((item: any) => item.module_id)).toEqual(['fixture-memory', 'stopped-channel'])
      expect(scope[0].processes).toEqual(expect.arrayContaining([expect.objectContaining({ pid: child.pid, parent: process.pid })]))
      expect(scope[0].processes.map((item: any) => item.pid)).toContain(descendant)
      expect(scope[0].runtime_id).toBe(f.manager.childStates.get(child).runtimeId)
      expect(scope[1].processes).toEqual([]); expect(scope[1].runtime_id).toBeUndefined()
      expect(Object.isFrozen(scope) && Object.isFrozen(scope[0]) && Object.isFrozen(scope[0].processes)).toBe(true)
      expect(child.exitCode).toBeNull(); expect(admin.exitCode).toBeNull()
      expect(await f.manager.runtimeRegistry.listRecords()).toEqual(before)
    } finally { await f.cleanup() }
  }, nativeTimeout)
  it('drains previously admitted lifecycle work before fixing the module set', async () => {
    const f = await fixture()
    let release!: () => void
    try {
      const held = new Promise<void>(resolve => { release = resolve })
      void f.manager.enqueueLifecycle('fixture-memory', async () => { await held; f.manager.modules.delete('stopped-channel') })
      await f.freeze()
      let done = false
      const reading = f.manager.captureWorkspaceRelocationModules().then((scope: any) => { done = true; return scope })
      await new Promise(resolve => setTimeout(resolve, 20)); expect(done).toBe(false)
      release(); expect((await reading).map((item: any) => item.module_id)).toEqual(['fixture-memory'])
    } finally { release?.(); await f.cleanup() }
  })
  for (const kind of ['missing record', 'changed record', 'orphan record', 'in-progress stop', 'changed module set', 'changed runtime object', 'lost fence']) {
    it(`refuses unverified scope: ${kind}`, async () => {
      const f = await fixture()
      try {
        await f.manager.startModuleProcess('fixture-memory')
        const child = f.manager.processes.get('fixture-memory'), state = f.manager.childStates.get(child)
        await f.freeze()
        if (kind === 'missing record') await f.manager.runtimeRegistry.removeRuntime(state.runtimeId)
        if (kind === 'in-progress stop') state.termination = Promise.resolve()
        if (kind === 'changed record' || kind === 'orphan record') {
          const file = path.join(f.data, 'module-runtime-registry/records', state.runtimeId + '.json')
          const record = JSON.parse(await fs.readFile(file, 'utf8'))
          if (kind === 'changed record') record.process_start_identity = 'different'
          else record.runtime_id = 'orphan-runtime'
          await fs.writeFile(kind === 'changed record' ? file : path.join(path.dirname(file), 'orphan-runtime.json'), JSON.stringify(record))
        }
        if (kind === 'changed module set' || kind === 'changed runtime object' || kind === 'lost fence') {
          const read = f.manager.runtimeRegistry.listRecords.bind(f.manager.runtimeRegistry)
          vi.spyOn(f.manager.runtimeRegistry, 'listRecords').mockImplementation(async () => {
            const records = await read()
            if (kind === 'changed module set') f.manager.modules.delete('stopped-channel')
            else if (kind === 'changed runtime object') state.runtimeId = 'changed-runtime'
            else await fs.rm(path.join(f.data, 'workspace-control/relocation.json'), { force: true })
            return records
          })
        }
        await expect(f.manager.captureWorkspaceRelocationModules()).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_MODULE_SCOPE' })
        expect(child.exitCode).toBeNull()
      } finally { await f.cleanup() }
    }, nativeTimeout)
  }
})
