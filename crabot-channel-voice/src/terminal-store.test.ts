import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TerminalStore } from './terminal-store.js'

describe('voice WIP pairing version boundary', () => {
  it('preserves incompatible metadata and never accepts an old credential', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-pairing-version-'))
    try {
      const terminal = new TerminalStore(dir); await terminal.load(); const credential = await terminal.pair()
      expect(terminal.matches(credential)).toBe(true)
      const file = path.join(dir, 'terminal.json'), old = JSON.parse(await fs.readFile(file, 'utf8'))
      delete old.protocol_version; await fs.writeFile(file, JSON.stringify(old))
      await expect(new TerminalStore(dir).load()).rejects.toThrow(/incompatible/i)
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(old)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
