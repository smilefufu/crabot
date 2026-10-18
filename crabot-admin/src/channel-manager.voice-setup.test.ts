import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChannelManager } from './channel-manager.js'
import type { ChannelImplementation } from './types.js'

const impl: ChannelImplementation = { id: 'channel-voice', name: '语音', platform: 'voice', type: 'builtin', module_path: '../crabot-channel-voice', version: '0.1.0', created_at: '', updated_at: '' }
describe('Voice setup instance owner', () => {
  let dir: string, manager: ChannelManager, rpc: any
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-instance-owner-'))
    rpc = { call: vi.fn(async () => ({ status: 'healthy' })), registerModuleDefinition: vi.fn(async () => ({})), startModule: vi.fn(async () => ({})), stopModule: vi.fn(async () => ({})), resolve: vi.fn(async () => []) }
    manager = new ChannelManager(dir, rpc); await manager.addImplementation(impl)
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }) })
  it('makes generic Voice creation a non-autostart draft and blocks generic bypass', async () => {
    const instance = await manager.createInstance({ name: '手机', implementation_id: impl.id, auto_start: true })
    expect(instance).toMatchObject({ voice_setup: { status: 'draft', owner_activation_required: true }, auto_start: false })
    await expect(manager.saveVoiceSetup(instance.id, { status: 'complete' }, true)).rejects.toThrow('所有者')
    expect(rpc.startModule).not.toHaveBeenCalled()
    await expect(manager.updateInstance({ instance_id: instance.id, auto_start: true })).rejects.toThrow('向导')
    await expect(manager.updateInstance({ instance_id: instance.id, voice_setup: { status: 'complete' } } as never)).rejects.toThrow('voice_setup')
  })
  it('retains a failed registration draft with its canonical ID', async () => {
    rpc.registerModuleDefinition.mockRejectedValue(new Error('MM unavailable'))
    await expect(manager.createInstance({ name: '手机', implementation_id: impl.id })).rejects.toThrow('MM unavailable')
    expect(manager.getInstance('手机')?.voice_setup?.status).toBe('draft')
    expect(JSON.parse(await fs.readFile(path.join(dir, 'channel-instances.json'), 'utf8'))[0].id).toBe('手机')
  })
  it('commits finish atomically before memory admission; failure preserves draft and future writes', async () => {
    await manager.createInstance({ name: '手机', implementation_id: impl.id })
    const disk = await fs.readFile(path.join(dir, 'channel-instances.json'), 'utf8')
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk failure'))
    await expect(manager.saveVoiceSetup('手机', { status: 'complete', owner_activation_required: true }, true)).rejects.toThrow('disk failure')
    expect(manager.getInstance('手机')).toMatchObject({ voice_setup: { status: 'draft', owner_activation_required: true }, auto_start: false })
    expect(await fs.readFile(path.join(dir, 'channel-instances.json'), 'utf8')).toBe(disk)
    rename.mockRestore()
    await manager.saveVoiceSetup('手机', { status: 'complete', owner_activation_required: true }, true)
    expect(manager.getInstance('手机')).toMatchObject({ voice_setup: { status: 'complete' }, auto_start: true })
    expect(JSON.parse(await fs.readFile(path.join(dir, 'channel-instances.json'), 'utf8'))[0].voice_setup.status).toBe('complete')
  })
  it('does not re-register or restart a running draft while continuing configuration', async () => {
    await manager.createInstance({ name: '手机', implementation_id: impl.id })
    rpc.registerModuleDefinition.mockClear(); rpc.resolve.mockResolvedValue([{ module_id: '手机', port: 19010 }])
    await manager.resumeVoice('手机')
    expect(rpc.registerModuleDefinition).not.toHaveBeenCalled(); expect(rpc.startModule).not.toHaveBeenCalled()
  })
})
