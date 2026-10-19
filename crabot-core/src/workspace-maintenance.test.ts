import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import ModuleManager from './index.js'

describe.each(['relocation.json', 'relocation-workers.json'])('workspace maintenance module admission: %s', record => {
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
    return { data, manager, freeze, cleanup: () => fs.rm(data, { recursive: true, force: true }) }
  }

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
})
