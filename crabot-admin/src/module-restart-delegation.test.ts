import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'

interface AdminUnderTest {
  config: { moduleId: string }
  channelManager: {
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
  admin.channelManager = {
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
    const requests: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) })
      return {
        json: async () => ({
          success: true,
          data: { status: 'accepted', tracking_id: 'restart-1' },
        }),
      }
    }))
    const admin = buildAdmin()

    const result = await admin.handleRestartModuleAdmin({ module_id: 'channel-1', force: true })

    expect(result).toEqual({ status: 'accepted', tracking_id: 'restart-1' })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toMatch(/\/restart_module$/)
    expect(requests[0].body.params).toEqual({
      module_id: 'channel-1',
      force: true,
      env: {
        CHANNEL_TOKEN: 'module-value',
        MODEL_CONFIG: 'resolved-now',
        SHARED: 'global',
      },
    })
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
  })

  it('loads channel-local config through the same resolver used by start', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => ({
      json: async () => ({ success: true, data: { status: 'accepted', tracking_id: 'restart-2' } }),
      requestBody: init?.body,
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const admin = buildAdmin()
    admin.channelManager = {
      getInstance: () => ({ id: 'channel-1' }),
      loadLocalConfig: vi.fn().mockResolvedValue({ CHANNEL_SECRET: 'current' }),
    }

    await admin.handleRestartModuleAdmin({ module_id: 'channel-1' })

    expect(admin.channelManager.loadLocalConfig).toHaveBeenCalledWith('channel-1')
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))
    expect(body.params.env).toMatchObject({ CHANNEL_SECRET: 'current', MODEL_CONFIG: 'resolved-now' })
  })
})
