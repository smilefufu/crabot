import { randomUUID } from 'node:crypto'
import { RpcCallError } from 'crabot-shared'
import type { VoiceOutputParams, VoiceOutputResult, VoiceReplyContext } from 'crabot-shared'
import type { AssistantTextConsumer } from '../engine/llm-adapter-types.js'

export interface VoiceDeliveryRecord {
  playback_id: string
  channel_id: string
  session_id: string
  turn_id: string
  text: string
  status: 'prepared' | 'streaming' | 'completed' | 'failed' | 'unknown'
  played_samples?: number
  completed_text?: string
  sent_at?: string
}
export interface VoiceOutputPort {
  isVoice(): boolean
  send(params: VoiceOutputParams): Promise<VoiceOutputResult>
  save(record: VoiceDeliveryRecord): void
  records(): VoiceDeliveryRecord[]
}

const OPEN = '<voice_reply>', CLOSE = '</voice_reply>'
export class VoiceTagParser {
  private pending = ''
  private inside = false
  private length = 0
  constructor(private readonly emit: (event: 'start' | 'text' | 'end', text?: string) => Promise<void>) {}
  async write(text: string): Promise<void> {
    this.pending += text
    for (;;) {
      if (!this.inside) {
        const at = this.pending.indexOf(OPEN)
        if (at < 0) { this.pending = this.partial(OPEN); return }
        this.pending = this.pending.slice(at + OPEN.length); this.inside = true; this.length = 0
        await this.emit('start')
      }
      const at = this.pending.indexOf('<')
      if (at < 0) {
        const tail = /[\uD800-\uDBFF]$/.test(this.pending) ? this.pending.slice(-1) : ''
        await this.body(this.pending.slice(0, this.pending.length - tail.length)); this.pending = tail; return
      }
      await this.body(this.pending.slice(0, at)); this.pending = this.pending.slice(at)
      if (this.pending.length < CLOSE.length && CLOSE.startsWith(this.pending)) return
      if (!this.pending.startsWith(CLOSE)) throw new Error('Invalid nested or attributed voice tag')
      this.pending = this.pending.slice(CLOSE.length); this.inside = false
      await this.emit('end')
    }
  }
  finish(): void { if (this.inside) throw new Error('Unclosed voice tag') }
  private partial(marker: string): string {
    for (let n = Math.min(marker.length - 1, this.pending.length); n > 0; n--) {
      if (this.pending.endsWith(marker.slice(0, n))) return marker.slice(0, n)
    }
    return ''
  }
  private async body(text: string): Promise<void> {
    if (!text) return
    this.length += Array.from(text).length
    if (this.length > 120) throw new Error('Voice reply exceeds 120 characters')
    await this.emit('text', text)
  }
}

export class TaggedVoiceOutput {
  private readonly committedTurns = new Set<string>()
  private readonly disabledTurns = new Set<string>()
  completed = false
  get committed(): boolean {
    const context = this.context()
    return !!context && this.committedTurns.has(context.turn_id)
  }
  constructor(private readonly port: VoiceOutputPort, private readonly context: () => VoiceReplyContext | undefined,
    private readonly delivered: (record: VoiceDeliveryRecord) => void) {}
  notes(): string {
    const facts = this.port.records().slice(-3).map(({ text, status, played_samples, completed_text }) => ({ text, status, played_samples, completed_text }))
    return facts.length ? '\n\n语音交付事实（运行时记录；只有 completed 表示全文已播出，其它状态不能当作人类已听到全文）：\n' + JSON.stringify(facts) : ''
  }
  consumer(): AssistantTextConsumer {
    const context = this.context()
    let record: VoiceDeliveryRecord | undefined, sequence = 0, committed = false, broken = false
    const send = (event: VoiceOutputParams['event']) => this.port.send({ voice_reply_context: context!, event })
    const save = (): void => { if (record) this.port.save(record) }
    const cancel = async (): Promise<void> => {
      if (!record || record.status === 'completed') return
      record.status = record.status === 'streaming' ? 'unknown' : 'failed'
      try { save() } finally {
        try { await send({ type: 'reply_cancel', playback_id: record.playback_id }) } catch { /* no replay */ }
        record = undefined
      }
    }
    const parser = new VoiceTagParser(async (event, text) => {
      if (!context || this.disabledTurns.has(context.turn_id)) return
      if (event === 'start') {
        record = { playback_id: randomUUID(), channel_id: context.channel_id, session_id: context.session_id, turn_id: context.turn_id, text: '', status: 'prepared' }
        sequence = 0; save()
        await send({ type: 'reply_start', playback_id: record.playback_id })
      } else if (event === 'text' && record) {
        record.text += text!; record.status = 'streaming'; save()
        committed = true; this.committedTurns.add(context.turn_id)
        await send({ type: 'reply_text', playback_id: record.playback_id, sequence: sequence++, text: text! })
      } else if (event === 'end' && record) {
        if (!record.text.trim()) { await cancel(); return }
        const result = await send({ type: 'reply_end', playback_id: record.playback_id })
        if (!('platform_message_id' in result) || result.platform_message_id !== record.playback_id
          || !Number.isSafeInteger(result.played_samples) || result.played_samples <= 0 || !Number.isFinite(Date.parse(result.sent_at))) throw new Error('Invalid voice completion receipt')
        record.status = 'completed'; record.played_samples = result.played_samples; record.sent_at = result.sent_at; save()
        this.completed = true; this.delivered(record); record = undefined
      }
    })
    const fail = async (error?: unknown): Promise<void> => {
      broken = true; if (committed && context) this.disabledTurns.add(context.turn_id)
      if (record && error instanceof RpcCallError && error.details) {
        const samples = error.details.played_samples, text = error.details.completed_text
        if (Number.isSafeInteger(samples) && (samples as number) >= 0 && (samples as number) <= 480000) record.played_samples = samples as number
        if (typeof text === 'string' && Array.from(text).length <= 120) record.completed_text = text
      }
      await cancel()
    }
    return {
      get externallyCommitted() { return committed },
      write: async text => { if (broken) return; try { await parser.write(text) } catch (error) { await fail(error) } },
      finish: async () => { if (broken) return; try { parser.finish() } catch (error) { await fail(error) } },
      abort: fail,
    }
  }
  async finishResponse(): Promise<void> {
    const context = this.context()
    if (context) try { await this.port.send({ voice_reply_context: context, event: { type: 'response_end' } }) } catch { /* stale interaction is never revived */ }
  }
}
