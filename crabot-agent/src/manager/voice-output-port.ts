import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { VoiceOutputParams, VoiceOutputResult, VoiceOutputState, VoicePlaybackReceipt } from 'crabot-shared'
import { findVoiceDelivery, type VoiceDeliveryRecord, type VoiceOutputPort } from './voice-output.js'

function validate(record: VoiceDeliveryRecord): void {
  if (!record || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.playback_id) || !record.channel_id || !record.session_id
    || typeof record.text !== 'string' || Array.from(record.text).length > 120
    || !['prepared', 'queued', 'streaming', 'completed', 'failed', 'unknown'].includes(record.status)) throw new Error('Invalid voice delivery record; original file preserved')
  if (typeof record.turn_id !== 'string' || !record.turn_id || (record.block_index !== undefined && (!Number.isSafeInteger(record.block_index) || record.block_index < 0))) throw new Error('Invalid voice result identity')
  if (record.receipt_handled !== undefined && (typeof record.receipt_handled !== 'boolean' || record.status !== 'completed')) throw new Error('Invalid voice receipt handling state')
  const binding = record.binding
  if (binding && (binding.channel_id !== record.channel_id || binding.session_id !== record.session_id || !binding.response_id
    || (!!binding.worker_id !== !!binding.worker_turn_id))) throw new Error('Voice delivery binding differs from its target')
  if (binding && record.status === 'completed' && (!Number.isSafeInteger(record.played_samples) || record.played_samples! <= 0 || record.played_samples! > 480000 || !record.sent_at || !Number.isFinite(Date.parse(record.sent_at)))) throw new Error('Completed voice delivery has no valid playback receipt')
  if (record.status === 'queued' && (!binding || !record.text.trim())) throw new Error('Queued voice result has no verified binding or text')
}

export function voiceOutputPort(directory: string, isVoice: () => boolean,
  send: (params: VoiceOutputParams) => Promise<VoiceOutputResult>, transport?: {
    state(): Promise<VoiceOutputState>
    receipt(id: string): Promise<VoicePlaybackReceipt>
  }): VoiceOutputPort {
  let serial: Promise<unknown> = Promise.resolve()
  let receiptCursor = ''
  const files = (): string[] => fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name))
    .map(name => ({ name, time: fs.statSync(path.join(directory, name)).mtimeMs })).sort((a, b) => a.time - b.time).map(item => item.name) : []
  const read = (name: string): VoiceDeliveryRecord => {
    const raw = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
    if (raw.storage_version !== undefined && raw.storage_version !== 2) throw new Error('Unsupported voice delivery version; original file preserved')
    if (raw.storage_version === undefined && raw.binding !== undefined) throw new Error('Bound voice delivery requires its versioned format; original file preserved')
    const record: VoiceDeliveryRecord = raw.storage_version === 2 ? raw.delivery : raw
    validate(record)
    if (name !== record.playback_id + '.json') throw new Error('Voice delivery filename differs from its identity')
    if (record.status === 'prepared' || record.status === 'streaming') record.status = 'unknown'
    return record
  }
  const records = (): VoiceDeliveryRecord[] => {
    const pending: VoiceDeliveryRecord[] = [], uncertain: VoiceDeliveryRecord[] = [], completed: VoiceDeliveryRecord[] = [], recent: VoiceDeliveryRecord[] = []
    for (const name of files()) {
      const record = read(name)
      if (record.status === 'queued') { if (pending.length < 32) pending.push(record) }
      else if (record.status === 'unknown') { if (uncertain.length < 32) uncertain.push(record) }
      else if (record.status === 'completed' && record.binding && !record.receipt_handled) { if (completed.length < 32) completed.push(record) }
      else { recent.push(record); if (recent.length > 32) recent.shift() }
    }
    return [...pending, ...uncertain, ...completed, ...recent]
  }
  const port: VoiceOutputPort = { isVoice, send, records,
    find: predicate => { for (const name of files()) { const record = read(name); if (predicate(record)) return record } return undefined },
    ...(transport ? { state: transport.state, prepare: async (record: VoiceDeliveryRecord, reply?: import('crabot-shared').VoiceReplyContext) => {
      let state: VoiceOutputState
      try { state = await transport.state() } catch { return undefined }
      if (state.channel_id !== record.channel_id || state.session_id !== record.session_id) throw new Error('Voice availability target differs')
      if (!state.connection_epoch || !state.foreground || !state.speech_enabled || !record.binding) return undefined
      const replying = reply && reply.turn_id === state.current_turn_id && Date.parse(reply.expires_at) > Date.now()
      if (!replying && state.activity !== 'idle') return undefined
      const earlier = !replying && records().find(item => item.status === 'queued')
      if (earlier && earlier.playback_id !== record.playback_id) return undefined
      if (['recording', 'management'].includes(state.activity)) return undefined
      return { binding: structuredClone(record.binding), connection_epoch: state.connection_epoch,
        kind: replying ? 'reply' as const : 'notification' as const, ...(replying ? { turn_id: reply.turn_id } : {}) }
    }, reconcile: async () => {
      const names = files(), start = names.indexOf(receiptCursor) + 1
      let checked = 0
      for (let index = 0; index < names.length && checked < 8; index++) {
        const name = names[(start + index) % names.length], record = read(name)
        if (!record.binding || record.status !== 'unknown') continue
        checked++; receiptCursor = name
        const receipt = await transport.receipt(record.playback_id)
        if (receipt.playback_id !== record.playback_id) throw new Error('Voice receipt identity differs')
        if (receipt.status === 'completed') {
          record.status = 'completed'; record.played_samples = receipt.played_samples; record.sent_at = receipt.sent_at; port.save(record)
        }
      }
    }, updatePending: async () => {
      const state = await transport.state()
      if (!state.connection_epoch) return
      const pending = new Set<string>()
      for (const name of files()) { const record = read(name); if (record.status === 'queued') pending.add(record.binding!.response_id) }
      const count = pending.size
      await send({ delivery_context: { binding: { channel_id: state.channel_id, session_id: state.session_id, response_id: 'pending-results' }, connection_epoch: state.connection_epoch, kind: 'notification' }, event: { type: 'pending_results', count } })
    }, deliver: (candidate: VoiceDeliveryRecord) => {
      const operation = serial.then(async () => {
        const record = findVoiceDelivery(port, item => item.playback_id === candidate.playback_id && item.status === 'queued')
        if (!record || !record.binding) return false
        const context = await port.prepare!(record)
        if (!context) return false
        let started = false, textSent = false
        const output = (event: VoiceOutputParams['event']) => send({ delivery_context: context, event })
        try {
          await output({ type: 'reply_start', playback_id: record.playback_id }); started = true
          record.status = 'streaming'; port.save(record); textSent = true
          await output({ type: 'reply_text', playback_id: record.playback_id, sequence: 0, text: record.text })
          const receipt = await output({ type: 'reply_end', playback_id: record.playback_id })
          if (!('platform_message_id' in receipt) || receipt.platform_message_id !== record.playback_id || !Number.isSafeInteger(receipt.played_samples) || receipt.played_samples <= 0 || receipt.played_samples > 480000 || !Number.isFinite(Date.parse(receipt.sent_at))) throw new Error('Invalid voice completion receipt')
          record.status = 'completed'; record.played_samples = receipt.played_samples; record.sent_at = receipt.sent_at; port.save(record); return true
        } catch {
          record.status = textSent ? 'unknown' : 'queued'; port.save(record)
          try { await output({ type: 'reply_cancel', playback_id: record.playback_id }) } catch { /* never replay uncertain audio */ }
          return false
        } finally { if (started) try { await output({ type: 'response_end' }) } catch { /* closing this attempt does not delete pending results */ } }
      })
      serial = operation.catch(() => undefined); return operation
    } } : {}), save(record) {
    validate(record)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const filename = path.join(directory, record.playback_id + '.json'), temp = filename + '.' + randomUUID() + '.tmp'
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(temp, 'wx', 0o600)
      fs.writeFileSync(descriptor, JSON.stringify(record.binding ? { storage_version: 2, delivery: record } : record))
      fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined
      fs.renameSync(temp, filename)
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); fs.rmSync(temp, { force: true }) }
  } }
  return port
}
