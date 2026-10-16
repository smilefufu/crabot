import { describe, expect, it } from 'vitest'
import { defaultVoiceConnection } from './VoicePairing'

describe('Voice connection defaults', () => {
  it('keeps the saved manual transport and full path ahead of changing global defaults', () => {
    const saved = { base_url: 'https://saved.test/prefix', transport: 'ws' as const }
    expect(defaultVoiceConnection(saved, 'https://new.test', 'http://192.168.1.2:3000', [])).toEqual(saved)
    expect(defaultVoiceConnection(null, 'https://proxy.test/crabot', 'http://192.168.1.2:3000', [])).toEqual({ base_url: 'https://proxy.test/crabot', transport: 'wss' })
  })
  it('never auto-selects localhost or link-local and uses actual Admin LAN port candidates', () => {
    expect(defaultVoiceConnection(null, 'http://127.0.0.1:3000', 'http://localhost:5173', ['http://169.254.1.2:3000', 'http://192.168.1.2:3080'])).toEqual({ base_url: 'http://192.168.1.2:3080', transport: 'ws' })
    expect(defaultVoiceConnection(null, undefined, 'http://[::1]:3000', [])).toBeUndefined()
  })
})
