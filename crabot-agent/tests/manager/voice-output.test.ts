import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { voiceOutputPort } from '../../src/manager/voice-output-port.js'
import { RpcCallError } from 'crabot-shared'
import { describe, expect, it } from 'vitest'
import { VoiceTagParser, TaggedVoiceOutput, type VoiceDeliveryRecord } from '../../src/manager/voice-output.js'

describe('voice tag streaming', () => {
  it('extracts only tagged text for every split, including adjacent tags', async () => {
    const source = 'internal<voice_reply>你好。</voice_reply>scratch<voice_reply>再见。</voice_reply>internal'
    for (let split = 0; split <= source.length; split++) {
      const events: string[] = []
      const parser = new VoiceTagParser(async (event, text) => { events.push(event + ':' + (text ?? '')) })
      await parser.write(source.slice(0, split)); await parser.write(source.slice(split)); parser.finish()
      expect(events.filter(e => e.startsWith('text:')).map(e => e.slice(5)).join('')).toBe('你好。再见。')
      expect(events.filter(e => e === 'end:')).toHaveLength(2)
    }
  })
  it('counts Unicode characters across split surrogate pairs and enforces the exact bound', async () => {
    const parser = new VoiceTagParser(async () => {})
    await parser.write('<voice_reply>')
    for (let i = 0; i < 120; i++) { await parser.write('😀'[0]); await parser.write('😀'[1]) }
    await parser.write('</voice_reply>'); parser.finish()
    const long = new VoiceTagParser(async () => {})
    await expect(long.write('<voice_reply>' + '字'.repeat(121))).rejects.toThrow('120')
  })

  it('preserves partial playback evidence without reporting formal delivery', async () => {
    const records: VoiceDeliveryRecord[] = [], delivered: string[] = []
    const context = { channel_id: 'voice', session_id: 'group', turn_id: 'turn', connection_epoch: 'epoch', expires_at: new Date(Date.now() + 60000).toISOString() }
    const output = new TaggedVoiceOutput({ isVoice: () => true, records: () => records, save: r => { records.push(structuredClone(r)) }, send: async ({ event }) => {
      if (event.type === 'reply_end') throw new RpcCallError('CHANNEL_SEND_FAILED', 'interrupted', { played_samples: 480, completed_text: '第一句。' })
      return { accepted: true }
    } }, () => context, record => { delivered.push(record.text) })
    const consumer = output.consumer(); await consumer.write('<voice_reply>第一句。第二句。</voice_reply>'); await consumer.finish()
    expect(consumer.externallyCommitted).toBe(true); expect(delivered).toEqual([])
    expect(records.at(-1)).toMatchObject({ status: 'unknown', played_samples: 480, completed_text: '第一句。' })
  })

  it('rejects nested and unclosed markup after yielding a short prefix', async () => {
    const texts: string[] = []
    const parser = new VoiceTagParser(async (event, text) => { if (event === 'text') texts.push(text!) })
    await parser.write('<voice_reply>已说。')
    expect(texts.join('')).toBe('已说。'); expect(() => parser.finish()).toThrow('Unclosed')
    await expect(parser.write('<voice_reply>nested')).rejects.toThrow('Invalid')
  })
  it('reloads unfinished durable delivery as unknown without restoring or replaying audio', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-records-'))
    try {
      const record: VoiceDeliveryRecord = { playback_id: '00112233-4455-6677-8899-aabbccddeeff', channel_id: 'voice', session_id: 'group', turn_id: 'turn', text: '部分回复。', status: 'streaming' }
      const send = async () => { throw new Error('Loading history must not send audio') }
      voiceOutputPort(directory, () => true, send).save(record)
      const loaded = voiceOutputPort(directory, () => true, send).records()
      expect(loaded).toEqual([{ ...record, status: 'unknown' }])
      expect(fs.statSync(path.join(directory, record.playback_id + '.json')).mode & 0o777).toBe(0o600)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })

  it('a canceled old turn cannot silence a new accepted turn in the same Manager episode', async () => {
    let context = { channel_id: 'voice', session_id: 'group', turn_id: 'old-turn', connection_epoch: 'epoch', expires_at: new Date(Date.now() + 60000).toISOString() }
    const delivered: string[] = []
    const output = new TaggedVoiceOutput({ isVoice: () => true, records: () => [], save: () => {}, send: async ({ event }) => {
      if (event.type === 'reply_end') return { platform_message_id: event.playback_id, sent_at: new Date().toISOString(), played_samples: 480 }
      return { accepted: true }
    } }, () => context, record => { delivered.push(record.turn_id) })
    const old = output.consumer(); await old.write('<voice_reply>旧回复。'); await old.abort()
    expect(output.committed).toBe(true)
    context = { ...context, turn_id: 'new-turn' }; expect(output.committed).toBe(false)
    const fresh = output.consumer(); await fresh.write('<voice_reply>新回复。</voice_reply>'); await fresh.finish()
    expect(delivered).toEqual(['new-turn'])
  })

  it('keeps formal delivery distinct from early text, failure and retry', async () => {
    const records: VoiceDeliveryRecord[] = [], events: string[] = [], delivered: string[] = []
    const context = { channel_id: 'voice', session_id: 'group', turn_id: 'turn', connection_epoch: 'epoch', expires_at: new Date(Date.now() + 60000).toISOString() }
    const output = new TaggedVoiceOutput({ isVoice: () => true, records: () => records,
      save: record => { records.push(structuredClone(record)) }, send: async params => {
        events.push(params.event.type)
        if (params.event.type === 'reply_end') return { platform_message_id: params.event.playback_id, sent_at: new Date().toISOString(), played_samples: 480 }
        return { accepted: true }
      } }, () => context, record => { delivered.push(record.text) })
    const consumer = output.consumer()
    await consumer.write('<voice_reply>你好。')
    expect(consumer.externallyCommitted).toBe(true); expect(delivered).toHaveLength(0)
    await consumer.write('</voice_reply>'); await consumer.finish()
    expect(delivered).toEqual(['你好。']); expect(output.notes()).toContain('completed')
    const failed = output.consumer(); await failed.write('<voice_reply>部分。'); await failed.abort()
    expect(output.notes()).toContain('unknown'); expect(delivered).toHaveLength(1)
    await output.finishResponse(); expect(events.at(-1)).toBe('response_end')
  })
})
