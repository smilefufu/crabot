import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
const fixture = vi.hoisted(() => ({ config: vi.fn(), start: vi.fn(), register: vi.fn(), mount: vi.fn() }))
vi.mock('crabot-shared', async original => ({ ...await original<typeof import('crabot-shared')>(), mountChannel: fixture.mount }))
vi.mock('./voice-channel.js', () => ({ VoiceChannel: class {
  constructor(...config: unknown[]) { fixture.config(...config) }
  async start() { fixture.start() }
  async register(bearer: string) { fixture.register(bearer) }
} }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
it('imports without starting and consumes the exact runtime credential only when the host creates config', async () => {
  vi.stubEnv('Crabot_MODULE_ID', 'voice-entry-fixture')
  vi.stubEnv('Crabot_PORT', '19099')
  vi.stubEnv('CRABOT_VOICE_RUNTIME_BEARER', 'fixture-runtime-secret')
  const plugin = await import('./main.js')
  expect(fixture.config).not.toHaveBeenCalled()
  expect(fixture.start).not.toHaveBeenCalled()
  expect(process.env.CRABOT_VOICE_RUNTIME_BEARER).toBe('fixture-runtime-secret')
  const config = plugin.createConfig(process.env)
  expect(config).toMatchObject({ module_id: 'voice-entry-fixture', protocol_version: '0.9.0', runtime_bearer: 'fixture-runtime-secret' })
  expect(process.env.CRABOT_VOICE_RUNTIME_BEARER).toBeUndefined()
  await plugin.apply({} as any, config)
  expect(fixture.config).toHaveBeenCalledWith(expect.objectContaining({ protocolVersion: '0.9.0' }), expect.any(String), 'fixture-runtime-secret')
  expect(fixture.mount).toHaveBeenCalledOnce()
  expect(fixture.register).not.toHaveBeenCalled()
  const descriptor = await fs.readFile(new URL('../crabot-module.yaml', import.meta.url), 'utf8')
  expect(descriptor).toMatch(/^protocol_version: "0\.9\.0"$/m)
})
