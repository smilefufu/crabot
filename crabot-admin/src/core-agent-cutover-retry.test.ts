import { describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'

function createSubject(options: { completionError?: unknown; existingMarker?: boolean } = {}): any {
  const subject = Object.create(AdminModule.prototype) as any
  subject.managementOnly = true
  subject.cutoverActivated = false
  subject.configInvalidationPublicationEnabled = false
  subject.cutoverAttempt = null
  subject.cutoverRecoveryReason = null
  subject.cutoverBearer = 'cutover-secret'
  subject.config = { moduleId: 'admin-web' }
  subject.agentManager = {
    listImplementations: () => ({ items: [{ id: 'default' }] }),
    listInstances: () => ({ items: [{ id: 'crabot-agent' }] }),
    listConfigs: () => [{ instance_id: 'crabot-agent' }],
  }
  subject.readLegacyAgentPackageEntries = vi.fn().mockResolvedValue([])
  subject.readLegacyFrontWorkerConfigSources = vi.fn().mockResolvedValue([])
  subject.cutoverStore = {
    archive: vi.fn().mockResolvedValue({ fingerprint: 'archive', record_count: 0 }),
    loadMarker: vi.fn().mockResolvedValue(options.existingMarker === false ? null : {
      schema_version: 1,
      completed: true,
      archive_fingerprint: 'archive',
      archive_record_count: 0,
    }),
    saveMarker: vi.fn(),
  }
  const completion = options.completionError === undefined
    ? vi.fn().mockResolvedValue({ record: { admin_archive_fingerprint: 'archive', admin_archived_record_count: 0 } })
    : vi.fn().mockRejectedValue(options.completionError)
  subject.rpcClient = {
    callModuleManagerSensitive: completion,
    callModuleManager: vi.fn().mockResolvedValue({ record: { admin_archive_fingerprint: 'archive', admin_archived_record_count: 0 } }),
  }
  subject.waitForCoreAgentReady = vi.fn().mockResolvedValue(undefined)
  subject.configMutationCoordinator = { drainPendingInvalidation: vi.fn() }
  subject.channelManager = { reRegisterInstances: vi.fn() }
  subject.ensureBuiltinSchedules = vi.fn()
  subject.scheduleEngine = { startAll: vi.fn(), stop: vi.fn() }
  subject.startAgentDependentMaintenance = vi.fn()
  subject.schedules = new Map()
  subject.publishCurrentAgentConfigInvalidation = vi.fn()
  subject.webServer = null
  subject.friends = new Map()
  subject.pendingMessages = new Map()
  subject.modelProviderManager = { listProviders: () => [] }
  return subject
}

describe('core Agent cutover activation retry', () => {
  it('repeats the MM handshake and retries readiness in the same process after a durable marker', async () => {
    const subject = createSubject()
    subject.waitForCoreAgentReady
      .mockRejectedValueOnce(Object.assign(new Error('legacy stop failed'), { code: 'MODULE_MANAGER_CUTOVER_STOP_FAILED' }))
      .mockResolvedValueOnce(undefined)

    await expect(subject.completeCoreAgentCutover()).rejects.toThrow('legacy stop failed')
    expect(subject.cutoverActivated).toBe(false)
    expect(subject.configInvalidationPublicationEnabled).toBe(false)
    expect(subject.cutoverRecoveryReason).toBe('legacy Agent process tree could not be stopped; retry after recovery')
    // 恢复期只报 degraded、绝不报 unhealthy：unhealthy 会让 MM 强杀并限流 auto_restart，
    // 快失败模式下 admin-web 几分钟内永久下线。恢复原因留在 details.recovery_reason。
    await expect(subject.getHealthStatus()).resolves.toBe('degraded')
    await expect(subject.getHealthDetails()).resolves.toMatchObject({
      cutover_ready: false,
      recovery_reason: 'legacy Agent process tree could not be stopped; retry after recovery',
    })

    await expect(subject.completeCoreAgentCutover()).resolves.toBeUndefined()
    expect(subject.cutoverActivated).toBe(true)
    expect(subject.configInvalidationPublicationEnabled).toBe(true)
    expect(subject.cutoverRecoveryReason).toBeNull()
    await expect(subject.getHealthStatus()).resolves.toBe('healthy')
    expect(subject.waitForCoreAgentReady).toHaveBeenCalledTimes(2)
    expect(subject.rpcClient.callModuleManagerSensitive).toHaveBeenCalledTimes(2)
    expect(subject.publishCurrentAgentConfigInvalidation).toHaveBeenCalledTimes(1)
    expect(subject.startAgentDependentMaintenance).toHaveBeenCalledTimes(1)
    expect(subject.scheduleEngine.startAll).toHaveBeenCalledTimes(1)
    expect(subject.cutoverStore.saveMarker).not.toHaveBeenCalled()
    expect(subject.channelManager.reRegisterInstances).toHaveBeenCalledTimes(1)
  })

  it('reconciles an ambiguous lost completion response against the MM durable record', async () => {
    const subject = createSubject({ completionError: new Error('socket reset'), existingMarker: false })

    await expect(subject.completeCoreAgentCutover()).resolves.toBeUndefined()

    expect(subject.rpcClient.callModuleManager).toHaveBeenCalledWith(
      'get_core_agent_cutover_record', {}, 'admin-web',
    )
    expect(subject.cutoverStore.saveMarker).toHaveBeenCalledWith(expect.objectContaining({
      archive_fingerprint: 'archive',
      archive_record_count: 0,
    }))
    expect(subject.cutoverActivated).toBe(true)
  })
})
