import { randomUUID } from 'node:crypto'
import { RpcCallError } from 'crabot-shared'
import type { VoiceDeliveryBinding, VoicePlaybackContext, VoiceOutputState, VoiceOutputParams, VoiceOutputResult, VoiceReplyContext } from 'crabot-shared'
import type { AssistantTextConsumer } from '../engine/llm-adapter-types.js'
import { appendVoiceText, finishVoicePlayback } from './voice-output-flow.js'
import type { VoicePlaybackReceipt } from 'crabot-shared'

export interface VoiceDeliveryRecord {
  playback_id: string
  channel_id: string
  session_id: string
  turn_id: string
  text: string
  status: 'prepared' | 'queued' | 'streaming' | 'completed' | 'failed' | 'unknown'
  binding?: VoiceDeliveryBinding
  block_index?: number
  played_samples?: number
  completed_text?: string
  sent_at?: string
  receipt_handled?: boolean
}
export interface VoicePendingResult {
  delivery_id: string
  text: string
  binding: VoiceDeliveryBinding
  status?: 'queued' | 'completed'
  sent_at?: string
}
export interface VoiceOutputPort {
  isVoice(): boolean
  send(params: VoiceOutputParams): Promise<VoiceOutputResult>
  save(record: VoiceDeliveryRecord): void
  records(): VoiceDeliveryRecord[]
  find?(predicate: (record: VoiceDeliveryRecord) => boolean): VoiceDeliveryRecord | undefined
  state?(): Promise<VoiceOutputState>
  receipt?(id: string): Promise<VoicePlaybackReceipt>
  deliver?(record: VoiceDeliveryRecord): Promise<boolean>
  updatePending?(): Promise<void>
  reconcile?(): Promise<void>
  prepare?(record: VoiceDeliveryRecord, reply?: VoiceReplyContext): Promise<VoicePlaybackContext | undefined>
}

export function findVoiceDelivery(port: VoiceOutputPort, predicate: (record: VoiceDeliveryRecord) => boolean): VoiceDeliveryRecord | undefined {
  return port.find ? port.find(predicate) : port.records().find(predicate)
}

const OPEN = '<voice_reply>', CLOSE = '</voice_reply>'
export class VoiceTagParser {
  private pending = ''
  private inside = false
  constructor(private readonly emit: (event: 'start' | 'text' | 'end', text?: string) => Promise<void>) {}
  async write(text: string): Promise<void> {
    this.pending += text
    for (;;) {
      if (!this.inside) {
        const at = this.pending.indexOf(OPEN)
        if (at < 0) { this.pending = this.partial(OPEN); return }
        this.pending = this.pending.slice(at + OPEN.length); this.inside = true
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
    await this.emit('text', text)
  }
}

export class TaggedVoiceOutput {
  private readonly committedTurns = new Set<string>()
  private readonly disabledTurns = new Set<string>()
  completed = false
  private readonly blockIndexes = new Map<string, number>()
  private lastPlaybackContext?: VoicePlaybackContext
  get committed(): boolean {
    const context = this.context()
    const key = context?.turn_id ?? this.binding?.()?.response_id
    return !!key && this.committedTurns.has(key)
  }
  constructor(private readonly port: VoiceOutputPort, private readonly context: () => VoiceReplyContext | undefined,
    private readonly delivered: (record: VoiceDeliveryRecord) => void,
    private readonly binding?: () => VoiceDeliveryBinding | undefined,
    private readonly resumeRecord?: () => VoiceDeliveryRecord | undefined) {}
  notes(): string {
    const facts = this.port.records().slice(-3).map(({ text, status, played_samples, completed_text }) => ({ text, status, played_samples, completed_text }))
    return facts.length ? '\n\n语音交付事实由系统记录：待交付只是已保存；只有 completed 表示对应文字已完整播放，不证明人类实际听见。部分、取消或未知播放不能当作全文送达，不自动从头重说。终端恢复后需要衔接多项结果时，只整理这些原本允许回到当前会话的结果，给出各项核心结论，不重新执行任务，不混入私发正文或内部过程。\n' + JSON.stringify(facts) : ''
  }
  consumer(): AssistantTextConsumer {
    const context = this.context(), binding = this.binding?.(), key = context?.turn_id ?? binding?.response_id
    let original: VoiceDeliveryRecord | undefined
    let record: VoiceDeliveryRecord | undefined, sequence = 0, committed = false, broken = false, queued = false, opened = false
    let playbackContext: VoicePlaybackContext | undefined
    const cancellation = new AbortController()
    const send = (event: VoiceOutputParams['event']) => this.port.send(playbackContext
      ? { delivery_context: playbackContext, event } : { voice_reply_context: context!, event })
    const save = (): void => { if (record) this.port.save(record) }
    const cancel = async (): Promise<void> => {
      if (!record || record.status === 'completed') return
      if (queued && original) { this.port.save(original); record = undefined; return }
      record.status = !queued && record.status === 'streaming' ? 'unknown' : 'failed'
      try { save() } finally {
        if (opened && !queued) try { await send({ type: 'reply_cancel', playback_id: record.playback_id }) } catch { /* no replay */ }
        record = undefined
      }
    }
    const parser = new VoiceTagParser(async (event, text) => {
      if (!key || this.disabledTurns.has(key)) return
      if (event === 'start') {
        const blockKey = JSON.stringify([binding?.response_id ?? context?.turn_id, binding?.request_id])
        const blockIndex = this.blockIndexes.get(blockKey) ?? 0
        this.blockIndexes.set(blockKey, blockIndex + 1)
        original = undefined
        if (this.resumeRecord) original = this.resumeRecord()
        else if (binding) original = findVoiceDelivery(this.port, item => item.binding?.response_id === binding.response_id
          && item.binding?.request_id === binding.request_id && item.block_index === blockIndex && ['queued', 'completed'].includes(item.status))
        if (this.resumeRecord && !original) return
        if (original?.status === 'completed') { this.completed = true; this.delivered(original); return }
        record = { playback_id: original?.playback_id ?? randomUUID(), channel_id: (binding ?? context!).channel_id, session_id: (binding ?? context!).session_id,
          turn_id: original?.turn_id ?? context?.turn_id ?? binding!.response_id, text: '', status: 'prepared', ...(binding ? { binding: structuredClone(original?.binding ?? binding), block_index: original?.block_index ?? blockIndex } : {}) }
        sequence = 0; if (!original) save()
        queued = false; opened = false; playbackContext = undefined
      } else if (event === 'text' && record) {
        record.text += text!
        const firstBody = !opened && !queued
        if (firstBody) {
          if (!original) save()
          if (!record.text.trim()) return
          const previous = this.lastPlaybackContext
          if (binding) {
            const continuing = previous?.kind === 'reply' && previous.turn_id === context?.turn_id
              && previous.connection_epoch === context?.connection_epoch && JSON.stringify(previous.binding) === JSON.stringify(binding)
            playbackContext = continuing ? previous : await this.port.prepare?.(record, binding.worker_id ? undefined : context)
          }
          queued = !!binding && !playbackContext
          if (playbackContext) this.lastPlaybackContext = playbackContext
          if (!queued) try { opened = true; await send({ type: 'reply_start', playback_id: record.playback_id }) }
          catch (error) {
            if (!binding) throw error
            // No reply_text has been sent, so this result has not produced any audio.
            queued = true
            try { await send({ type: 'reply_cancel', playback_id: record.playback_id }) } catch { /* preserve the unsent result */ }
          }
        }
        record.status = queued ? 'prepared' : 'streaming'; if (!queued || !original) save()
        if (!queued) {
          committed = true; this.committedTurns.add(key)
          sequence = await appendVoiceText(send, this.port.receipt, record.playback_id, sequence, firstBody ? record.text : text!, cancellation.signal)
        }
      } else if (event === 'end' && record) {
        if (!record.text.trim()) { await cancel(); return }
        if (queued) {
          record.status = 'queued'; save(); committed = true; this.committedTurns.add(key); record = undefined; return
        }
        const result = await finishVoicePlayback(send, this.port.receipt, record.playback_id, cancellation.signal)
        record.status = 'completed'; record.played_samples = result.played_samples; record.sent_at = result.sent_at; save()
        this.completed = true; this.delivered(record); record = undefined
      }
    })
    const fail = async (error?: unknown): Promise<void> => {
      cancellation.abort()
      broken = true; if (committed && key) this.disabledTurns.add(key)
      if (record && error instanceof RpcCallError && error.details) {
        const samples = error.details.played_samples, text = error.details.completed_text
        if (Number.isSafeInteger(samples) && (samples as number) >= 0) record.played_samples = samples as number
        if (typeof text === 'string' && record.text.startsWith(text)) record.completed_text = text
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
    if (this.lastPlaybackContext && (!context || this.lastPlaybackContext.turn_id === context.turn_id)) {
      try { await this.port.send({ delivery_context: this.lastPlaybackContext, event: { type: 'response_end' } }) } catch { /* no stale replay */ }
    } else if (context) try { await this.port.send({ voice_reply_context: context, event: { type: 'response_end' } }) } catch { /* stale interaction is never revived */ }
  }
}
