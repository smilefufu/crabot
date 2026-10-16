import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import ModuleManager from './index.js'

describe('voice child runtime authentication', () => {
  it('uses the implementation identity for arbitrary instance names and isolates exact children', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-voice-runtime-'))
    const manager = new ModuleManager({ port: 0, port_range: { range_start: 19701, range_end: 19720 }, hotplug_allowed_types: ['channel'], modules: [] }, dataDir) as any
    manager.managementOnly = false
    const definition = (moduleId: string, impl: string) => ({ module_id: moduleId, module_type: 'channel', env: { CRABOT_CHANNEL_IMPLEMENTATION_ID: impl }, entry: 'node -e 1', auto_start: false, start_priority: 30, status: 'starting', port: 19701 })
    manager.modules.set('客厅', definition('客厅', 'channel-voice'))
    manager.modules.set('bedroom', definition('bedroom', 'channel-voice'))
    manager.modules.set('channel-voice-fake', definition('channel-voice-fake', 'channel-telegram'))
    const child = { exitCode: null }
    manager.runtimeBearers.set('客厅', { token: 'living-secret', child, revoked: false })
    manager.runtimeBearers.set('bedroom', { token: 'bedroom-secret', child: { exitCode: null }, revoked: false })
    manager.runtimeBearers.set('crabot-agent', { token: 'core-secret', child, revoked: false })
    manager.processes.set('客厅', child)
    try {
      expect(manager.handleVerifyVoiceRuntime({ expected_module_id: '客厅' }, { authorizationBearer: 'living-secret' })).toEqual({ verified: true })
      for (const [id, token] of [['客厅', undefined], ['客厅', 'bedroom-secret'], ['客厅', 'core-secret'], ['channel-voice-fake', 'living-secret'], ['crabot-agent', 'core-secret']]) {
        expect(() => manager.handleVerifyVoiceRuntime({ expected_module_id: id }, { authorizationBearer: token })).toThrow()
      }
      await expect(manager.handleRegisterUnauthenticated({ module_id: '客厅' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      child.exitCode = 1
      expect(() => manager.handleVerifyVoiceRuntime({ expected_module_id: '客厅' }, { authorizationBearer: 'living-secret' })).toThrow(/revoked/)
      child.exitCode = null
      manager.revokeRuntimeBearer('客厅')
      expect(() => manager.handleVerifyVoiceRuntime({ expected_module_id: '客厅' }, { authorizationBearer: 'living-secret' })).toThrow(/revoked/)
    } finally {
      manager.processes.clear()
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
  it('issues a fresh voice bearer on replacement and removes inherited voice secrets from other children', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-voice-spawn-'))
    const manager = new ModuleManager({ port: 0, port_range: { range_start: 19722, range_end: 19740 }, shutdown_timeout: 0.1, hotplug_allowed_types: ['channel'], modules: [] }, dataDir) as any
    for (const [moduleId, impl] of [['living-room', 'channel-voice'], ['telegram-room', 'channel-telegram']]) {
      manager.modules.set(moduleId, { module_id: moduleId, module_type: 'channel', env: { CRABOT_CHANNEL_IMPLEMENTATION_ID: impl, CRABOT_VOICE_RUNTIME_BEARER: 'must-not-inherit', VOICE_ENV_TEST_FILE: path.join(dataDir, moduleId + '.json') }, entry: 'node -e "const e=process.env.CRABOT_VOICE_RUNTIME_BEARER; require(\'fs\').writeFileSync(process.env.VOICE_ENV_TEST_FILE, JSON.stringify({voice_hash:e?require(\'crypto\').createHash(\'sha256\').update(e).digest(\'hex\'):null, core:!!process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER})); setInterval(()=>{},1000)"', auto_start: false, auto_restart: false, skip_health_check: true, start_priority: 30, status: 'stopped', port: moduleId === 'living-room' ? 19723 : 19724 })
    }
    try {
      await manager.startModuleProcess('living-room')
      const first = manager.runtimeBearers.get('living-room')
      expect(first.token.length).toBeGreaterThanOrEqual(43)
      expect(first.token).not.toBe('must-not-inherit')
      const readChild = async (id: string) => {
        const file = path.join(dataDir, id + '.json')
        for (let i = 0; i < 100; i++) { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { await new Promise(resolve => setTimeout(resolve, 10)) } }
        throw new Error('child environment probe did not finish')
      }
      expect(await readChild('living-room')).toEqual({ voice_hash: createHash('sha256').update(first.token).digest('hex'), core: false })
      await manager.handleRestartModule({ module_id: 'living-room', force: true })
      expect(first.revoked).toBe(true)
      await manager.lifecycleQueues.get('living-room')
      const second = manager.runtimeBearers.get('living-room')
      expect(second.child).not.toBe(first.child)
      expect(second.token).not.toBe(first.token)
      await manager.startModuleProcess('telegram-room')
      expect(manager.runtimeBearers.has('telegram-room')).toBe(false)
      expect(await readChild('telegram-room')).toEqual({ voice_hash: null, core: false })
    } finally {
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
