import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'

const fixture = vi.hoisted(() => ({ config: vi.fn(), start: vi.fn(), register: vi.fn() }))
vi.mock('./voice-channel.js', () => ({ VoiceChannel: class {
  constructor(config: unknown) { fixture.config(config) }
  async start() { fixture.start() }
  async register(bearer: string) { fixture.register(bearer) }
} }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('registers the production entrypoint with the confirmed wire7 module version and consumes its runtime secret', async () => {
  vi.stubEnv('Crabot_MODULE_ID', 'voice-entry-fixture')
  vi.stubEnv('Crabot_PORT', '19099')
  vi.stubEnv('CRABOT_VOICE_RUNTIME_BEARER', 'fixture-runtime-secret')
  vi.spyOn(process, 'on').mockReturnValue(process)
  await import('./main.js')
  await vi.waitFor(() => expect(fixture.register).toHaveBeenCalledWith('fixture-runtime-secret'))
  expect(fixture.config).toHaveBeenCalledWith(expect.objectContaining({ protocolVersion: '0.7.0' }))
  const descriptor = await fs.readFile(new URL('../crabot-module.yaml', import.meta.url), 'utf8')
  expect(descriptor).toMatch(/^protocol_version: "0\.7\.0"$/m)
  expect(process.env.CRABOT_VOICE_RUNTIME_BEARER).toBeUndefined()
})
