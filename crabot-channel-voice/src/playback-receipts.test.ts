import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PlaybackReceipts } from './playback-receipts.js'

const binding = { channel_id: 'voice', session_id: 'group', response_id: 'original-response', worker_id: 'worker', worker_turn_id: 'worker-turn' }
describe('playback facts survive reconnect without replay instructions', () => {
  it('persists long v2 completion but never restores active or rewrites valid v1 history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-receipt-'))
    try {
      const id = randomUUID(), store = new PlaybackReceipts(directory)
      store.prepare(id, 'terminal-a', binding); store.ending(id, 3_000_000_000)
      store.report({ playback_id: id, status: 'completed', played_samples: 3_000_000_000 }, 'terminal-a')
      expect(new PlaybackReceipts(directory).get(id, 'voice', 'group').played_samples).toBe(3_000_000_000)
      const file = join(directory, id + '.json'), raw = JSON.parse(readFileSync(file, 'utf8'))
      expect(raw.storage_version).toBe(2)
      raw.receipt.status = 'active'; writeFileSync(file, JSON.stringify(raw))
      expect(() => store.get(id, 'voice', 'group')).toThrow()
      raw.storage_version = 1; raw.expected_samples = 480; raw.receipt.status = 'completed'; raw.receipt.played_samples = 480
      const legacy = JSON.stringify(raw); writeFileSync(file, legacy)
      expect(store.get(id, 'voice', 'group').status).toBe('completed')
      expect(readFileSync(file, 'utf8')).toBe(legacy)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('requires original preparation, same terminal, final sample count and actual completion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-receipt-'))
    try {
      const id = randomUUID(), store = new PlaybackReceipts(directory)
      store.prepare(id, 'terminal-a', binding)
      expect(store.report({ playback_id: id, status: 'completed', played_samples: 480 }, 'terminal-a')).toBeUndefined()
      store.ending(id, 480)
      expect(store.report({ playback_id: id, status: 'completed', played_samples: 480 }, 'terminal-b')).toBeUndefined()
      expect(store.report({ playback_id: id, status: 'completed', played_samples: 479 }, 'terminal-a')).toBeUndefined()
      const restored = new PlaybackReceipts(directory)
      const report = { playback_id: id, status: 'completed' as const, played_samples: 480 }
      const first = restored.report(report, 'terminal-a')
      expect(first).toMatchObject({ status: 'completed', played_samples: 480 })
      expect(restored.report(report, 'terminal-a')).toEqual(first)
      expect(() => restored.prepare(id, 'terminal-a', binding)).toThrow()
      expect(() => restored.get(id, 'voice', 'other-group')).toThrow()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('cannot upgrade an interrupted playback or a malformed persisted record', () => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-receipt-'))
    try {
      const id = randomUUID(), store = new PlaybackReceipts(directory)
      store.prepare(id, 'terminal-a', binding); store.ending(id, 480)
      store.report({ playback_id: id, status: 'interrupted', played_samples: 100 }, 'terminal-a')
      expect(store.report({ playback_id: id, status: 'completed', played_samples: 480 }, 'terminal-a')).toBeUndefined()
      expect(store.get(id, 'voice', 'group').status).toBe('interrupted')
      const file = join(directory, id + '.json'), original = '{"storage_version":999}'
      writeFileSync(file, original)
      expect(() => store.get(id, 'voice', 'group')).toThrow(); expect(readFileSync(file, 'utf8')).toBe(original)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

it('preserves and refuses a completed record without verified final samples', () => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-receipt-'))
  try {
    const id = randomUUID(), file = join(directory, id + '.json')
    const text = JSON.stringify({ storage_version: 1, terminal_id: 'terminal-a', binding,
      receipt: { playback_id: id, status: 'completed', played_samples: 480, sent_at: new Date().toISOString() } })
    writeFileSync(file, text)
    expect(() => new PlaybackReceipts(directory).get(id, 'voice', 'group')).toThrow('completed')
    expect(readFileSync(file, 'utf8')).toBe(text)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
