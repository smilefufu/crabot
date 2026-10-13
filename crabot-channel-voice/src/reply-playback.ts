import { synthesizeAudio, type AudioServiceConnection } from 'crabot-shared'

export class SentenceBuffer {
  private pending = ''
  append(text: string): string[] {
    this.pending += text
    const result: string[] = []
    for (;;) {
      const boundary = /[。！？!?；;\n]|\.(?=\s)/.exec(this.pending)
      if (!boundary) break
      const end = boundary.index + boundary[0].length
      const sentence = this.pending.slice(0, end).trim(); this.pending = this.pending.slice(end)
      if (sentence) result.push(sentence)
    }
    return result
  }
  finish(): string[] { const rest = this.pending.trim(); this.pending = ''; return rest ? [rest] : [] }
}

export interface PlaybackTransport {
  valid(): void
  start(text: string): void
  audio(sequence: number, pcm: Buffer): void
  end(text: string, sampleCount: number): void
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
  private waiter?: () => void
  private ended = false
  private started = false
  private endSent = false
  private sentSamples = 0
  private generatedSamples = 0
  private sequence = 0
  private tail = Buffer.alloc(0)
  private boundaries: Array<{ text: string; end: number }> = []
  private settled = false
  private resolve!: (result: { platform_message_id: string; sent_at: string; played_samples: number }) => void
  private reject!: (error: Error) => void
  private readonly timers: Array<ReturnType<typeof setTimeout>> = []
  constructor(readonly id: string, private readonly connection: AudioServiceConnection, private readonly transport: PlaybackTransport) {
    this.done = new Promise((ok, no) => { this.resolve = ok; this.reject = no })
    void this.done.catch(() => {})
    this.timers.push(setTimeout(() => this.cancel('回复整体超过 30 秒'), 30000))
    void this.run()
  }
  append(sequence: number, text: string): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || typeof text !== 'string' || !text.length) throw new Error('非法语音文字序号')
    if (sequence < this.fragments.length) { if (this.fragments[sequence] === text) return; throw new Error('同序号的语音文字冲突') }
    if (this.ended || this.controller.signal.aborted || sequence !== this.fragments.length || Array.from(this.text + text).length > 120) throw new Error('语音文字超长、乱序或已结束')
    this.fragments.push(text); this.text += text; this.sentences.push(...this.buffer.append(text)); this.wake()
  }
  end(): void {
    if (this.ended) return
    if (!this.text.trim()) { this.cancel('没有可播文字'); return }
    this.ended = true; this.sentences.push(...this.buffer.finish()); this.wake()
  }
  receipt(status: string, playedSamples?: number): void {
    if (playedSamples !== undefined) {
      if (!Number.isSafeInteger(playedSamples) || playedSamples < 0 || playedSamples > this.sentSamples) { this.cancel('实际播放游标非法'); return }
      this.playedSamples = playedSamples
      this.completedText = this.boundaries.filter(item => item.end <= playedSamples).map(item => item.text).join('')
    }
    if (status === 'started' && this.started && playedSamples && playedSamples > 0) { clearTimeout(this.timers[1]); return }
    if (status === 'completed' && this.endSent && playedSamples === this.generatedSamples && playedSamples > 0) {
      this.settled = true; this.clearTimers()
      this.resolve({ platform_message_id: this.id, sent_at: new Date().toISOString(), played_samples: playedSamples }); return
    }
    this.cancel('播放中断、失败或回执顺序不正确')
  }
  cancel(reason: string): void {
    if (this.settled) return
    this.settled = true; this.controller.abort(); this.clearTimers(); this.wake()
    this.transport.cancel(); this.reject(new Error(reason))
  }
  private clearTimers(): void { this.timers.forEach(clearTimeout) }
  private wake(): void { const waiter = this.waiter; this.waiter = undefined; waiter?.() }
  private async next(): Promise<string | undefined> {
    while (!this.sentences.length && !this.ended && !this.controller.signal.aborted) await new Promise<void>(ok => { this.waiter = ok })
    this.controller.signal.throwIfAborted(); return this.sentences.shift()
  }
  private async synthesize(): Promise<{ text: string; pcm: Buffer } | undefined> {
    const text = await this.next(); if (text === undefined) return
    if (!this.timers[1]) {
      this.timers.push(setTimeout(() => this.cancel('首音频超过 5 秒'), 5000))
      this.timers.push(setTimeout(() => this.cancel('合成到播放回执超过 25 秒'), 25000))
    }
    this.transport.valid()
    const pcm = await synthesizeAudio(this.connection, text, this.controller.signal)
    this.generatedSamples += pcm.length / 2
    if (this.generatedSamples > 480000) { pcm.fill(0); throw new Error('播报超过 20 秒') }
    this.boundaries.push({ text, end: this.generatedSamples }); return { text, pcm }
  }
  private async write(pcm: Buffer, final = false): Promise<void> {
    const data = Buffer.concat([this.tail, pcm]); this.tail.fill(0)
    const length = final ? data.length : Math.floor(data.length / 960) * 960
    this.tail = Buffer.from(data.subarray(length))
    try {
      for (let offset = 0; offset < length; offset += 960) {
        this.controller.signal.throwIfAborted(); this.transport.valid()
        const frame = data.subarray(offset, Math.min(offset + 960, length))
        this.sentSamples += frame.length / 2; this.transport.audio(this.sequence++, frame)
        await new Promise<void>(ok => setTimeout(ok, frame.length / 48))
      }
    } finally { data.fill(0) }
  }
  private async run(): Promise<void> {
    let next: Promise<{ text: string; pcm: Buffer } | undefined> | undefined
    try {
      next = this.synthesize()
      for (;;) {
        const item = await next; if (!item) break
        if (!this.started) { this.transport.valid(); this.started = true; this.transport.start(item.text) }
        next = this.synthesize(); void next.catch(() => {})
        try { await this.write(item.pcm) } finally { item.pcm.fill(0) }
      }
      await this.write(Buffer.alloc(0), true); this.transport.valid(); this.endSent = true
      this.transport.end(this.text, this.generatedSamples)
    } catch { this.cancel('语音合成或播放传输失败') }
    finally {
      this.tail.fill(0); this.sentences = []
      if (next) { const pending = await next.catch(() => undefined); pending?.pcm.fill(0) }
    }
  }
}
