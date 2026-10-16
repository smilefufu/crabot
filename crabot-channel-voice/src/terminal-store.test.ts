import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadVoiceTls } from '../../crabot-admin/src/voice-tls.js'
import { createHash } from 'node:crypto'
import { TerminalStore } from './terminal-store.js'

describe('voice WIP pairing version boundary', () => {
  it('migrates valid v2 credential verification material atomically without retaining old TLS keys', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-valid-v2-'))
    try {
      const tls = await loadVoiceTls(path.join(dir, 'admin'))
      const credential = 'fixture-only-existing-credential'
      const old = { protocol_version: 2, cert: tls.cert, key: tls.key, credential_hash: createHash('sha256').update(credential).digest('hex') }
      const file = path.join(dir, 'terminal.json'); await fs.writeFile(file, JSON.stringify(old))
      const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('storage unavailable'))
      await expect(new TerminalStore(dir).load()).rejects.toThrow('storage unavailable')
      rename.mockRestore(); expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(old)
      const store = new TerminalStore(dir); await store.load()
      expect(store.matches(credential)).toBe(true)
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ storage_version: 1, credential_hash: old.credential_hash })
    } finally { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('preserves incompatible metadata and never accepts an old credential', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-pairing-version-'))
    try {
      const terminal = new TerminalStore(dir); await terminal.load(); const credential = await terminal.pair()
      expect(terminal.matches(credential)).toBe(true)
      const file = path.join(dir, 'terminal.json'), old = JSON.parse(await fs.readFile(file, 'utf8'))
      delete old.storage_version; await fs.writeFile(file, JSON.stringify(old))
      await expect(new TerminalStore(dir).load()).rejects.toThrow(/incompatible/i)
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(old)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
