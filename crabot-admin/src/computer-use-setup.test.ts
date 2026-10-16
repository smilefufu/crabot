import { describe, it, expect, vi } from 'vitest'
import { ComputerUseSetup } from './computer-use-setup.js'

function fixture(platform = 'darwin') {
  const configuration = { enabled: true, standard: true, root: '/fixture', key: 'standard' }
  const deps = { configuration: () => ({ ...configuration }), host: async () => ({ platform, hostname: 'test-computer', session: 'active' as const }),
    runtime: vi.fn().mockResolvedValue({ state: 'ready' }), permissions: vi.fn().mockResolvedValue({ accessibility: true, screen_recording: true }),
    request: vi.fn().mockResolvedValue({ accessibility: true, screen_recording: true, capturable: true }),
    settings: vi.fn().mockResolvedValue(undefined),
    appPath: () => platform === 'darwin' ? '/fixture/CuaDriver.app' : undefined, reveal: vi.fn(), invalidate: vi.fn().mockResolvedValue(undefined) }
  return { setup: new ComputerUseSetup(deps), deps, configuration }
}
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }

describe('human desktop setup lifecycle', () => {
  it('GET reports exactly the missing grant without requesting permission or loading runtime', async () => {
    const { setup, deps } = fixture()
    deps.permissions.mockResolvedValue({ accessibility: true, screen_recording: false })
    const status = await setup.status()
    expect(status.permissions).toEqual({ accessibility: 'granted', screen_recording: 'missing' })
    expect(status.capture.status).toBe('unverified')
    expect(deps.request).not.toHaveBeenCalled(); expect(deps.invalidate).not.toHaveBeenCalled()
    await setup.close()
  })
  it('shares simultaneous POSTs and verifies capture before requesting local reload', async () => {
    const { setup, deps } = fixture()
    const [a, b] = await Promise.all([setup.start(), setup.start()])
    expect(a.setup!.setup_id).toBe(b.setup!.setup_id)
    await settle()
    expect(deps.request).toHaveBeenCalledTimes(1)
    expect(deps.request.mock.calls[0][1]).toBe(true)
    expect(deps.invalidate).toHaveBeenCalledTimes(1)
    expect((await setup.status()).setup?.phase).toBe('ready')
    await setup.close()
  })
  it('does not mistake granted flags for actual screenshot success', async () => {
    const { setup, deps } = fixture()
    deps.request.mockResolvedValue({ accessibility: true, screen_recording: true, capturable: false })
    await setup.start(); await settle()
    expect((await setup.status()).capture.status).toBe('failed')
    expect(deps.invalidate).not.toHaveBeenCalled()
    await setup.close()
  })
  it('guides the two missing permissions in order, reusing the fresh GET probe', async () => {
    vi.useFakeTimers()
    const { setup, deps } = fixture()
    deps.permissions.mockResolvedValue({ accessibility: false, screen_recording: false })
    await setup.status()
    await setup.start(); await settle()
    expect(deps.permissions).toHaveBeenCalledTimes(1)
    expect(deps.settings.mock.calls.map(call => call[1])).toEqual(['accessibility'])
    deps.permissions.mockResolvedValue({ accessibility: true, screen_recording: false })
    await vi.advanceTimersByTimeAsync(2000)
    expect(deps.settings.mock.calls.map(call => call[1])).toEqual(['accessibility', 'screen_recording'])
    deps.permissions.mockResolvedValue({ accessibility: true, screen_recording: true })
    await vi.advanceTimersByTimeAsync(2000)
    expect((await setup.status()).setup?.phase).toBe('ready')
    expect(deps.request.mock.calls.map(call => call[1])).toEqual([false, true])
    await setup.close(); vi.useRealTimers()
  })
  it('does not reuse old screenshot evidence after the standard configuration changes', async () => {
    const { setup, configuration } = fixture()
    await setup.start(); await settle()
    expect((await setup.status()).capture.status).toBe('verified')
    configuration.key = 'replacement'
    const status = await setup.status()
    expect(status.capture.status).toBe('unverified')
    expect(status.setup).toBeUndefined()
    await setup.close()
  })
  it('rejects disabled/custom/no-GUI setup without changing configuration or requesting grants', async () => {
    const { setup, deps, configuration } = fixture()
    configuration.enabled = false
    await expect(setup.start()).rejects.toThrow('COMPUTER_USE_DISABLED')
    configuration.enabled = true; configuration.standard = false
    await expect(setup.start()).rejects.toThrow('COMPUTER_USE_CUSTOM_BACKEND')
    configuration.standard = true
    deps.host = async () => ({ platform: 'darwin', hostname: 'test-computer', session: 'unavailable' as never })
    await expect(setup.start()).rejects.toThrow('COMPUTER_USE_INTERACTIVE_SESSION_REQUIRED')
    expect(deps.request).not.toHaveBeenCalled(); expect(deps.invalidate).not.toHaveBeenCalled()
    await setup.close()
  })
  it('ignores stale cancellation and discards a late successful helper after cancellation', async () => {
    const { setup, deps } = fixture()
    let finish!: (value: any) => void
    deps.request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const started = await setup.start(); await settle()
    await expect(setup.cancel('old-setup')).rejects.toThrow('COMPUTER_USE_SETUP_CHANGED')
    const cancelled = setup.cancel(started.setup!.setup_id)
    finish({ accessibility: true, screen_recording: true, capturable: true })
    expect((await cancelled).setup?.phase).toBe('cancelled')
    expect(deps.invalidate).toHaveBeenCalledTimes(1) // Narrowing notification cancels any Agent-side diagnostic.
    await setup.close()
  })
  it('retains business quarantine instead of treating setup as forced recovery', async () => {
    const { setup, deps } = fixture()
    deps.runtime.mockResolvedValue({ state: 'quarantined' })
    await setup.start(); await settle()
    expect((await setup.status()).setup?.reason).toBe('COMPUTER_USE_QUARANTINED')
    await setup.close()
  })
  it('non-mac capture remains unverified until the matching authenticated setup request is observed', async () => {
    vi.useFakeTimers()
    const { setup, deps } = fixture('linux')
    const status = await setup.start(); await settle()
    expect(setup.requestForAgent()?.setup_id).toBe(status.setup?.setup_id)
    expect((await setup.status()).permissions.accessibility).toBe('not_applicable')
    expect((await setup.status()).capture.status).toBe('unverified')
    deps.runtime.mockResolvedValue({ state: 'ready', capture: { setup_id: status.setup!.setup_id, status: 'verified', verified_at: new Date().toISOString() } })
    await vi.advanceTimersByTimeAsync(2000)
    expect((await setup.status()).setup?.phase).toBe('ready')
    expect(deps.request).not.toHaveBeenCalled()
    await setup.close(); vi.useRealTimers()
  })
  it('expires at 180 seconds and stops after shutdown without late invalidation', async () => {
    vi.useFakeTimers()
    const { setup, deps } = fixture('linux')
    await setup.start(); await settle()
    await vi.advanceTimersByTimeAsync(180001)
    expect((await setup.status()).setup?.reason).toBe('COMPUTER_USE_SETUP_TIMEOUT')
    await setup.close()
    await expect(setup.start()).rejects.toThrow('COMPUTER_USE_SETUP_CLOSED')
    vi.useRealTimers()
  })
})
