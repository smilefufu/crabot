import { afterEach, expect, it, vi } from 'vitest'
import AdminModule from './index.js'

afterEach(() => vi.unstubAllGlobals())
it('observes MM status through the managed client without opening old HTTP addresses', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Internal HTTP is forbidden')))
  const call = vi.fn().mockResolvedValue({ modules: [{ module_id: 'crabot-agent', status: 'running' }, { module_id: 'memory-default', status: 'stopped' }] })
  const result = await (AdminModule.prototype as any).queryModuleStatuses.call({ rpcClient: { call, moduleManagerTargetPort: 19000 }, config: { moduleId: 'admin-web' } })
  expect([...result.entries()]).toEqual([['crabot-agent', 'running'], ['memory-default', 'stopped']])
  expect(call).toHaveBeenCalledWith(19000, 'list_modules', {}, 'admin-web', undefined, { timeoutMs: 2000 })
  expect(fetch).not.toHaveBeenCalled()
})

for (const [handler, method] of [['handleStartModuleAdmin', 'start_module'], ['handleStopModuleAdmin', 'stop_module'], ['handleRestartModuleAdmin', 'restart_module']]) {
  it(`routes ${method} through the existing managed client, retaining config and accepted result`, async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Internal HTTP is forbidden')))
    const accepted = { status: 'accepted', tracking_id: 'synthetic-tracking' }
    const callModuleManager = vi.fn().mockResolvedValue(accepted)
    const resolveModuleStartEnv = vi.fn().mockResolvedValue({ SYNTHETIC: 'configured' })
    const app = { rpcClient: { callModuleManager }, config: { moduleId: 'admin-web' }, resolveModuleStartEnv }
    expect(await (AdminModule.prototype as any)[handler].call(app, { module_id: 'fixture-channel', force: false })).toEqual(accepted)
    expect(callModuleManager).toHaveBeenCalledWith(method, { module_id: 'fixture-channel',
      ...(method === 'start_module' ? {} : { force: false }), ...(method === 'stop_module' ? {} : { env: { SYNTHETIC: 'configured' } }) }, 'admin-web')
    expect(fetch).not.toHaveBeenCalled()
    callModuleManager.mockClear()
    await (AdminModule.prototype as any)[handler].call(app, { module_id: 'crabot-agent', force: false })
    expect(callModuleManager.mock.calls[0][1]).not.toHaveProperty('env')
  })
}
