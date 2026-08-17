import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ModuleManager from './index.js'
import type { ChildProcess } from 'node:child_process'

describe('core Agent cutover gate', () => {
  function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
  }
  it('keeps type-based discovery compatible while returning only the exact core Agent', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-resolve-core-'))
    const manager = new ModuleManager({
      port: 0, port_range: { range_start: 19890, range_end: 19910 }, hotplug_allowed_types: ['channel'], modules: [],
    }, dataDir) as any
    manager.managementOnly = false
    manager.modules.set('crabot-agent', {
      module_id: 'crabot-agent', module_type: 'agent', entry: 'node -e 1', auto_start: false,
      start_priority: 1, status: 'running', host: 'localhost', port: 19891,
    })
    manager.modules.set('legacy-agent', {
      module_id: 'legacy-agent', module_type: 'agent', entry: 'node -e 1', auto_start: false,
      start_priority: 1, status: 'stopped', host: 'localhost', port: 19892,
      legacy_archive: { kind: 'unsupported_non_core_agent', archived_at: new Date().toISOString(), reason: 'cutover' },
    })
    try {
      expect(manager.handleResolve({ module_type: 'agent' }).modules.map((module: { module_id: string }) => module.module_id))
        .toEqual(['crabot-agent'])
      expect(() => manager.handleResolve({ module_id: 'legacy-agent' }))
        .toThrowError(expect.objectContaining({ code: 'MODULE_MANAGER_AGENT_SINGLETON_ONLY' }))
    } finally {
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

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
      await expect(manager.handleRegister({
        module_id: 'crabot-agent', module_type: 'agent', version: '0.2.0', protocol_version: '3.2.0',
        port: 19951, subscriptions: [],
      })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(manager.modules.get('crabot-agent').status).toBe('running')

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
  it('rejects a concurrent cutover completion with the same bearer', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-cutover-concurrent-'))
    const manager = new ModuleManager({
      port: 0, port_range: { range_start: 19972, range_end: 19990 }, hotplug_allowed_types: ['channel'], modules: [],
    }, dataDir) as any
    const adminChild = { exitCode: null } as ChildProcess
    manager.cutoverBearers.set('admin-web', { token: 'cutover-secret', child: adminChild, revoked: false })
    manager.modules.set('crabot-agent', {
      module_id: 'crabot-agent', module_type: 'agent', entry: 'node trusted.js', auto_start: false,
      start_priority: 1, status: 'stopped', port: 19974,
    })
    manager.modules.set('legacy-agent', {
      module_id: 'legacy-agent', module_type: 'agent', entry: 'node -e 1', auto_start: false,
      start_priority: 1, status: 'running', port: 19973,
    })
    const stopStarted = deferred<void>()
    const releaseStop = deferred<void>()
    vi.spyOn(manager, 'stopModuleProcess').mockImplementation(async () => {
      stopStarted.resolve()
      await releaseStop.promise
      manager.modules.get('legacy-agent').status = 'stopped'
      manager.processes.delete('legacy-agent')
    })
    try {
      const first = manager.handleCompleteCoreAgentCutover(
        { schema_version: 1, admin_archive_fingerprint: 'concurrent', admin_archived_record_count: 1 },
        { authorizationBearer: 'cutover-secret' },
      )
      await stopStarted.promise
      await expect(manager.handleCompleteCoreAgentCutover(
        { schema_version: 1, admin_archive_fingerprint: 'concurrent', admin_archived_record_count: 1 },
        { authorizationBearer: 'cutover-secret' },
      )).rejects.toMatchObject({ code: 'FORBIDDEN' })
      releaseStop.resolve()
      await expect(first).resolves.toMatchObject({ record: { completed: true } })
      expect(manager.handleGetCoreAgentCutoverRecord()).toMatchObject({ record: { completed: true, admin_archive_fingerprint: 'concurrent' } })
      manager.cutoverBearers.set('admin-web', { token: 'restart-secret', child: adminChild, revoked: false })
      await expect(manager.handleCompleteCoreAgentCutover(
        { schema_version: 1, admin_archive_fingerprint: 'concurrent', admin_archived_record_count: 1 },
        { authorizationBearer: 'restart-secret' },
      )).resolves.toMatchObject({ record: { completed: true } })
    } finally {
      releaseStop.resolve()
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects mutable core lifecycle inputs, definition mutation, and wrong protocol registration', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-core-immutable-'))
    const manager = new ModuleManager({
      port: 0, port_range: { range_start: 19991, range_end: 19999 }, hotplug_allowed_types: ['channel'], modules: [],
    }, dataDir) as any
    const child = { exitCode: null } as ChildProcess
    manager.modules.set('crabot-agent', {
      module_id: 'crabot-agent', module_type: 'agent', entry: 'node trusted.js', cwd: '/trusted', env: {},
      auto_start: false, start_priority: 1, status: 'starting', port: 19992,
    })
    manager.processes.set('crabot-agent', child)
    try {
      const startSpy = vi.spyOn(manager, 'startModuleProcess')
      await expect(manager.handleStartModule({ module_id: 'crabot-agent', entry_override: 'node attacker.js' }))
        .rejects.toMatchObject({ code: 'MODULE_MANAGER_CORE_MODULE_IMMUTABLE' })
      await expect(manager.handleRestartModule({ module_id: 'crabot-agent', env: { ATTACKER: '1' } }))
        .rejects.toMatchObject({ code: 'MODULE_MANAGER_CORE_MODULE_IMMUTABLE' })
      expect(() => manager.handleUpdateModuleDefinition({ module_id: 'crabot-agent', updates: { entry: 'node attacker.js' } }))
        .toThrow(/immutable/)
      expect(() => manager.handleUnregisterModuleDefinition({ module_id: 'crabot-agent' })).toThrow(/immutable/)
      await expect(manager.handleRegisterCoreAgent({
        module_id: 'crabot-agent', module_type: 'agent', version: '0.2.0', protocol_version: '0.2.0',
        port: 19992, subscriptions: [],
      }, { authorizationBearer: 'runtime' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      manager.runtimeBearers.set('crabot-agent', { token: 'runtime', child, revoked: false })
      await expect(manager.handleRegisterCoreAgent({
        module_id: 'crabot-agent', module_type: 'agent', version: '0.2.0', protocol_version: '0.2.0',
        port: 19992, subscriptions: [],
      }, { authorizationBearer: 'runtime' })).rejects.toMatchObject({ code: 'MODULE_MANAGER_PROTOCOL_VERSION_MISMATCH' })
      await expect(manager.handleRegister({
        module_id: 'crabot-agent', module_type: 'agent', version: '0.2.0', protocol_version: '3.2.0',
        port: 19992, subscriptions: [],
      })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(manager.modules.get('crabot-agent').entry).toBe('node trusted.js')
      expect(manager.processes.get('crabot-agent')).toBe(child)
      expect(startSpy).not.toHaveBeenCalled()
    } finally {
      manager.processes.delete('crabot-agent')
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects archived Agent subscriptions after cutover', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-archived-subscribe-'))
    const manager = new ModuleManager({
      port: 0, port_range: { range_start: 19770, range_end: 19790 }, hotplug_allowed_types: ['channel'], modules: [],
    }, dataDir) as any
    manager.modules.set('legacy-agent', {
      module_id: 'legacy-agent', module_type: 'agent', entry: 'node old.js', auto_start: false,
      start_priority: 1, status: 'stopped', port: 19771,
      legacy_archive: { kind: 'unsupported_non_core_agent', archived_at: new Date().toISOString(), reason: 'retired' },
    })
    try {
      expect(() => manager.handleSubscribe({ subscriber: 'legacy-agent', event_types: ['x'] }))
        .toThrow(/builtin crabot-agent/)
      await expect(manager.handleUnregister({ module_id: 'legacy-agent' })).rejects.toMatchObject({ code: 'MODULE_MANAGER_AGENT_SINGLETON_ONLY' })
      expect(manager.subscriptions).toEqual([])
    } finally {
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects dynamic Agent registration even if runtime configuration is later corrupted', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-agent-runtime-guard-'))
    const manager = new ModuleManager({
      port: 0, port_range: { range_start: 19800, range_end: 19820 }, hotplug_allowed_types: ['channel'], modules: [],
    }, dataDir) as any
    manager.config.hotplug_allowed_types.push('agent')
    try {
      const dynamicDefinition = {
        module_definition: {
          module_id: 'dynamic-agent', module_type: 'agent', entry: 'node malicious.js', cwd: '.',
          auto_start: false, start_priority: 1,
        },
      }
      expect(() => manager.handleRegisterModuleDefinition(dynamicDefinition)).toThrow(/Only builtin crabot-agent/)
      try {
        manager.handleRegisterModuleDefinition(dynamicDefinition)
      } catch (error) {
        expect(error).toMatchObject({ code: 'MODULE_MANAGER_HOTPLUG_NOT_ALLOWED' })
      }
      expect(manager.modules.has('dynamic-agent')).toBe(false)
    } finally {
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects invalid hotplug configuration containing the reserved Agent type', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-agent-allowlist-'))
    try {
      expect(() => new ModuleManager({ hotplug_allowed_types: ['channel', 'agent'] }, dataDir))
        .toThrow(/must not contain reserved type/)
    } finally {
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
      expect(result.record.completed).toBe(true)
      await expect((manager as any).handleCompleteCoreAgentCutover(
        { schema_version: 1, admin_archive_fingerprint: 'a', admin_archived_record_count: 0 },
        { authorizationBearer: bearer.token },
      )).rejects.toMatchObject({ code: 'FORBIDDEN' })
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
      expect(retry.record.completed).toBe(true)
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
      expect(JSON.parse(await fs.readFile(path.join(dataDir, 'migrations', 'core-agent-singleton-v1.json'), 'utf8'))).toMatchObject(result.record)
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
      expect(replay).toMatchObject({ record: { completed: true, admin_archive_fingerprint: 'replay' } })
    } finally {
      await restarted.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('P6-D final negative: dynamic Agent registration impossible regardless of allowlist', () => {
  it('无 legacy_archive 标记 + allowlist 错误包含 agent → 注册仍拒绝；同 shape channel 可注册', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-mm-reg-gate-'))
    // 第一道门：allowlist 包含 agent 时构造直接拒绝。
    expect(() => new ModuleManager({
      port: 0, port_range: { range_start: 19850, range_end: 19870 }, hotplug_allowed_types: ['channel', 'agent'], modules: [],
    }, dataDir)).toThrowError(/must not contain reserved type "agent"/)
    // 第二道门：正常 allowlist 下，无 legacy_archive 标记的 dynamic agent definition 注册仍拒绝。
    const manager = new ModuleManager({
      port: 0, port_range: { range_start: 19850, range_end: 19870 }, hotplug_allowed_types: ['channel'], modules: [],
    }, dataDir) as any
    try {
      expect(() => manager.handleRegisterModuleDefinition({
        module_definition: {
          module_id: 'rogue-agent', module_type: 'agent', entry: 'node -e 1', auto_start: false, start_priority: 1,
        },
      })).toThrowError(expect.objectContaining({ code: 'MODULE_MANAGER_HOTPLUG_NOT_ALLOWED' }))

      const registered = manager.handleRegisterModuleDefinition({
        module_definition: {
          module_id: 'some-channel', module_type: 'channel', entry: 'node -e 1', auto_start: false, start_priority: 1,
        },
      })
      expect(registered.registered).toBe(true)
    } finally {
      await manager.stop().catch(() => {})
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
