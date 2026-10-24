import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { voiceOutputPort } from '../../src/manager/voice-output-port.js'
import type { VoiceDeliveryRecord } from '../../src/manager/voice-output.js'

const record = (status = 'queued') => ({ playback_id: randomUUID(), channel_id: 'voice', session_id: 'group', turn_id: randomUUID(), text: '刚才那份资料我找到了。', status,
  binding: { channel_id: 'voice', session_id: 'group', response_id: randomUUID(), request_id: 'request-a', worker_id: 'worker-a', worker_turn_id: 'turn-a' } }) as VoiceDeliveryRecord

describe('durable voice delivery responsibility', () => {
  it('restores long v3 text and completion without weakening legacy validation or replaying', () => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
    try {
      const send = vi.fn(), port = voiceOutputPort(directory, () => true, send)
      const item = { ...record('completed'), text: '完整的长回答。'.repeat(100), played_samples: 3_000_000_000, sent_at: new Date().toISOString() }
      port.save(item)
      const file = join(directory, item.playback_id + '.json')
      expect(JSON.parse(readFileSync(file, 'utf8')).storage_version).toBe(3)
      expect(voiceOutputPort(directory, () => true, send).records()).toEqual([item])
      expect(send).not.toHaveBeenCalled()
      const legacy = JSON.stringify({ storage_version: 2, delivery: item }); writeFileSync(file, legacy)
      expect(() => port.records()).toThrow('legacy')
      expect(readFileSync(file, 'utf8')).toBe(legacy)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('retains all queued results across restart instead of the last three display records', () => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
    try {
      const send = vi.fn(), port = voiceOutputPort(directory, () => true, send)
      const queued = Array.from({ length: 6 }, () => record())
      for (const item of queued) port.save(item)
      const restored = voiceOutputPort(directory, () => true, send).records()
      expect(restored.map(item => item.playback_id).sort()).toEqual(queued.map(item => item.playback_id).sort())
      expect(restored.every(item => item.status === 'queued')).toBe(true)
      expect(send).not.toHaveBeenCalled()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('never upgrades incomplete old playback into pending automatic delivery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
    try {
      const item = record('streaming'); delete item.binding
      const file = join(directory, item.playback_id + '.json')
      writeFileSync(file, JSON.stringify(item))
      const restored = voiceOutputPort(directory, () => true, vi.fn()).records()
      expect(restored[0].status).toBe('unknown')
      expect(JSON.parse(readFileSync(file, 'utf8')).status).toBe('streaming')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('does not expose or send records whose target differs from their fixed binding', () => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
    try {
      const item = record(); item.binding!.session_id = 'another-group'
      writeFileSync(join(directory, item.playback_id + '.json'), JSON.stringify({ storage_version: 2, delivery: item }))
      expect(() => voiceOutputPort(directory, () => true, vi.fn()).records()).toThrow()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

import { TaggedVoiceOutput } from '../../src/manager/voice-output.js'

describe.each(['resume', 'same-block'])('queued result before terminal opening: %s', mode => {
  it.each(['<voice_reply>', '<voice_reply></voice_reply>', '<voice_reply> \n', '<voice_reply><nested>'])('preserves the original durable result for %j', async source => {
    const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
    try {
      const send = vi.fn(), prepare = vi.fn(), port = voiceOutputPort(directory, () => true, send)
      const original = { ...record(), block_index: 0 }; port.save(original)
      const before = readFileSync(join(directory, original.playback_id + '.json'), 'utf8')
      const output = new TaggedVoiceOutput({ ...port, prepare }, () => undefined, vi.fn(), () => original.binding, mode === 'resume' ? () => original : undefined)
      const consumer = output.consumer()
      await consumer.write(source); await consumer.finish(); await consumer.abort()
      expect(readFileSync(join(directory, original.playback_id + '.json'), 'utf8')).toBe(before)
      expect(voiceOutputPort(directory, () => true, send).records()).toEqual([original])
      expect(send).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled()
      expect(consumer.externallyCommitted).toBe(false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

it.each([false, true])('preserves queued fallback after start failure but never restores it after text was external: %s', async textAccepted => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
  try {
    const original = { ...record(), block_index: 0 }
    const send = vi.fn(async (params: import('crabot-shared').VoiceOutputParams) => {
      if (!textAccepted && params.event.type === 'reply_start') throw new Error('fixture start failed')
      return { accepted: true as const }
    })
    const port = voiceOutputPort(directory, () => true, send); port.save(original)
    const output = new TaggedVoiceOutput({ ...port, prepare: async () => ({ binding: original.binding!, connection_epoch: 'epoch', kind: 'notification' }) }, () => undefined, vi.fn(), () => original.binding, () => original)
    const consumer = output.consumer(); await consumer.write('<voice_reply>重新表达的结果'); await consumer.abort()
    const saved = port.records()[0]
    if (textAccepted) expect(saved).toMatchObject({ playback_id: original.playback_id, text: '重新表达的结果', status: 'unknown' })
    else expect(saved).toEqual(original)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('keeps a validated final tag for later delivery even with no live input turn', async () => {
  const records: VoiceDeliveryRecord[] = [], send = vi.fn()
  const binding = record().binding!
  const port = { isVoice: () => true, records: () => records, send,
    prepare: async () => undefined,
    save(item: VoiceDeliveryRecord) { const index = records.findIndex(r => r.playback_id === item.playback_id); if (index < 0) records.push(structuredClone(item)); else records[index] = structuredClone(item) } }
  const delivered = vi.fn()
  const output = new TaggedVoiceOutput(port, () => undefined, delivered, () => binding)
  const consumer = output.consumer()
  await consumer.write('<voice_reply>刚才那份资料我找到了。</voice_reply>'); await consumer.finish()
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ text: '刚才那份资料我找到了。', status: 'queued', binding })
  expect(consumer.externallyCommitted).toBe(true)
  expect(send).not.toHaveBeenCalled(); expect(delivered).not.toHaveBeenCalled()
})
it('does not queue unclosed or malformed tags as completed results', async () => {
  const records: VoiceDeliveryRecord[] = []
  const output = new TaggedVoiceOutput({ isVoice: () => true, records: () => records, send: vi.fn(), prepare: async () => undefined,
    save: r => { const i = records.findIndex(v => v.playback_id === r.playback_id); if (i < 0) records.push(structuredClone(r)); else records[i] = structuredClone(r) } }, () => undefined, vi.fn(), () => record().binding!)
  const consumer = output.consumer()
  await consumer.write('<voice_reply>尚未闭合'); await consumer.finish()
  expect(records.some(r => r.status === 'queued')).toBe(false)
})

it('delivers saved text after reconnect without reviving its old input turn or replaying it twice', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
  try {
    let enabled = false
    const events: import('crabot-shared').VoiceOutputParams[] = []
    const state = async () => ({ channel_id: 'voice', session_id: 'group', connection_epoch: 'new-epoch', foreground: true, speech_enabled: enabled, activity: 'idle' as const, current_turn_id: null })
    const send = vi.fn(async (params: import('crabot-shared').VoiceOutputParams) => {
      events.push(params)
      return params.event.type === 'reply_end' ? { platform_message_id: params.event.playback_id, played_samples: 480, sent_at: new Date().toISOString() } : { accepted: true as const }
    })
    const item = record()
    voiceOutputPort(directory, () => true, send).save(item)
    const port = voiceOutputPort(directory, () => true, send, { state, receipt: async id => ({ playback_id: id, status: 'unknown' }) })
    expect(await port.deliver!(item)).toBe(false); expect(send).not.toHaveBeenCalled()
    enabled = true
    expect(await port.deliver!(item)).toBe(true)
    expect(events.filter(event => event.event.type === 'reply_text')).toHaveLength(1)
    expect(events.every(event => event.delivery_context?.connection_epoch === 'new-epoch' && event.delivery_context.kind === 'notification' && event.voice_reply_context === undefined)).toBe(true)
    expect(port.records()[0]).toMatchObject({ status: 'completed', binding: item.binding })
    expect(await port.deliver!(item)).toBe(false)
    expect(events.filter(event => event.event.type === 'reply_text')).toHaveLength(1)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
it('marks an uncertain send as unknown and refuses automatic replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
  try {
    const item = record(), send = vi.fn(async (params: import('crabot-shared').VoiceOutputParams) => {
      if (params.event.type === 'reply_text') throw new Error('connection lost after text may have been played')
      return { accepted: true as const }
    })
    const port = voiceOutputPort(directory, () => true, send, {
      state: async () => ({ channel_id: 'voice', session_id: 'group', connection_epoch: 'epoch', foreground: true, speech_enabled: true, activity: 'idle', current_turn_id: null }),
      receipt: async id => ({ playback_id: id, status: 'unknown' }),
    })
    port.save(item)
    expect(await port.deliver!(item)).toBe(false)
    expect(port.records()[0].status).toBe('unknown')
    const calls = send.mock.calls.length
    expect(await port.deliver!(item)).toBe(false); expect(send).toHaveBeenCalledTimes(calls)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('deduplicates each original response independently after an earlier acknowledgement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
  try {
    const first = record().binding!, worker = record().binding!, delivered = vi.fn()
    const send = vi.fn(async (params: import('crabot-shared').VoiceOutputParams) => params.event.type === 'reply_end'
      ? { platform_message_id: params.event.playback_id, played_samples: 480, sent_at: new Date().toISOString() } : { accepted: true as const })
    const port = voiceOutputPort(directory, () => true, send, {
      state: async () => ({ channel_id: 'voice', session_id: 'group', connection_epoch: 'epoch', foreground: true, speech_enabled: true, activity: 'idle', current_turn_id: null }),
      receipt: async id => ({ playback_id: id, status: 'unknown' }),
    })
    let binding = first
    const output = new TaggedVoiceOutput(port, () => undefined, delivered, () => binding)
    await output.consumer().write('<voice_reply>好，我帮你看看。</voice_reply>')
    binding = worker
    await output.consumer().write('<voice_reply>刚才那份资料我找到了。</voice_reply>')
    const resumed = new TaggedVoiceOutput(port, () => undefined, delivered, () => worker)
    await resumed.consumer().write('<voice_reply>刚才那份资料我找到了。</voice_reply>')
    expect(send.mock.calls.filter(([params]) => params.event.type === 'reply_text')).toHaveLength(2)
    expect(port.records().filter(item => item.status === 'completed')).toHaveLength(2)
    expect(delivered).toHaveBeenCalledTimes(3)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('loads bounded batches while keeping older completion proofs and every unsent result', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
  try {
    const port = voiceOutputPort(directory, () => true, vi.fn())
    const old = { ...record('completed'), played_samples: 480, sent_at: new Date().toISOString() }
    port.save(old)
    for (let i = 0; i < 40; i++) port.save({ ...record('completed'), played_samples: 480, sent_at: new Date().toISOString() })
    const queued = Array.from({ length: 40 }, () => record())
    for (const item of queued) port.save(item)
    expect(port.records().filter(item => item.status === 'queued')).toHaveLength(32)
    expect(port.records().filter(item => item.status === 'completed')).toHaveLength(32)
    expect(port.find!(item => item.playback_id === old.playback_id)).toMatchObject(old)
    for (const item of port.records().filter(item => item.status === 'queued')) port.save({ ...item, status: 'completed', played_samples: 480, sent_at: new Date().toISOString() })
    expect(port.records().filter(item => item.status === 'queued')).toHaveLength(8)
    const restored = voiceOutputPort(directory, () => true, vi.fn())
    expect(restored.find!(item => item.playback_id === queued[39].playback_id)?.status).toBe('queued')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it.each([0, -1, 1.5, 480001])('rejects an invalid stored completed sample count: %s', samples => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
  try {
    const item = { ...record('completed'), played_samples: samples, sent_at: new Date().toISOString() }
    const file = join(directory, item.playback_id + '.json')
    writeFileSync(file, JSON.stringify({ storage_version: 2, delivery: item }))
    expect(() => voiceOutputPort(directory, () => true, vi.fn()).records()).toThrow('receipt')
    expect(JSON.parse(readFileSync(file, 'utf8')).delivery.played_samples).toBe(samples)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('does not borrow a later question to play an earlier Worker report', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
  try {
    const send = vi.fn(), delivered = vi.fn()
    const context = { channel_id: 'voice', session_id: 'group', turn_id: 'later-question', connection_epoch: 'epoch', expires_at: new Date(Date.now() + 60000).toISOString() }
    const port = voiceOutputPort(directory, () => true, send, {
      state: async () => ({ channel_id: 'voice', session_id: 'group', connection_epoch: 'epoch', foreground: true, speech_enabled: true, activity: 'processing', current_turn_id: 'later-question' }),
      receipt: async id => ({ playback_id: id, status: 'unknown' }),
    })
    const output = new TaggedVoiceOutput(port, () => context, delivered, () => record().binding!)
    await output.consumer().write('<voice_reply>刚才那份资料找到了。</voice_reply>')
    expect(port.records()[0].status).toBe('queued')
    expect(send).not.toHaveBeenCalled(); expect(delivered).not.toHaveBeenCalled()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('bounds receipt reconciliation without permanently skipping later uncertain results', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
  try {
    const receipt = vi.fn(async (id: string) => ({ playback_id: id, status: 'unknown' as const }))
    const port = voiceOutputPort(directory, () => true, vi.fn(), { state: vi.fn(), receipt })
    for (let index = 0; index < 10; index++) port.save(record('unknown'))
    await port.reconcile!(); expect(receipt).toHaveBeenCalledTimes(8)
    await port.reconcile!(); expect(new Set(receipt.mock.calls.map(([id]) => id)).size).toBe(10)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
it('does not close another response when notification preparation is refused', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-delivery-'))
  try {
    const item = record(), events: string[] = []
    const port = voiceOutputPort(directory, () => true, async params => { events.push(params.event.type); if (params.event.type === 'reply_start') throw new Error('now busy'); return { accepted: true } }, {
      state: async () => ({ channel_id: 'voice', session_id: 'group', connection_epoch: 'epoch', foreground: true, speech_enabled: true, activity: 'idle', current_turn_id: null }), receipt: vi.fn(),
    })
    port.save(item); expect(await port.deliver!(item)).toBe(false)
    expect(port.records()[0].status).toBe('queued')
    expect(events).not.toContain('response_end'); expect(events).not.toContain('reply_text')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
