import { type ChildProcess, spawn } from 'child_process'
import * as path from 'path'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'

/**
 * LSP error code for "content modified" - indicates the server's state changed
 * during request processing (e.g., server still indexing the project).
 * This is a transient error that can be retried.
 */
const LSP_ERROR_CONTENT_MODIFIED = -32801

/** Maximum retries for transient LSP errors like "content modified". */
const MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3

/** Base delay in ms for exponential backoff. Actual delays: 500ms, 1000ms, 2000ms */
const RETRY_BASE_DELAY_MS = 500

export interface LspClientConfig {
  /** Command to start the language server (e.g., 'typescript-language-server') */
  readonly command: string
  /** Command arguments (e.g., ['--stdio']) */
  readonly args: string[]
  /** Working directory */
  readonly cwd: string
  /** Environment variables */
  readonly env?: Record<string, string>
  /** Startup timeout in ms (default: 10000) */
  readonly startupTimeout?: number
  /** Max restart attempts after crash (default: 3) */
  readonly maxRestarts?: number
}

export type LspClientState = 'stopped' | 'starting' | 'running' | 'error'

/**
 * Low-level LSP client that communicates with a language server via JSON-RPC over stdio.
 *
 * Manages the full lifecycle: spawn process, initialize LSP handshake, send requests/notifications,
 * handle crash recovery with bounded restarts, and graceful shutdown.
 */
export class LspClient {
  private process: ChildProcess | null = null
  private connection: MessageConnection | null = null
  private state: LspClientState = 'stopped'
  private restartCount = 0
  private isStopping = false

  constructor(private readonly config: LspClientConfig) {}

  getState(): LspClientState {
    return this.state
  }

  /**
   * Start the language server process and complete the LSP initialization handshake.
   *
   * Flow:
   * 1. Spawn process with stdio pipes
   * 2. Create JSON-RPC MessageConnection from stdin/stdout
   * 3. Send `initialize` request with client capabilities
   * 4. Send `initialized` notification
   * 5. Set state to 'running'
   *
   * On timeout or failure: stop process, set state to 'error', throw.
   */
  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      return
    }

    const startupTimeout = this.config.startupTimeout ?? 10000

    try {
      this.state = 'starting'

      // 1. Spawn the language server process
      const childProcess = spawn(this.config.command, this.config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.config.env },
        cwd: this.config.cwd,
        windowsHide: true,
      })

      this.process = childProcess

      if (!childProcess.stdout || !childProcess.stdin) {
        throw new Error('Language server process stdio not available')
      }

      // Wait for process to actually spawn (catches ENOENT etc.)
      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          cleanup()
          resolve()
        }
        const onError = (error: Error): void => {
          cleanup()
          reject(error)
        }
        const cleanup = (): void => {
          childProcess.removeListener('spawn', onSpawn)
          childProcess.removeListener('error', onError)
        }
        childProcess.once('spawn', onSpawn)
        childProcess.once('error', onError)
      })

      // Handle process crashes during operation
      childProcess.on('exit', (code, _signal) => {
        if (code !== 0 && code !== null && !this.isStopping) {
          this.handleCrash(
            new Error(`Language server crashed with exit code ${code}`),
          )
        }
      })

      childProcess.on('error', (error) => {
        if (!this.isStopping) {
          this.handleCrash(error)
        }
      })

      // Prevent unhandled errors on stdin when process exits mid-write
      childProcess.stdin.on('error', () => {
        // Swallowed intentionally; connection error handler covers this
      })

      // 2. Create JSON-RPC connection
      const reader = new StreamMessageReader(childProcess.stdout)
      const writer = new StreamMessageWriter(childProcess.stdin)
      const conn = createMessageConnection(reader, writer)

      conn.onError(([error]) => {
        if (!this.isStopping) {
          this.handleCrash(error)
        }
      })

      conn.onClose(() => {
        if (!this.isStopping && this.state === 'running') {
          this.state = 'error'
        }
      })

      // 3. Start listening
      conn.listen()
      this.connection = conn

      // 4. Send initialize request with timeout
      const initPromise = this.sendInitialize(conn)
      await withTimeout(
        initPromise,
        startupTimeout,
        `Language server timed out after ${startupTimeout}ms during initialization`,
      )

      // 5. Send initialized notification
      conn.sendNotification('initialized', {})

      this.state = 'running'
      this.restartCount = 0
    } catch (error) {
      await this.cleanup()
      this.state = 'error'
      throw error
    }
  }

  /**
   * Send an LSP request and get the response.
   *
   * Retries up to 3 times with exponential backoff on "content modified" (-32801) errors.
   * Throws if not in 'running' state.
   */
  async sendRequest<R>(method: string, params: unknown): Promise<R> {
    if (this.state !== 'running' || !this.connection) {
      throw new Error(
        `Cannot send request: LSP client is ${this.state}`,
      )
    }

    let lastError: Error | undefined

    for (let attempt = 0; attempt <= MAX_RETRIES_FOR_TRANSIENT_ERRORS; attempt++) {
      try {
        return await this.connection.sendRequest(method, params)
      } catch (error) {
        lastError = error as Error

        const errorCode = (error as { code?: number }).code
        const isContentModified =
          typeof errorCode === 'number' && errorCode === LSP_ERROR_CONTENT_MODIFIED

        if (isContentModified && attempt < MAX_RETRIES_FOR_TRANSIENT_ERRORS) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
          await sleep(delay)
          continue
        }

        break
      }
    }

    throw new Error(
      `LSP request '${method}' failed: ${lastError?.message ?? 'unknown error'}`,
    )
  }

  /**
   * Send an LSP notification (no response expected).
   * Throws if not in 'running' state.
   */
  sendNotification(method: string, params: unknown): void {
    if (this.state !== 'running' || !this.connection) {
      throw new Error(
        `Cannot send notification: LSP client is ${this.state}`,
      )
    }

    this.connection.sendNotification(method, params)
  }

  /**
   * Gracefully stop the language server.
   *
   * Sends `shutdown` request, then `exit` notification, then kills the process.
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped') {
      return
    }

    this.isStopping = true

    try {
      if (this.connection) {
        try {
          await this.connection.sendRequest('shutdown', undefined)
          this.connection.sendNotification('exit', undefined)
        } catch {
          // Server may already be dead; proceed to cleanup
        }
      }
    } finally {
      await this.cleanup()
      this.state = 'stopped'
      this.isStopping = false
    }
  }

  // --- Private helpers ---

  private async sendInitialize(conn: MessageConnection): Promise<void> {
    const { cwd } = this.config
    const rootUri = `file://${cwd}`

    await conn.sendRequest('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          implementation: {},
          callHierarchy: {},
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: {
          symbol: { dynamicRegistration: false },
        },
      },
      workspaceFolders: [{ uri: rootUri, name: path.basename(cwd) }],
    })
  }

  private handleCrash(error: Error): void {
    const maxRestarts = this.config.maxRestarts ?? 3

    this.state = 'error'

    if (this.restartCount < maxRestarts) {
      this.restartCount++
      this.attemptRestart()
    }
  }

  private async attemptRestart(): Promise<void> {
    try {
      await this.cleanup()
      await this.start()
    } catch {
      this.state = 'error'
    }
  }

  private async cleanup(): Promise<void> {
    if (this.connection) {
      try {
        this.connection.dispose()
      } catch {
        // Disposal errors are non-critical
      }
      this.connection = null
    }

    if (this.process) {
      this.process.removeAllListeners('error')
      this.process.removeAllListeners('exit')
      if (this.process.stdin) {
        this.process.stdin.removeAllListeners('error')
      }
      if (this.process.stderr) {
        this.process.stderr.removeAllListeners('data')
      }

      try {
        this.process.kill()
      } catch {
        // Process may already be dead
      }
      this.process = null
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timer),
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
