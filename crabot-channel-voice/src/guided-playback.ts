import { synthesizeAudio, type AudioServiceConnection } from 'crabot-shared'

interface Transport {
  valid(): void
  start(): void
  audio(sequence: number, pcm: Buffer): void
  end(samples: number): void
}

/** Fixed management prompt; has no business turn, delivery receipt or reply lifecycle. */
export class GuidedPlayback {
  readonly done: Promise<void>
  private readonly abort = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly firstAudioTimer: ReturnType<typeof setTimeout>
  private sent = 0
  private ended = false
  private settled = false
  private resolve!: () => void
  private reject!: (error: Error) => void
  constructor(connection: AudioServiceConnection, text: string, deadline: number, private readonly transport: Transport) {
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    void this.done.catch(() => undefined)
    this.timer = setTimeout(() => this.cancel(), Math.max(1, Math.min(30000, deadline - Date.now())))
    this.firstAudioTimer = setTimeout(() => this.cancel(), 5000)
    void this.run(connection, text).catch(() => this.cancel())
  }
  receipt(status: string, samples?: number): void {
    if (this.settled) return
    if (status === 'started' && samples !== undefined && samples > 0 && samples <= this.sent) return
    if (status === 'completed' && this.ended && samples === this.sent && samples > 0) {
      this.settled = true; clearTimeout(this.timer); clearTimeout(this.firstAudioTimer); this.resolve(); return
    }
    this.cancel()
  }
  cancel(): void {
    if (this.settled) return
    this.settled = true; clearTimeout(this.timer); clearTimeout(this.firstAudioTimer); this.abort.abort(); this.reject(new Error('管理提示未完整播放'))
  }
  private async run(connection: AudioServiceConnection, text: string): Promise<void> {
    this.transport.valid()
    const pcm = await synthesizeAudio(connection, text, this.abort.signal)
    try {
      if (!pcm.length || pcm.length % 2 || pcm.length / 2 > 480000) throw new Error('Invalid management PCM')
      clearTimeout(this.firstAudioTimer)
      this.abort.signal.throwIfAborted(); this.transport.valid(); this.transport.start()
      for (let offset = 0, sequence = 0; offset < pcm.length; offset += 960, sequence++) {
        this.abort.signal.throwIfAborted(); this.transport.valid()
        const frame = pcm.subarray(offset, Math.min(offset + 960, pcm.length))
        this.sent += frame.length / 2; this.transport.audio(sequence, frame)
        await new Promise<void>(resolve => setTimeout(resolve, frame.length / 48))
      }
      this.abort.signal.throwIfAborted(); this.transport.valid(); this.ended = true; this.transport.end(this.sent)
    } finally { pcm.fill(0) }
  }
}
