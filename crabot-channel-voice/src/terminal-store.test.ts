import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadVoiceTls } from '../../crabot-admin/src/voice-tls.js'
import { createHash, randomUUID } from 'node:crypto'
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
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ storage_version: 2, credential_hash: old.credential_hash })
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
  it('keeps pending credential verification recoverable without declaring activation success', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-pending-owner-'))
    try {
      const operation = randomUUID(), store = new TerminalStore(dir); await store.load()
      const first = await store.pair(operation)
      expect(store.paired).toBe(false); expect(store.pendingActivation).toBe(operation); expect(store.matches(first)).toBe(true)
      const restored = new TerminalStore(dir); await restored.load()
      expect(restored.paired).toBe(false); expect(restored.matches(first)).toBe(true)
      await expect(restored.activate(randomUUID())).rejects.toThrow()
      await expect(restored.pair(randomUUID())).rejects.toThrow()
      const rotated = await restored.pair(operation)
      expect(restored.matches(first)).toBe(false); expect(restored.matches(rotated)).toBe(true)
      expect(await fs.readFile(path.join(dir, 'terminal.json'), 'utf8')).not.toContain(rotated)
      await restored.activate(operation); await restored.activate(operation)
      expect(restored.paired).toBe(true); expect(restored.pendingActivation).toBeUndefined()
      await expect(restored.pair(operation)).rejects.toThrow(/already paired/)
      await restored.revoke(); expect(restored.matches(rotated)).toBe(false)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('migration backs up v1 hash material and never guesses a pending activation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-v1-owner-'))
    try {
      const original = JSON.stringify({ storage_version: 1, credential_hash: createHash('sha256').update('legacy-credential').digest('hex') })
      await fs.writeFile(path.join(dir, 'terminal.json'), original)
      const store = new TerminalStore(dir); await store.load()
      expect(store.paired).toBe(true); expect(store.matches('legacy-credential')).toBe(true); expect(store.pendingActivation).toBeUndefined()
      expect(await fs.readFile(path.join(dir, 'terminal.json.v1.bak'), 'utf8')).toBe(original)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('failed activation commit preserves the pending hash and allows retry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-owner-write-failure-'))
    try {
      const operation = randomUUID(), store = new TerminalStore(dir); await store.load(); const credential = await store.pair(operation)
      const before = await fs.readFile(path.join(dir, 'terminal.json'))
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected activation failure'))
      await expect(store.activate(operation)).rejects.toThrow('injected')
      expect(store.paired).toBe(false); expect(store.matches(credential)).toBe(true)
      expect(await fs.readFile(path.join(dir, 'terminal.json'))).toEqual(before)
      await store.activate(operation); expect(store.paired).toBe(true)
    } finally { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }) }
  })

})
