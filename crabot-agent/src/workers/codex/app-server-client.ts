import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { buildScrubbedChildEnv } from '../connections/secret-env.js'

type JsonObject = Record<string, unknown>

interface PendingRequest {
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export interface CodexAppServerThread {
  readonly id: string
  readonly parentThreadId: string | null
  readonly preview: string
  readonly status: { readonly type: string }
  readonly agentNickname: string | null
  readonly agentRole: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CodexAppServerThreadPage {
  readonly data: ReadonlyArray<CodexAppServerThread>
  readonly nextCursor: string | null
}

export interface CodexAppServerThreadItem {
  readonly turnId: string
  readonly item: Record<string, unknown>
}

export interface CodexAppServerThreadItemPage {
  readonly data: ReadonlyArray<CodexAppServerThreadItem>
  readonly nextCursor: string | null
}

export interface AppServerNotification {
  readonly method: string
  readonly params?: unknown
}

export class CodexAppServerRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'CodexAppServerRpcError'
  }
}

export class CodexAppServerDeadlineError extends Error {
  constructor(readonly method: string) {
    super(`codex app-server request '${method}' exceeded its deadline`)
    this.name = 'CodexAppServerDeadlineError'
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 1000)
}

function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
  if (child.pid === undefined) return false
  try {
    process.kill(-child.pid, signal)
    return true
  } catch {
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }
}

/** Minimal JSONL client for the two RPCs used by query_worker. */
export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notificationHandlers = new Set<(notification: AppServerNotification) => void>()
  private readonly exitHandlers = new Set<(error?: Error) => void>()
  private readonly exitedPromise: Promise<void>
  private resolveExited!: () => void
  private nextRequestId = 1
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private exited = false
  private processExited = false

  constructor(opts: {
    readonly command: string
    readonly cwd: string
    readonly env: Record<string, string>
  }) {
    this.exitedPromise = new Promise((resolve) => {
      this.resolveExited = resolve
    })
    this.child = spawn('/bin/sh', ['-c', opts.command], {
      cwd: opts.cwd,
      env: { ...buildScrubbedChildEnv(), ...opts.env },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (chunk: Buffer) => this.consumeStdout(chunk.toString('utf8')))
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk.toString('utf8')}`.slice(-4000)
    })
    this.child.stdin.on('error', (error) => {
      this.finish(error)
      void this.terminate()
    })
    this.child.once('error', (error) => {
      this.processExited = true
      this.resolveExited()
      this.finish(error)
    })
    this.child.once('exit', (code, signal) => {
      this.processExited = true
      this.resolveExited()
      const error = code === 0 || this.exited
        ? undefined
        : new Error(`codex app-server exited (code=${code}, signal=${signal ?? 'none'})${this.stderrTail ? `: ${this.stderrTail}` : ''}`)
      this.finish(error)
    })
  }

  get stderrTail(): string {
    return this.stderrBuffer.replace(/\s+/g, ' ').trim().slice(-1000)
  }

  onNotification(handler: (notification: AppServerNotification) => void): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  onExit(handler: (error?: Error) => void): () => void {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  async initialize(deadlineAt: string): Promise<void> {
    const result = await this.request('initialize', {
      clientInfo: { name: 'crabot', title: 'Crabot', version: '1' },
      capabilities: { experimentalApi: true },
    }, deadlineAt)
    if (
      !isObject(result) ||
      typeof result.userAgent !== 'string' ||
      typeof result.codexHome !== 'string'
    ) {
      throw new Error('codex app-server initialize returned an incompatible response')
    }
    this.notify('initialized', {})
  }

  request(method: string, params: JsonObject, deadlineAt: string): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error(`codex app-server exited before '${method}'`))
    const remainingMs = Date.parse(deadlineAt) - Date.now()
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return Promise.reject(new CodexAppServerDeadlineError(method))
    }
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CodexAppServerDeadlineError(method))
      }, remainingMs)
      timer.unref?.()
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.write({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async listThreads(
    params: { readonly parentThreadId?: string; readonly cursor?: string; readonly limit?: number },
    deadlineAt: string,
  ): Promise<CodexAppServerThreadPage> {
    const result = await this.request('thread/list', params, deadlineAt)
    return parseThreadPage(result, 'thread/list')
  }

  async readThread(threadId: string, deadlineAt: string): Promise<CodexAppServerThread> {
    const result = await this.request('thread/read', { threadId }, deadlineAt)
    if (!isObject(result) || !isObject(result.thread)) {
      throw new Error('codex app-server thread/read returned an incompatible response')
    }
    return parseThread(result.thread, 'thread/read')
  }

  async listThreadItems(
    params: { readonly threadId: string; readonly cursor?: string; readonly limit?: number },
    deadlineAt: string,
  ): Promise<CodexAppServerThreadItemPage> {
    const result = await this.request('thread/items/list', params, deadlineAt)
    if (!isObject(result) || !Array.isArray(result.data) || !('nextCursor' in result)) {
      throw new Error('codex app-server thread/items/list returned an incompatible response')
    }
    const data: CodexAppServerThreadItem[] = []
    for (const entry of result.data) {
      if (!isObject(entry) || typeof entry.turnId !== 'string' || !isObject(entry.item)) {
        throw new Error('codex app-server thread/items/list returned an invalid item')
      }
      data.push({ turnId: entry.turnId, item: entry.item })
    }
    return { data, nextCursor: typeof result.nextCursor === 'string' ? result.nextCursor : null }
  }

  notify(method: string, params: JsonObject): void {
    this.write({ method, params })
  }

  async terminate(): Promise<boolean> {
    if (this.processExited) return true
    killProcessTree(this.child, 'SIGTERM')
    if (await this.waitForExit(1000)) return true
    killProcessTree(this.child, 'SIGKILL')
    return this.waitForExit(1000)
  }

  private write(message: JsonObject): void {
    if (this.exited || !this.child.stdin.writable) throw new Error('codex app-server stdin is closed')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) this.consumeLine(line)
  }

  private consumeLine(line: string): void {
    if (!line.trim()) return
    let message: JsonObject
    try {
      const parsed = JSON.parse(line)
      if (!isObject(parsed)) throw new Error('message is not an object')
      message = parsed
    } catch (error) {
      this.finish(new Error(`invalid JSON from codex app-server: ${safeError(error)}`))
      void this.terminate()
      return
    }

    if (typeof message.id === 'number' && !('method' in message)) {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (isObject(message.error)) {
        request.reject(new CodexAppServerRpcError(
          typeof message.error.code === 'number' ? message.error.code : -32000,
          typeof message.error.message === 'string' ? message.error.message : `${request.method} failed`,
          message.error.data,
        ))
      } else {
        request.resolve(message.result)
      }
      return
    }

    if (typeof message.method !== 'string') return
    if (typeof message.id === 'number') {
      this.write({
        id: message.id,
        error: { code: -32601, message: `client method not supported: ${message.method}` },
      })
      return
    }
    const notification = { method: message.method, ...('params' in message ? { params: message.params } : {}) }
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification)
      } catch {
        // A consumer callback cannot corrupt the JSONL transport.
      }
    }
  }

  private finish(error?: Error): void {
    if (this.exited) return
    this.exited = true
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error ?? new Error(`codex app-server exited before '${request.method}' completed`))
    }
    this.pending.clear()
    for (const handler of this.exitHandlers) {
      try {
        handler(error)
      } catch {
        // Exit observers are best effort; process settlement is already final.
      }
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.processExited) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref?.()
    })
    const exited = this.exitedPromise.then(() => true)
    const result = await Promise.race([exited, timeout])
    if (timer) clearTimeout(timer)
    return result
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseThreadPage(value: unknown, method: string): CodexAppServerThreadPage {
  if (!isObject(value) || !Array.isArray(value.data) || !('nextCursor' in value)) {
    throw new Error(`codex app-server ${method} returned an incompatible response`)
  }
  return {
    data: value.data.map((thread) => parseThread(thread, method)),
    nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : null,
  }
}

function parseThread(value: unknown, method: string): CodexAppServerThread {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.preview !== 'string' || !isObject(value.status)) {
    throw new Error(`codex app-server ${method} returned an invalid thread`)
  }
  return {
    id: value.id,
    parentThreadId: typeof value.parentThreadId === 'string' ? value.parentThreadId : null,
    preview: value.preview,
    status: { type: typeof value.status.type === 'string' ? value.status.type : 'notLoaded' },
    agentNickname: typeof value.agentNickname === 'string' ? value.agentNickname : null,
    agentRole: typeof value.agentRole === 'string' ? value.agentRole : null,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  }
}

function provesThreadLookup(error: unknown): boolean {
  return error instanceof CodexAppServerRpcError &&
    error.code !== -32601 &&
    error.code !== -32602 &&
    /(?:thread not found|no rollout found)/i.test(error.message)
}

export async function probeCodexAppServerFork(opts: {
  readonly command: string
  readonly cwd: string
  readonly env: Record<string, string>
  readonly timeoutMs?: number
}): Promise<boolean> {
  const deadlineAt = new Date(Date.now() + (opts.timeoutMs ?? 3000)).toISOString()
  const client = new CodexAppServerClient(opts)
  try {
    await client.initialize(deadlineAt)
    const [fork, turn] = await Promise.allSettled([
      client.request('thread/fork', {
        threadId: '00000000-0000-0000-0000-000000000001',
        ephemeral: true,
        excludeTurns: true,
      }, deadlineAt),
      client.request('turn/start', {
        threadId: '00000000-0000-0000-0000-000000000002',
        input: [{ type: 'text', text: 'capability probe' }],
      }, deadlineAt),
    ])
    return fork.status === 'rejected' && provesThreadLookup(fork.reason) &&
      turn.status === 'rejected' && provesThreadLookup(turn.reason)
  } catch {
    return false
  } finally {
    await client.terminate()
  }
}

export async function probeCodexAppServerSubagents(opts: {
  readonly command: string
  readonly cwd: string
  readonly env: Record<string, string>
  readonly timeoutMs?: number
}): Promise<boolean> {
  const deadlineAt = new Date(Date.now() + (opts.timeoutMs ?? 3000)).toISOString()
  const client = new CodexAppServerClient(opts)
  try {
    await client.initialize(deadlineAt)
    await client.listThreads({ parentThreadId: '00000000-0000-0000-0000-000000000001', limit: 1 }, deadlineAt)
    return true
  } catch {
    return false
  } finally {
    await client.terminate()
  }
}
