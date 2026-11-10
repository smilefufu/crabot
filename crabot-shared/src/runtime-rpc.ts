import { randomUUID } from 'node:crypto'

/** Internal addresses identify modules without opening TCP listeners. */
export interface RuntimeRpcCall {
  target: number
  source: string
  method: string
  params: unknown
  metadata?: { authorizationBearer?: string }
}
type Handler = (call: RuntimeRpcCall) => unknown | Promise<unknown>
interface Channel {
  connected?: boolean
  send(message: object, callback: (error: Error | null) => void): boolean | void
  on(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
}
interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
  timer?: NodeJS.Timeout
}
interface Message {
  type: 'crabot:rpc'
  id: string
  kind: 'call' | 'result' | 'error'
  call?: RuntimeRpcCall
  value?: unknown
  error?: { code: string; message: string; details?: Record<string, unknown> }
}
const runtimeRpcErrorKey = Symbol.for('crabot.runtime-rpc-error')
export class RuntimeRpcError extends Error {
  readonly [runtimeRpcErrorKey] = true
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && runtimeRpcErrorKey in value
  }
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'RuntimeRpcError'
  }
}

/** One peer belongs to one exact child, never to its replacement. */
export class RuntimeRpcPeer {
  private readonly pending = new Map<string, PendingCall>()
  private handler?: Handler
  private closed = false

  constructor(private readonly channel: Channel) {
    channel.on('message', this.receive)
    channel.on('disconnect', this.disconnect)
    channel.on('exit', this.disconnect)
    channel.on('error', this.disconnect)
  }

  handle(handler: Handler): () => void {
    if (this.closed) throw new RuntimeRpcError('SERVICE_UNAVAILABLE', 'Runtime channel is closed')
    if (this.handler) throw new Error('Runtime channel already has a handler')
    this.handler = handler
    return () => { if (this.handler === handler) this.handler = undefined }
  }

  call<R>(call: RuntimeRpcCall, timeoutMs?: number): Promise<R> {
    if (this.closed || this.channel.connected === false) {
      return Promise.reject(new RuntimeRpcError('SERVICE_UNAVAILABLE', 'Runtime channel is closed'))
    }
    const id = randomUUID()
    return new Promise<R>((resolve, reject) => {
      const pending: PendingCall = { resolve: value => resolve(value as R), reject }
      if (timeoutMs !== undefined) pending.timer = setTimeout(() => {
        this.finish(id, new RuntimeRpcError('RPC_TIMEOUT', `RPC timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, pending)
      try {
        this.channel.send({ type: 'crabot:rpc', kind: 'call', id, call }, error => {
          if (error) this.finish(id, new RuntimeRpcError('SERVICE_UNAVAILABLE', 'Runtime send failed'))
        })
      } catch {
        this.finish(id, new RuntimeRpcError('SERVICE_UNAVAILABLE', 'Runtime send failed'))
      }
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.handler = undefined
    this.channel.removeListener('message', this.receive)
    this.channel.removeListener('disconnect', this.disconnect)
    this.channel.removeListener('exit', this.disconnect)
    this.channel.removeListener('error', this.disconnect)
    for (const id of this.pending.keys()) this.finish(id, new RuntimeRpcError('SERVICE_UNAVAILABLE', 'Runtime channel disconnected'))
  }

  private readonly disconnect = (): void => { this.close() }

  private finish(id: string, error?: Error, value?: unknown): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    if (error) pending.reject(error)
    else pending.resolve(value)
  }

  private readonly receive = (input: unknown): void => {
    if (!input || typeof input !== 'object') return
    const message = input as Message
    if (message.type !== 'crabot:rpc' || typeof message.id !== 'string' || message.id.length > 128) return
    if (message.kind === 'result') this.finish(message.id, undefined, message.value)
    else if (message.kind === 'error') {
      if (typeof message.error?.code !== 'string' || typeof message.error.message !== 'string') return
      this.finish(message.id, new RuntimeRpcError(message.error.code, message.error.message, message.error.details))
    } else if (message.kind === 'call') void this.dispatch(message)
  }

  private async dispatch(message: Message): Promise<void> {
    let reply: Message
    try {
      const call = message.call
      if (!call || !Number.isInteger(call.target) || call.target < 1 || typeof call.source !== 'string' || typeof call.method !== 'string' || !call.method) {
        throw new RuntimeRpcError('INVALID_PARAMS', 'Invalid runtime call')
      }
      const bearer = call.metadata?.authorizationBearer
      if (bearer !== undefined && (typeof bearer !== 'string' || !bearer || /[\r\n]/.test(bearer))) {
        throw new RuntimeRpcError('UNAUTHORIZED', 'Invalid Authorization metadata')
      }
      if (!this.handler) throw new RuntimeRpcError('SERVICE_UNAVAILABLE', 'Runtime handler is unavailable')
      reply = { type: 'crabot:rpc', kind: 'result', id: message.id, value: await this.handler(call) }
    } catch (error) {
      const failure = error as Partial<RuntimeRpcError> | null
      reply = {
        type: 'crabot:rpc', kind: 'error', id: message.id,
        error: {
          code: typeof failure?.code === 'string' ? failure.code : 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Runtime handler failed',
          ...(failure?.details ? { details: failure.details } : {}),
        },
      }
    }
    if (this.closed || this.channel.connected === false) return
    try {
      this.channel.send(reply, () => {})
    } catch {
      // Fail this call if its result cannot cross the process boundary.
      try {
        this.channel.send({ type: 'crabot:rpc', kind: 'error', id: message.id,
          error: { code: 'INTERNAL_ERROR', message: 'Runtime result cannot be transferred' } }, () => {})
      } catch { this.close() }
    }
  }
}

const processPeerKey = Symbol.for('crabot.managed-runtime-rpc-peer')
const runtimeProcess = process as typeof process & { [processPeerKey]?: RuntimeRpcPeer }
export function getProcessRpcPeer(): RuntimeRpcPeer | undefined {
  if (process.env.CRABOT_RPC_TRANSPORT !== 'ipc') return undefined
  if (runtimeProcess[processPeerKey]) return runtimeProcess[processPeerKey]
  if (!process.send || !process.connected) throw new RuntimeRpcError('SERVICE_UNAVAILABLE', 'Managed IPC transport is not connected')
  return runtimeProcess[processPeerKey] = new RuntimeRpcPeer(process as Channel)
}
