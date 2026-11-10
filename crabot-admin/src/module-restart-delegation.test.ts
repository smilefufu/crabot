import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'

interface AdminUnderTest {
  config: { moduleId: string }
  rpcClient: { callModuleManager: ReturnType<typeof vi.fn> }
  channelManager: {
    ensureInstanceDefinition(id: string): Promise<void>
    getInstance(id: string): unknown
    loadLocalConfig(id: string): Promise<Record<string, string> | null>
  }
  handleGetModuleConfig(params: { module_id: string }): Promise<{ config: Record<string, string> }>
  buildGlobalModelEnv(): Promise<Record<string, string>>
  handleRestartModuleAdmin(params: { module_id: string; force?: boolean }): Promise<{
    status: 'accepted'
    tracking_id: string
  }>
}

function buildAdmin(): AdminUnderTest {
  const admin = Object.create(AdminModule.prototype) as AdminUnderTest
  admin.config = { moduleId: 'admin-test' }
  admin.rpcClient = { callModuleManager: vi.fn().mockResolvedValue({status:'accepted',tracking_id:'restart-1'}) }
  admin.channelManager = {
    ensureInstanceDefinition: vi.fn(async () => {}),
    getInstance: () => undefined,
    loadLocalConfig: vi.fn(),
  }
  admin.handleGetModuleConfig = vi.fn().mockResolvedValue({
    config: { CHANNEL_TOKEN: 'module-value', SHARED: 'module' },
  })
  admin.buildGlobalModelEnv = vi.fn().mockResolvedValue({
    MODEL_CONFIG: 'resolved-now',
    SHARED: 'global',
  })
  return admin
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Admin restart delegation', () => {
  it('resolves current start env and sends exactly one MM restart request', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Internal HTTP is forbidden') }))
    const admin = buildAdmin()

    const result = await admin.handleRestartModuleAdmin({ module_id: 'channel-1', force: true })

    expect(result).toEqual({ status: 'accepted', tracking_id: 'restart-1' })
    expect(admin.rpcClient.callModuleManager).toHaveBeenCalledOnce()
    expect(admin.rpcClient.callModuleManager).toHaveBeenCalledWith('restart_module', {
      module_id: 'channel-1', force: true,
      env: { CHANNEL_TOKEN: 'module-value', MODEL_CONFIG: 'resolved-now', SHARED: 'global' },
    }, 'admin-test')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends no lifecycle request when current env resolution fails', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const admin = buildAdmin()
    admin.buildGlobalModelEnv = vi.fn().mockRejectedValue(new Error('provider resolution failed'))

    await expect(admin.handleRestartModuleAdmin({ module_id: 'channel-1' })).rejects.toThrow(
      'provider resolution failed',
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(admin.rpcClient.callModuleManager).not.toHaveBeenCalled()
  })

  it('loads channel-local config through the same resolver used by start', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Internal HTTP is forbidden') }))
    const admin = buildAdmin()
    admin.channelManager = {
      ensureInstanceDefinition: vi.fn(async () => {}),
      getInstance: () => ({ id: 'channel-1' }),
      loadLocalConfig: vi.fn().mockResolvedValue({ CHANNEL_SECRET: 'current' }),
    }

    await admin.handleRestartModuleAdmin({ module_id: 'channel-1' })

    expect(admin.channelManager.loadLocalConfig).toHaveBeenCalledWith('channel-1')
    const params = admin.rpcClient.callModuleManager.mock.calls[0][1]
    expect(params.env).toMatchObject({ CHANNEL_SECRET: 'current', MODEL_CONFIG: 'resolved-now' })
  })
})
