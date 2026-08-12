import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ModuleManager from './index.js'
import type { ChildProcess } from 'node:child_process'

describe('core Agent cutover gate', () => {
  it('revokes the exact core bearer before a stop operation is queued', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-bearer-stop-'))
    const manager = new ModuleManager({
      port: 0, port_range: { range_start: 19920, range_end: 19940 }, hotplug_allowed_types: ['channel'], modules: [],
    }, dataDir) as any
    const child = { exitCode: null } as ChildProcess
    manager.runtimeBearers.set('crabot-agent', { token: 'runtime-secret', child, revoked: false })
    manager.modules.set('crabot-agent', { module_id: 'crabot-agent', module_type: 'agent', entry: 'node -e 1', auto_start: false, start_priority: 1, status: 'stopped', port: 19921 })
    vi.spyOn(manager, 'stopModuleProcess').mockResolvedValue(undefined)
    try {
      await manager.handleStopModule({ module_id: 'crabot-agent', force: true })
      expect(manager.runtimeBearers.get('crabot-agent').revoked).toBe(true)
    } finally {
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('revokes the old bearer before restart and binds a fresh bearer to the replacement child', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-bearer-restart-'))
    const manager = new ModuleManager({
      port: 0, port_range: { range_start: 19950, range_end: 19970 }, shutdown_timeout: 0.1,
      hotplug_allowed_types: ['channel'], modules: [],
    }, dataDir) as any
    manager.modules.set('crabot-agent', {
      module_id: 'crabot-agent', module_type: 'agent', entry: 'node -e "setInterval(()=>{},1000)"',
      auto_start: false, auto_restart: false, skip_health_check: true, start_priority: 1,
      status: 'stopped', port: 19951,
    })
    try {
      await manager.startModuleProcess('crabot-agent')
      const old = manager.runtimeBearers.get('crabot-agent')
      expect(manager.handleVerifyCoreAgentRuntime(
        { expected_module_id: 'crabot-agent' },
        { authorizationBearer: old.token },
      )).toEqual({ verified: true })

      await manager.handleRestartModule({ module_id: 'crabot-agent', force: true })
      expect(() => manager.handleVerifyCoreAgentRuntime(
        { expected_module_id: 'crabot-agent' },
        { authorizationBearer: old.token },
      )).toThrow(/revoked/)
      await manager.lifecycleQueues.get('crabot-agent')

      const replacement = manager.runtimeBearers.get('crabot-agent')
      expect(replacement.token).not.toBe(old.token)
      expect(replacement.child).not.toBe(old.child)
      expect(manager.handleVerifyCoreAgentRuntime(
        { expected_module_id: 'crabot-agent' },
        { authorizationBearer: replacement.token },
      )).toEqual({ verified: true })
    } finally {
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
  it('starts only Admin, rejects pre-cutover ingress, then persists completion before starting core modules', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-cutover-'))
    const manager = new ModuleManager({
      port: 0,
      port_range: { range_start: 19800, range_end: 19820 },
      health_check_interval: 60,
      health_check_timeout: 1,
      health_check_failure_threshold: 3,
      shutdown_timeout: 1,
      hotplug_allowed_types: ['channel'],
      modules: [
        { module_id: 'admin-web', module_type: 'admin', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: true, start_priority: 1 },
        { module_id: 'crabot-agent', module_type: 'agent', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: true, start_priority: 2 },
        { module_id: 'memory-default', module_type: 'memory', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: true, start_priority: 3 },
      ],
    }, dataDir)
    try {
      await manager.start()
      await new Promise((resolve) => setTimeout(resolve, 30))
      await expect((manager as any).handleStartModule({ module_id: 'memory-default' })).rejects.toMatchObject({ code: 'MODULE_MANAGER_CUTOVER_INCOMPLETE' })
      expect(() => (manager as any).handleResolve({ module_id: 'crabot-agent' })).toThrow(/cutover/)
      expect(() => (manager as any).handleSubscribe({ subscriber: 'memory-default', event_types: [] })).toThrow(/cutover/)
      expect(() => (manager as any).handleRegisterModuleDefinition({ module_definition: { module_id: 'rogue-agent', module_type: 'agent', entry: 'node -e 1', auto_start: false, start_priority: 4 } })).toThrow(/cutover|builtin/)
      const bearer = (manager as any).cutoverBearers.get('admin-web')
      expect(bearer).toBeDefined()
      const result = await (manager as any).handleCompleteCoreAgentCutover({ schema_version: 1, admin_archive_fingerprint: 'a', admin_archived_record_count: 0 }, { authorizationBearer: bearer.token })
      expect(result.completed).toBe(true)
      const replay = await (manager as any).handleCompleteCoreAgentCutover({ schema_version: 1, admin_archive_fingerprint: 'a', admin_archived_record_count: 0 }, { authorizationBearer: bearer.token })
      expect(replay).toEqual(result)
      expect(JSON.parse(await fs.readFile(path.join(dataDir, 'migrations', 'core-agent-singleton-v1.json'), 'utf8')).completed).toBe(true)
    } finally {
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps persisted auto-start Channel stopped before cutover and starts it after cutover', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-cutover-channel-'))
    const manager = new ModuleManager({
      port: 0, port_range: { range_start: 19830, range_end: 19850 }, health_check_interval: 60, health_check_timeout: 1, health_check_failure_threshold: 3, shutdown_timeout: 1,
      hotplug_allowed_types: ['channel'],
      modules: [
        { module_id: 'admin-web', module_type: 'admin', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: true, start_priority: 1 },
        { module_id: 'crabot-agent', module_type: 'agent', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: true, start_priority: 2 },
        { module_id: 'channel-positive', module_type: 'channel', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: true, start_priority: 3 },
      ],
    }, dataDir)
    try {
      await manager.start()
      await new Promise(resolve => setTimeout(resolve, 30))
      const channel = (manager as any).modules.get('channel-positive')
      const registration = { module_id: 'channel-positive', module_type: 'channel', version: '0.1.0', protocol_version: '0.1.0', port: channel.port, subscriptions: [] }
      expect((manager as any).processes.has('channel-positive')).toBe(false)
      await expect((manager as any).handleRegister(registration)).rejects.toMatchObject({ code: 'MODULE_MANAGER_CUTOVER_INCOMPLETE' })
      const bearer = (manager as any).cutoverBearers.get('admin-web')
      await (manager as any).handleCompleteCoreAgentCutover({ schema_version: 1, admin_archive_fingerprint: 'channel', admin_archived_record_count: 0 }, { authorizationBearer: bearer.token })
      await new Promise(resolve => setTimeout(resolve, 2_200))
      expect((manager as any).processes.has('channel-positive')).toBe(true)
      await expect((manager as any).handleRegister(registration)).resolves.toEqual({ registered: true })
    } finally {
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('fails closed without a marker when a non-core Agent tree cannot stop, then succeeds on retry', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-cutover-fault-'))
    const manager = new ModuleManager({
      port: 0, port_range: { range_start: 19860, range_end: 19880 }, health_check_interval: 60, health_check_timeout: 1, health_check_failure_threshold: 3, shutdown_timeout: 1,
      hotplug_allowed_types: ['channel'],
      modules: [
        { module_id: 'admin-web', module_type: 'admin', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: true, start_priority: 1 },
        { module_id: 'crabot-agent', module_type: 'agent', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: true, start_priority: 2 },
        { module_id: 'legacy-agent', module_type: 'agent', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: false, start_priority: 3 },
      ],
    }, dataDir)
    try {
      await manager.start()
      const legacy = (manager as any).modules.get('legacy-agent')
      legacy.status = 'running'
      ;(manager as any).processes.set('legacy-agent', {})
      const stop = vi.spyOn(manager as any, 'stopModuleProcess').mockRejectedValueOnce(new Error('tree survives'))
      const bearer = (manager as any).cutoverBearers.get('admin-web')
      await expect((manager as any).handleCompleteCoreAgentCutover({ schema_version: 1, admin_archive_fingerprint: 'fault', admin_archived_record_count: 1 }, { authorizationBearer: bearer.token })).rejects.toMatchObject({ code: 'MODULE_MANAGER_CUTOVER_STOP_FAILED' })
      expect((manager as any).managementOnly).toBe(true)
      expect((manager as any).processes.has('crabot-agent')).toBe(false)
      await expect(fs.access(path.join(dataDir, 'migrations', 'core-agent-singleton-v1.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      stop.mockRestore()
      ;(manager as any).processes.delete('legacy-agent')
      legacy.status = 'stopped'
      const retry = await (manager as any).handleCompleteCoreAgentCutover({ schema_version: 1, admin_archive_fingerprint: 'fault', admin_archived_record_count: 1 }, { authorizationBearer: bearer.token })
      expect(retry.completed).toBe(true)
      expect((manager as any).managementOnly).toBe(false)
    } finally {
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('replays the same marker response and re-enters management-only for restart rescan', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-cutover-replay-'))
    const config = {
      port: 0, port_range: { range_start: 19890, range_end: 19910 }, health_check_interval: 60, health_check_timeout: 1, health_check_failure_threshold: 3, shutdown_timeout: 1,
      hotplug_allowed_types: ['channel'], modules: [
        { module_id: 'admin-web', module_type: 'admin', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: true, start_priority: 1 },
        { module_id: 'crabot-agent', module_type: 'agent', entry: 'node -e "setTimeout(()=>{}, 10000)"', auto_start: true, start_priority: 2 },
      ],
    }
    const first = new ModuleManager(config, dataDir)
    try {
      await first.start()
      const bearer = (first as any).cutoverBearers.get('admin-web')
      const result = await (first as any).handleCompleteCoreAgentCutover({ schema_version: 1, admin_archive_fingerprint: 'replay', admin_archived_record_count: 0 }, { authorizationBearer: bearer.token })
      expect(JSON.parse(await fs.readFile(path.join(dataDir, 'migrations', 'core-agent-singleton-v1.json'), 'utf8'))).toMatchObject(result)
    } finally {
      await first.stop().catch(() => {})
    }
    const restarted = new ModuleManager(config, dataDir)
    try {
      await restarted.start()
      expect((restarted as any).managementOnly).toBe(true)
      expect((restarted as any).processes.has('crabot-agent')).toBe(false)
      const bearer = (restarted as any).cutoverBearers.get('admin-web')
      const replay = await (restarted as any).handleCompleteCoreAgentCutover({ schema_version: 1, admin_archive_fingerprint: 'replay', admin_archived_record_count: 0 }, { authorizationBearer: bearer.token })
      expect(replay).toMatchObject({ completed: true, admin_archive_fingerprint: 'replay' })
    } finally {
      await restarted.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
