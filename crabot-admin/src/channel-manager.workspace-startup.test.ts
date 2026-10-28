import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChannelManager } from './channel-manager.js'

// Real config persistence and definition assembly; no module process is started.
describe('workspace management startup channel definitions', () => {
  it('registers original definitions without auto-start, retaining the normal startup adapter', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-channel-definitions-')))
    const rpc = { registerModuleDefinition: vi.fn(async () => ({})), startModule: vi.fn(async () => ({})) }
    const manager = new ChannelManager(dir, rpc as any)
    try {
      await manager.addImplementation({ id: 'channel-fixture', name: 'fixture', platform: 'fixture', type: 'builtin', module_path: '../fixture-channel', version: '0.1.0', created_at: '', updated_at: '' })
      const active = await manager.createInstance({ name: 'active', implementation_id: 'channel-fixture', auto_start: true })
      const inactive = await manager.createInstance({ name: 'inactive', implementation_id: 'channel-fixture', auto_start: false })
      rpc.registerModuleDefinition.mockClear(); rpc.startModule.mockClear()
      const retained = await fs.readFile(path.join(dir, 'channel-instances.json'))
      const definitions = await manager.registerBuiltinInstanceDefinitions()
      expect(definitions.map(item => item.id).sort()).toEqual([active.id, inactive.id].sort())
      expect(rpc.registerModuleDefinition).toHaveBeenCalledTimes(2)
      expect(rpc.startModule).not.toHaveBeenCalled()
      const definition = (rpc.registerModuleDefinition.mock.calls as unknown[][]).find(args => (args[0] as any).module_id === active.id)![0] as any
      expect(definition).toMatchObject({ module_type: 'channel', auto_start: true, env: { CRABOT_MODULE_ID: active.id, DATA_DIR: path.join(dir, 'channels', active.id) } })
      expect(await fs.readFile(path.join(dir, 'channel-instances.json'))).toEqual(retained)
      rpc.registerModuleDefinition.mockClear()
      await manager.reRegisterInstances()
      expect(rpc.registerModuleDefinition).toHaveBeenCalledTimes(2)
      expect(rpc.startModule).toHaveBeenCalledTimes(1)
      expect(rpc.startModule).toHaveBeenCalledWith(active.id, 'admin')
      expect(manager.getInstance(inactive.id)?.auto_start).toBe(false)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
