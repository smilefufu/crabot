import { synthesizeAudio, type AudioServiceConnection } from 'crabot-shared'

export class SentenceBuffer {
  private pending = ''
  append(text: string): string[] {
    this.pending += text
    const result: string[] = []
    for (;;) {
      const points = Array.from(this.pending)
      const expression = /[。！？!?；;\n]|\.(?=\s)/g
      let boundary = expression.exec(this.pending)
      while (boundary && !this.pending.slice(0, boundary.index + 1).trim()) boundary = expression.exec(this.pending)
      let length = boundary ? Array.from(this.pending.slice(0, boundary.index + 1)).length : 0
      if (!length || length > 120) {
        if (points.length < 120) break
        const prefix = points.slice(0, 120).join('')
        if (!prefix.trim()) throw new Error('语音片段没有可播正文')
        const soft = [...prefix.matchAll(/[，,；;\s]/g)].at(-1)
        length = soft && prefix.slice(0, soft.index! + 1).trim() ? Array.from(prefix.slice(0, soft.index! + 1)).length : 120
      }
      result.push(points.slice(0, length).join(''))
      this.pending = points.slice(length).join('')
    }
    return result
  }
  finish(): string[] { const rest = this.pending; this.pending = ''; return rest.trim() ? [rest] : [] }
}

export interface PlaybackTransport {
  valid(): void
  start(text: string): void
  text(sequence: number, text: string): void
  audio(sequence: number, pcm: Buffer): void
  end(text: string, sampleCount: number, textSegments: number): void
  cancel(): void
}

export class ReplyPlayback {
  readonly controller = new AbortController()
  readonly done: Promise<{ platform_message_id: string; sent_at: string; played_samples: number }>
  readonly fragments: string[] = []
  text = ''
  playedSamples?: number
  completedText = ''
  private readonly buffer = new SentenceBuffer()
  private sentences: string[] = []
  private queuedCharacters = 0
  private textWaiter?: () => void
  private audioWaiter?: () => void
  private ended = false
  private started = false
  private endSent = false
  private sentSamples = 0
  private generatedSamples = 0
  private sequence = 0
  private textSegments = 0
  private tail = Buffer.alloc(0)
  private boundaries: Array<{ text: string; end: number }> = []
  private settled = false
  private synthesizing = false
  private synthesisAt = 0
  private firstSubmittedAt?: number
  private progressAt = Date.now()
  private idleAt = Date.now()
  private finalAt?: number
  private readonly watchdog: ReturnType<typeof setInterval>
  private resolve!: (result: { platform_message_id: string; sent_at: string; played_samples: number }) => void
  private reject!: (error: Error) => void
  get active(): boolean { return !this.settled }
  constructor(readonly id: string, private readonly connection: AudioServiceConnection, private readonly transport: PlaybackTransport) {
    this.done = new Promise((ok, no) => { this.resolve = ok; this.reject = no })
    void this.done.catch(() => {})
    this.watchdog = setInterval(() => {
      const now = Date.now(), played = this.playedSamples ?? 0
      if (this.firstSubmittedAt !== undefined && !played && now - this.firstSubmittedAt >= 5000) this.cancel('首音频超过 5 秒')
      else if (this.synthesizing && now - this.synthesisAt >= 25000) this.cancel('语音合成超过 25 秒')
      else if (this.sentSamples > played && now - this.progressAt >= 5000) this.cancel('播放游标超过 5 秒没有前进')
      else if (this.finalAt !== undefined && played === this.sentSamples && now - this.finalAt >= 5000) this.cancel('播放完成回执未知')
      else if (!this.synthesizing && this.sentSamples === played && now - this.idleAt >= 60000) this.cancel('等待后续语音超过 60 秒')
    }, 100)
    void this.run()
  }
  append(sequence: number, text: string): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || typeof text !== 'string' || !text.length || Array.from(text).length > 120) throw new Error('非法语音文字序号或片段')
    if (sequence < this.fragments.length) { if (this.fragments[sequence] === text) return true; throw new Error('同序号的语音文字冲突') }
    if (this.ended || !this.active || sequence !== this.fragments.length) throw new Error('语音文字乱序或已结束')
    if (this.queuedCharacters + Array.from(text).length > 240) return false
    this.queuedCharacters += Array.from(text).length
    this.fragments.push(text); this.text += text; this.sentences.push(...this.buffer.append(text)); this.idleAt = Date.now(); this.wakeText()
    return true
  }
  end(): void {
    if (this.ended) return
    if (!this.text.trim()) { this.cancel('没有可播文字'); return }
    this.ended = true; this.sentences.push(...this.buffer.finish()); this.wakeText()
  }
  progress(samples: number): void {
    if (!this.active) return
    if (!Number.isSafeInteger(samples) || samples < (this.playedSamples ?? 0) || samples > this.sentSamples) { this.cancel('实际播放游标非法'); return }
    if (samples === (this.playedSamples ?? 0)) return
    this.playedSamples = samples; this.progressAt = Date.now(); this.idleAt = Date.now()
    if (this.endSent && samples === this.sentSamples) this.finalAt = Date.now()
    this.completedText = this.boundaries.filter(item => item.end <= samples).map(item => item.text).join('')
    this.wakeAudio()
  }
  receipt(status: string, playedSamples?: number): void {
    if (!this.active) return
    if (playedSamples !== undefined) this.progress(playedSamples)
    if (!this.active) return
    if (status === 'started' && this.started && playedSamples && playedSamples > 0) return
    if (status === 'completed' && this.endSent && playedSamples === this.generatedSamples && playedSamples > 0) {
      this.settled = true; clearInterval(this.watchdog)
      this.resolve({ platform_message_id: this.id, sent_at: new Date().toISOString(), played_samples: playedSamples }); return
    }
    this.cancel('播放中断、失败或回执顺序不正确')
  }
  cancel(reason: string): void {
    if (!this.active) return
    this.settled = true; this.controller.abort(); clearInterval(this.watchdog); this.wakeText(); this.wakeAudio()
    this.transport.cancel(); this.reject(new Error(reason))
  }
  private wakeText(): void { const waiter = this.textWaiter; this.textWaiter = undefined; waiter?.() }
  private wakeAudio(): void { const waiter = this.audioWaiter; this.audioWaiter = undefined; waiter?.() }
  private async next(): Promise<string | undefined> {
    while (!this.sentences.length && !this.ended && !this.controller.signal.aborted) await new Promise<void>(ok => { this.textWaiter = ok })
    this.controller.signal.throwIfAborted()
    const text = this.sentences.shift()
    if (text !== undefined) this.queuedCharacters -= Array.from(text).length
    return text
  }
  private async synthesize(): Promise<{ text: string; pcm: Buffer } | undefined> {
    const text = await this.next(); if (text === undefined) return
    if (this.firstSubmittedAt === undefined) this.firstSubmittedAt = Date.now()
    this.transport.valid(); this.synthesizing = true; this.synthesisAt = Date.now()
    try {
      const pcm = await synthesizeAudio(this.connection, text, this.controller.signal)
      if (!Number.isSafeInteger(this.generatedSamples + pcm.length / 2)) { pcm.fill(0); throw new Error('播放样本计数溢出') }
      this.generatedSamples += pcm.length / 2
      this.boundaries.push({ text, end: this.generatedSamples }); return { text, pcm }
    } finally { this.synthesizing = false; this.idleAt = Date.now() }
  }
  private async write(pcm: Buffer, final = false): Promise<void> {
    const data = Buffer.concat([this.tail, pcm]); this.tail.fill(0)
    const length = final ? data.length : Math.floor(data.length / 960) * 960
    this.tail = Buffer.from(data.subarray(length))
    try {
      for (let offset = 0; offset < length; offset += 960) {
        const frame = data.subarray(offset, Math.min(offset + 960, length))
        while (this.sentSamples + frame.length / 2 - (this.playedSamples ?? 0) > 24000 && this.active) await new Promise<void>(ok => { this.audioWaiter = ok })
        this.controller.signal.throwIfAborted(); this.transport.valid()
        if (this.sequence > 0xffffffff) throw new Error('音频序号溢出')
        if (this.sentSamples === (this.playedSamples ?? 0)) this.progressAt = Date.now()
        this.sentSamples += frame.length / 2; this.transport.audio(this.sequence++, frame)
      }
    } finally { data.fill(0) }
  }
  private async run(): Promise<void> {
    let next: Promise<{ text: string; pcm: Buffer } | undefined> | undefined
    try {
      next = this.synthesize()
      for (;;) {
        const item = await next; if (!item) break
        if (!this.started) {
          this.transport.valid(); this.started = true
          console.info('[VoicePlayback]', { playback_id: this.id, first_pcm_ms: Date.now() - this.firstSubmittedAt! })
          this.transport.start(item.text)
        }
        this.transport.text(this.textSegments++, item.text)
        next = this.synthesize(); void next.catch(() => {})
        try { await this.write(item.pcm) } finally { item.pcm.fill(0) }
      }
      await this.write(Buffer.alloc(0), true); this.transport.valid(); this.endSent = true; this.finalAt = Date.now()
      this.transport.end(this.text, this.generatedSamples, this.textSegments)
    } catch { this.cancel('语音合成或播放传输失败') }
    finally {
      this.tail.fill(0); this.sentences = []
      if (next) { const pending = await next.catch(() => undefined); pending?.pcm.fill(0) }
    }
  }
}
