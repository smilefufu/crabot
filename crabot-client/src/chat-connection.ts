import { ChatServerMessageSchema, type ChatServerMessage } from './contracts/index.js'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error' | 'replaced'
type Socket = Pick<WebSocket, 'onopen' | 'onmessage' | 'onclose' | 'onerror' | 'readyState' | 'close'>

export class ChatConnection {
  private socket: Socket | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private epoch = 0
  private attempts = 0
  private wanted = false
  private _status: ConnectionStatus = 'disconnected'
  private messages = new Set<(message: ChatServerMessage) => void>()
  private statuses = new Set<(status: ConnectionStatus) => void>()
  private invalidations = new Set<() => void>()

  constructor(private readonly options: {
    url: () => string | Promise<string>
    socket: (url: string) => Socket
    maxReconnectAttempts?: number
    reconnectDelayMs?: number
  }) {}

  get status() { return this._status }
  private setStatus(status: ConnectionStatus) {
    this._status = status
    for (const handler of this.statuses) handler(status)
  }
  onMessage(handler: (message: ChatServerMessage) => void) { this.messages.add(handler); return () => { this.messages.delete(handler) } }
  onStatusChange(handler: (status: ConnectionStatus) => void) { this.statuses.add(handler); return () => { this.statuses.delete(handler) } }
  onInvalidation(handler: () => void) { this.invalidations.add(handler); return () => { this.invalidations.delete(handler) } }

  connect() {
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return
    this.wanted = true; this.attempts = 0
    clearTimeout(this.timer)
    void this.open(++this.epoch)
  }

  disconnect() {
    this.wanted = false; this.epoch++
    clearTimeout(this.timer); this.timer = undefined
    const socket = this.socket; this.socket = null
    socket?.close(1000, 'User disconnected')
    this.setStatus('disconnected')
  }

  private async open(epoch: number) {
    this.setStatus('connecting')
    try {
      const url = await this.options.url()
      if (!this.wanted || epoch !== this.epoch) return
      const socket = this.options.socket(url)
      this.socket = socket
      const current = () => this.wanted && epoch === this.epoch && socket === this.socket
      socket.onopen = () => { if (current()) { this.attempts = 0; this.setStatus('connected') } }
      socket.onmessage = event => {
        if (!current()) return
        let parsed
        try { parsed = ChatServerMessageSchema.safeParse(JSON.parse(String(event.data))) } catch { /* invalid or unknown event */ }
        if (!parsed?.success) { for (const invalidate of this.invalidations) invalidate(); return }
        for (const handler of this.messages) handler(parsed.data)
      }
      socket.onclose = event => {
        if (!current()) return
        this.socket = null
        if (event.code === 1000) {
          this.wanted = false
          this.setStatus(event.reason === 'New connection established' ? 'replaced' : 'disconnected')
          return
        }
        this.retry(epoch)
      }
      socket.onerror = () => { if (current()) this.setStatus('error') }
    } catch { if (this.wanted && epoch === this.epoch) this.retry(epoch) }
  }

  private retry(epoch: number) {
    this.setStatus('error')
    if (this.attempts >= (this.options.maxReconnectAttempts ?? 5)) return
    const delay = (this.options.reconnectDelayMs ?? 1000) * 2 ** this.attempts++
    this.timer = setTimeout(() => { if (this.wanted && epoch === this.epoch) void this.open(epoch) }, delay)
  }
}
