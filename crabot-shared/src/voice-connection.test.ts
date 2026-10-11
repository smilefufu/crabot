import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseVoiceConnection, voiceSetupStatus, voiceTerminalEntry } from './voice-connection.js'

describe('voice Admin entry', () => {
  for (const [base_url, transport, url] of [
    ['http://phone.test:3000', 'wss', 'wss://phone.test:3000/ws/voice/%E6%89%8B%E6%9C%BA'],
    ['https://phone.test/prefix/', 'wss', 'wss://phone.test/prefix/ws/voice/%E6%89%8B%E6%9C%BA'],
    ['https://phone.test', 'ws', 'ws://phone.test:443/ws/voice/%E6%89%8B%E6%9C%BA'],
    ['http://phone.test', 'wss', 'wss://phone.test:80/ws/voice/%E6%89%8B%E6%9C%BA'],
    ['http://[fd00::1]:3000/p', 'ws', 'ws://[fd00::1]:3000/p/ws/voice/%E6%89%8B%E6%9C%BA'],
  ] as const) it(`preserves original effective port and prefix: ${base_url} ${transport}`, () => {
    assert.deepEqual(voiceTerminalEntry({ base_url, transport }, '手机'), { url })
  })
  for (const base_url of ['ws://phone.test', 'http://u:p@phone.test', 'http://phone.test/?q=1', 'http://phone.test/#x', 'http://phone.test/a/../b', 'http://phone.test/%2e%2e/b', 'http://phone.test/%2fvoice', 'http://[fe80::1]:3000']) it(`rejects ambiguous or unusable base URL ${base_url}`, () => {
    assert.throws(() => parseVoiceConnection({ base_url, transport: 'ws' }))
  })
  it('does not attach TLS to WS or reinterpret malformed metadata as a legacy complete instance', () => {
    assert.equal(voiceTerminalEntry({ base_url: 'http://phone.test:3000', transport: 'ws' }, 'phone', 'a'.repeat(64)).tls_fingerprint_sha256, undefined)
    assert.equal(voiceSetupStatus(), 'complete')
    assert.equal(voiceSetupStatus({ status: 'draft' }), 'draft')
    assert.throws(() => voiceSetupStatus({ status: 'invalid' } as never))
    assert.throws(() => voiceSetupStatus(null as never))
  })
})
