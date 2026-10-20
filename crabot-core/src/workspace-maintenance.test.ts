import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import ModuleManager from './index.js'
import { ModuleRuntimeRegistry } from './module-runtime-registry.js'

describe.each(['relocation.json', 'relocation-workers.json', 'relocation-stop-attempt.json', 'relocation-stop-submission.json', 'relocation-modules.json', 'relocation-module-stop-attempt.json', 'relocation-module-processes', 'relocation-module-stop-submission.json'])('workspace maintenance module admission: %s', record => {
  async function fixture() {
    const data = await fs.mkdtemp(path.join(tmpdir(), 'crabot-mm-workspace-gate-'))
    const manager = new ModuleManager({ port: 0, modules: [], hotplug_allowed_types: ['channel'],
      port_range: { range_start: 19800, range_end: 19810 } }, data) as any
    manager.managementOnly = false
    for (const id of ['admin-web', 'crabot-agent', 'memory']) manager.modules.set(id, {
      module_id: id, module_type: id === 'crabot-agent' ? 'agent' : 'service', entry: 'never-spawn',
      start_priority: 1, auto_start: false, status: 'stopped', port: 19801,
    })
    const freeze = async () => {
      await fs.mkdir(path.join(data, 'workspace-control'), { recursive: true })
      await fs.writeFile(path.join(data, 'workspace-control', record), 'fixed-job')
    }
    return { data, manager, freeze, cleanup: async () => { manager.processes.clear(); await manager.stop(); await fs.rm(data, { recursive: true, force: true }) } }
  }


  it('restores only management orphans and retains business runtime evidence during maintenance startup', async () => {
    const f = await fixture(), terminate = vi.fn(async () => undefined)
    const registry = new ModuleRuntimeRegistry(f.data, {
      probeProcessStartIdentity: async pid => 'fixture-birth-' + pid,
      terminateProcessTree: terminate,
      probeRuntimeIdentity: async () => null,
    })
    f.manager.runtimeRegistry = registry
    try {
      await registry.initialize()
      await registry.recordSpawn({ runtimeId: 'fixed-admin', moduleId: 'admin-web', rootPid: 71001, modulePort: 19801 })
      await registry.recordSpawn({ runtimeId: 'fixed-business', moduleId: 'memory', rootPid: 71002, modulePort: 19802 })
      const file = path.join(f.data, 'module-runtime-registry/records/fixed-business.json')
      const before = await fs.readFile(file)
      await f.freeze()
      await f.manager.start()
      expect(f.manager.server.listening).toBe(true)
      expect(terminate.mock.calls.map(call => call[0])).toEqual([71001])
      expect(await fs.readFile(file)).toEqual(before)
      expect((await registry.listRecords()).map(item => item.runtime_id)).toEqual(['fixed-business'])
      expect(f.manager.processes.size).toBe(0)
    } finally { await f.cleanup() }
  })

  it('rejects ordinary business start/restart before queueing but permits Admin and stop requests', async () => {
    const f = await fixture(), enqueue = vi.spyOn(f.manager, 'enqueueLifecycle').mockResolvedValue(undefined)
    try {
      await f.freeze()
      await expect(f.manager.handleStartModule({ module_id: 'memory' })).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      await expect(f.manager.handleRestartModule({ module_id: 'crabot-agent' })).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      expect(enqueue).not.toHaveBeenCalled()
      await expect(f.manager.handleStartModule({ module_id: 'admin-web' })).resolves.toMatchObject({ status: 'accepted' })
      await expect(f.manager.handleStopModule({ module_id: 'memory' })).resolves.toMatchObject({ status: 'accepted' })
      expect(enqueue).toHaveBeenCalledTimes(2)
    } finally { await f.cleanup() }
  })

  it('rechecks a queued start before any schema initialization or child execution', async () => {
    const f = await fixture()
    let queued!: () => Promise<void>
    vi.spyOn(f.manager, 'enqueueLifecycle').mockImplementation((_id: unknown, action: () => Promise<void>) => { queued = action; return Promise.resolve() })
    try {
      await f.manager.handleStartModule({ module_id: 'memory' })
      await f.freeze()
      const before = await fs.readdir(f.data)
      await expect(queued()).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      expect(f.manager.processes.size).toBe(0)
      expect(f.manager.modules.get('memory').status).toBe('stopped')
      expect(await fs.readdir(f.data)).toEqual(before)
    } finally { await f.cleanup() }
  })

  it('defers execution health recovery but keeps Admin management recovery available', async () => {
    const f = await fixture(), enqueue = vi.spyOn(f.manager, 'enqueueLifecycle').mockResolvedValue(undefined)
    try {
      await f.freeze()
      f.manager.scheduleHealthRecovery(f.manager.modules.get('memory'), undefined)
      expect(enqueue).not.toHaveBeenCalled()
      f.manager.scheduleHealthRecovery(f.manager.modules.get('admin-web'), undefined)
      expect(enqueue).toHaveBeenCalledWith('admin-web', expect.any(Function))
      await vi.waitFor(() => expect(f.manager.healthRecoveries.size).toBe(0))
    } finally { await f.cleanup() }
  })

  it('defers automatic execution restart without spending its restart allowance, while Admin may recover', async () => {
    const f = await fixture()
    try {
      await f.freeze()
      const memory = f.manager.modules.get('memory'), admin = f.manager.modules.get('admin-web')
      memory.auto_restart = admin.auto_restart = true
      await f.manager.scheduleAutomaticRestart(memory)
      expect(f.manager.restartTimers.size).toBe(0)
      expect(memory.restart_history).toBeUndefined()
      await f.manager.scheduleAutomaticRestart(admin)
      expect(f.manager.restartTimers.has('admin-web')).toBe(true)
    } finally { await f.cleanup() }
  })

  it('rechecks late queued health recovery after the persistent fence appears', async () => {
    const f = await fixture(), stop = vi.spyOn(f.manager, 'stopModuleProcess').mockResolvedValue(undefined)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    try {
      const child = {}, memory = f.manager.modules.get('memory')
      memory.status = 'running'; f.manager.processes.set('memory', child)
      void f.manager.enqueueLifecycle('memory', () => held)
      f.manager.scheduleHealthRecovery(memory, child)
      const queued = f.manager.lifecycleQueues.get('memory')
      await f.freeze(); release(); await queued
      await vi.waitFor(() => expect(f.manager.healthRecoveries.size).toBe(0))
      expect(stop).not.toHaveBeenCalled()
      expect(memory.status).toBe('running')
    } finally { release(); await f.cleanup() }
  })

})

it('retains ordinary all-module orphan recovery when no workspace maintenance is pending', async () => {
  const data = await fs.mkdtemp(path.join(tmpdir(), 'crabot-mm-no-workspace-gate-'))
  const manager = new ModuleManager({ port: 0, modules: [] }, data) as any
  const recover = vi.spyOn(manager.runtimeRegistry, 'recoverOrphans').mockResolvedValue(undefined)
  try {
    await manager.start()
    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover.mock.calls[0][0].moduleId).toBeUndefined()
    expect(manager.server.listening).toBe(true)
  } finally { await manager.stop(); await fs.rm(data, { recursive: true, force: true }) }
})
