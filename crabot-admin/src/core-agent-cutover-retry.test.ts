import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
  subject.adminConfig = { data_dir: '/nonexistent-p6d-test' }
  // P6-D：cutover inventory 改直读原始文件；测试用 spy 替换为固定空源（语义同旧 mock）。
  subject.readLegacyAgentInventorySources = vi.fn().mockResolvedValue([])
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
  // P6-B：cutover 路径现挂 worker bootstrap（本测试不验收它；独立覆盖在 bootstrap 测试）。
  subject.runWorkerImplementationBootstrap = vi.fn().mockResolvedValue(undefined)
  subject.webServer = null
  subject.friends = new Map()
  subject.pendingMessages = new Map()
  subject.modelProviderManager = { listProviders: () => [] }
  return subject
}

describe('core Agent cutover marker handshake', () => {
  it('handshakes with the committed marker fingerprint after post-cutover inventory growth', async () => {
    const subject = createSubject()
    // marker 已提交 fingerprint 'committed'；本次 inventory 合并后 archive fingerprint 变成 'grown'
    //（cutover 后新出现的 legacy 条目）。握手必须用已提交值，而不是重新严格相等判断。
    subject.cutoverStore.loadMarker = vi.fn().mockResolvedValue({
      schema_version: 1, completed: true, archive_fingerprint: 'committed', archive_record_count: 2,
    })
    subject.cutoverStore.archive = vi.fn().mockResolvedValue({ fingerprint: 'grown', record_count: 3 })
    await expect(subject.completeCoreAgentCutover()).resolves.toBeUndefined()
    expect(subject.rpcClient.callModuleManagerSensitive).toHaveBeenCalledWith(
      'complete_core_agent_cutover',
      expect.objectContaining({ admin_archive_fingerprint: 'committed', admin_archived_record_count: 2 }),
      'admin-web',
      expect.objectContaining({ authorizationBearer: 'cutover-secret' }),
    )
    expect(subject.cutoverActivated).toBe(true)
  })
})

describe('legacy Agent package inventory scope', () => {
  async function makeDataDir(): Promise<{ dir: string; subject: any }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-installed-modules-'))
    const subject = Object.create(AdminModule.prototype) as any
    subject.adminConfig = { data_dir: dir }
    return { dir, subject }
  }

  it('only archives agent-type packages, skipping determinable non-agent modules', async () => {
    const { dir, subject } = await makeDataDir()
    try {
      const modulesDir = path.join(dir, 'installed-modules')
      const write = async (name: string, manifest?: string) => {
        await fs.mkdir(path.join(modulesDir, name), { recursive: true })
        if (manifest !== undefined) await fs.writeFile(path.join(modulesDir, name, 'crabot-module.yaml'), manifest)
      }
      await write('legacy-agent-pkg', 'module_id: legacy-agent-pkg\nmodule_type: agent\n')
      await write('channel-pkg', 'module_id: channel-pkg\nmodule_type: channel\n')
      await write('memory-pkg', 'module_id: memory-pkg\nmodule_type: memory\n')
      await write('unmanifested-pkg')
      await write('crabot-agent', 'module_id: crabot-agent\nmodule_type: agent\n')
      const entries = await subject.readLegacyAgentPackageEntries()
      expect(entries.map((entry: { source_id: string }) => entry.source_id)).toEqual(['legacy-agent-pkg', 'unmanifested-pkg'])
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})

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
