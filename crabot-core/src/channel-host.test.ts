import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModuleBase, mountChannel, RpcError } from 'crabot-shared'
import { CordisChannelHost } from './channel-host.js'
vi.mock('crabot-shared', async original => ({ ...await original<typeof import('crabot-shared')>(), getProcessRpcPeer: () => ({}) }))
afterEach(() => vi.restoreAllMocks())

describe('Cordis platform business adapter', () => {
  it('retains sensitive handler metadata and disposes only the owning platform resources', async () => {
    const stopped = vi.fn(), started = vi.fn()
    class Platform extends ModuleBase {
      constructor() {
        super({ moduleId: 'voice-fixture', moduleType: 'channel', version: '0.1.1', protocolVersion: '0.9.0', port: 19099 })
        this.registerMethod('voice_output', (_params, metadata) => {
          if (metadata?.authorizationBearer !== 'synthetic-bearer') throw new RpcError('UNAUTHORIZED', 'credential required')
          return { accepted: true }
        })
      }
      protected async onStart() { started() }
      protected async onStop() { stopped() }
      protected async getHealthStatus() { return 'degraded' as const }
      protected async getHealthDetails() { return { platform_connected: true } }
    }
    const config = { module_id: 'voice-fixture', module_type: 'channel' as const, version: '0.1.1', protocol_version: '0.9.0' }
    const platform = new Platform()
    const host = new CordisChannelHost({ createConfig: () => config, apply: (ctx) => mountChannel(ctx, platform) }, config, 19099)
    const second = new CordisChannelHost({ createConfig: () => config, apply: (ctx) => mountChannel(ctx, new Platform()) }, config, 19100)
    await (host as any).onStart()
    await (second as any).onStart()
    expect(started).toHaveBeenCalledTimes(2)
    expect(() => (host as any).methodHandlers.get('voice_output')({})).toThrow('credential required')
    expect(await (host as any).methodHandlers.get('voice_output')({}, { authorizationBearer: 'synthetic-bearer' })).toEqual({ accepted: true })
    expect(await (host as any).getHealthDetails()).toEqual({ platform_connected: true })
    expect(await (host as any).getHealthStatus({})).toBe('degraded')
    await host.stop()
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(await (second as any).getHealthDetails()).toEqual({ platform_connected: true })
    await second.stop()
    expect(stopped).toHaveBeenCalledTimes(2)
  })
})
