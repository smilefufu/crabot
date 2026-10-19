import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertVoiceUuid, type VoiceDeliveryBinding, type VoicePlaybackReceipt, type VoicePlaybackReport } from 'crabot-shared'

interface StoredReceipt {
  storage_version: 1 | 2
  terminal_id: string
  binding: VoiceDeliveryBinding
  expected_samples?: number
  receipt: VoicePlaybackReceipt
}

/** Only playback metadata is durable; neither PCM nor a replay instruction is saved. */
export class PlaybackReceipts {
  constructor(private readonly directory: string) {}
  private file(id: string): string { assertVoiceUuid(id); return path.join(this.directory, id + '.json') }
  private read(id: string): StoredReceipt | undefined {
    const file = this.file(id)
    let raw: StoredReceipt
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (![1, 2].includes(raw.storage_version) || raw.receipt?.playback_id !== id || typeof raw.terminal_id !== 'string' || !raw.terminal_id
      || !raw.binding?.channel_id || !raw.binding.session_id || !raw.binding.response_id || (!!raw.binding.worker_id !== !!raw.binding.worker_turn_id)
      || !['unknown', 'completed', 'interrupted', 'failed'].includes(raw.receipt.status)) throw new Error('Invalid playback receipt; original file preserved')
    const maximum = raw.storage_version === 1 ? 480000 : Number.MAX_SAFE_INTEGER
    if (raw.expected_samples !== undefined && (!Number.isSafeInteger(raw.expected_samples) || raw.expected_samples < 1 || raw.expected_samples > maximum)) throw new Error('Invalid final playback sample count')
    const receipt = raw.receipt
    if (receipt.played_samples !== undefined && (!Number.isSafeInteger(receipt.played_samples) || receipt.played_samples < 0 || receipt.played_samples > maximum)) throw new Error('Invalid played sample count')
    if (receipt.status === 'completed' && (!raw.expected_samples || receipt.played_samples !== raw.expected_samples || !receipt.sent_at || !Number.isFinite(Date.parse(receipt.sent_at)))) throw new Error('Invalid completed playback receipt')
    return raw
  }
  private save(record: StoredReceipt): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const file = this.file(record.receipt.playback_id), temp = file + '.' + randomUUID() + '.tmp'
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(descriptor, JSON.stringify({ ...record, storage_version: 2 })); fs.fsyncSync(descriptor)
      fs.closeSync(descriptor); descriptor = undefined; fs.renameSync(temp, file)
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); fs.rmSync(temp, { force: true }) }
  }
  prepare(id: string, terminalId: string, binding: VoiceDeliveryBinding): void {
    const old = this.read(id)
    if (old) {
      if (old.receipt.status === 'unknown' && old.expected_samples === undefined && old.terminal_id === terminalId && JSON.stringify(old.binding) === JSON.stringify(binding)) return
      throw new Error('A persisted playback identity cannot be replayed')
    }
    this.save({ storage_version: 1, terminal_id: terminalId, binding: structuredClone(binding), receipt: { playback_id: id, status: 'unknown' } })
  }
  ending(id: string, sampleCount: number): void {
    const record = this.read(id)
    if (!record || !Number.isSafeInteger(sampleCount) || sampleCount < 1) throw new Error('Playback end has no valid preparation')
    record.expected_samples = sampleCount; this.save(record)
  }
  report(report: VoicePlaybackReport, terminalId: string): VoicePlaybackReceipt | undefined {
    const record = this.read(report.playback_id)
    if (!record || record.terminal_id !== terminalId) return
    if (record.receipt.status === 'completed') return structuredClone(record.receipt)
    if (report.status === 'started') return
    if (report.played_samples !== undefined && (!Number.isSafeInteger(report.played_samples) || report.played_samples < 0)) return
    if (report.status === 'completed' && (record.receipt.status !== 'unknown' || report.played_samples !== record.expected_samples || !report.played_samples)) return
    record.receipt = { playback_id: report.playback_id, status: report.status,
      ...(report.played_samples !== undefined ? { played_samples: report.played_samples } : {}), ...(report.status === 'completed' ? { sent_at: new Date().toISOString() } : {}) }
    this.save(record); return structuredClone(record.receipt)
  }
  get(id: string, channelId: string, sessionId: string): VoicePlaybackReceipt {
    const record = this.read(id)
    if (record && (record.binding.channel_id !== channelId || record.binding.session_id !== sessionId)) throw new Error('Playback receipt target differs')
    return structuredClone(record?.receipt ?? { playback_id: id, status: 'unknown' })
  }
}
