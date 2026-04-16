import { spawn, type ChildProcess } from 'child_process'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node'
import {
  type InitializeParams,
  type InitializeResult,
  type PublishDiagnosticsParams,
  type Diagnostic,
  DiagnosticSeverity,
} from 'vscode-languageserver-protocol'
import type { FormattedDiagnostic } from '../hooks/types'
import type { Language, LSPServerConfig } from './configs'
import * as path from 'path'

const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 3_000

export interface LSPClient {
  readonly language: Language
  initialize(rootUri: string): Promise<void>
  didOpen(filePath: string, content: string): void
  didChange(filePath: string, content: string): void
  didSave(filePath: string): void
  waitForDiagnostics(filePath: string, timeoutMs?: number): Promise<ReadonlyArray<FormattedDiagnostic>>
  shutdown(): Promise<void>
}

export function createLSPClient(language: Language, config: LSPServerConfig): LSPClient {
  let process: ChildProcess | undefined
  let connection: MessageConnection | undefined
  let initialized = false
  const fileVersions = new Map<string, number>()
  const pendingDiagnostics = new Map<string, { diagnostics: Diagnostic[]; resolvers: Array<(diags: Diagnostic[]) => void> }>()

  function toUri(filePath: string): string {
    return `file://${filePath}`
  }

  function convertSeverity(severity?: DiagnosticSeverity): 'error' | 'warning' | 'info' {
    switch (severity) {
      case DiagnosticSeverity.Error: return 'error'
      case DiagnosticSeverity.Warning: return 'warning'
      default: return 'info'
    }
  }

  function formatDiagnostics(filePath: string, diagnostics: Diagnostic[]): ReadonlyArray<FormattedDiagnostic> {
    return diagnostics.map((d) => ({
      filePath,
      line: d.range.start.line + 1,
      column: d.range.start.character + 1,
      severity: convertSeverity(d.severity),
      message: d.message,
      source: d.source ?? language,
    }))
  }

  return {
    language,

    async initialize(rootUri: string): Promise<void> {
      if (initialized) return

      process = spawn(config.command, [...config.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      if (!process.stdout || !process.stdin) {
        throw new Error(`Failed to spawn LSP server: ${config.command}`)
      }

      connection = createMessageConnection(
        new StreamMessageReader(process.stdout),
        new StreamMessageWriter(process.stdin),
      )

      // Listen for diagnostics
      connection.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
        const filePath = params.uri.replace('file://', '')
        const entry = pendingDiagnostics.get(filePath)
        if (entry) {
          entry.diagnostics = params.diagnostics
          for (const resolver of entry.resolvers) {
            resolver(params.diagnostics)
          }
          entry.resolvers = []
        } else {
          pendingDiagnostics.set(filePath, { diagnostics: params.diagnostics, resolvers: [] })
        }
      })

      connection.listen()

      const initParams: InitializeParams = {
        processId: null,
        rootUri: toUri(rootUri),
        capabilities: {
          textDocument: {
            publishDiagnostics: {
              relatedInformation: false,
            },
          },
        },
        workspaceFolders: [{ uri: toUri(rootUri), name: path.basename(rootUri) }],
      }

      await connection.sendRequest<InitializeResult>('initialize', initParams)
      connection.sendNotification('initialized', {})
      initialized = true
    },

    didOpen(filePath: string, content: string): void {
      if (!connection || !initialized) return
      fileVersions.set(filePath, 1)
      connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: toUri(filePath),
          languageId: language === 'typescript' ? 'typescript' : language,
          version: 1,
          text: content,
        },
      })
    },

    didChange(filePath: string, content: string): void {
      if (!connection || !initialized) return
      const version = (fileVersions.get(filePath) ?? 0) + 1
      fileVersions.set(filePath, version)

      // Check if file was opened; if not, open it first
      if (version === 1) {
        this.didOpen(filePath, content)
        return
      }

      connection.sendNotification('textDocument/didChange', {
        textDocument: { uri: toUri(filePath), version },
        contentChanges: [{ text: content }],
      })
    },

    didSave(filePath: string): void {
      if (!connection || !initialized) return
      connection.sendNotification('textDocument/didSave', {
        textDocument: { uri: toUri(filePath) },
      })
    },

    async waitForDiagnostics(filePath: string, timeoutMs = DEFAULT_DIAGNOSTICS_TIMEOUT_MS): Promise<ReadonlyArray<FormattedDiagnostic>> {
      // Check if we already have diagnostics
      const existing = pendingDiagnostics.get(filePath)
      if (existing && existing.diagnostics.length > 0) {
        const diags = formatDiagnostics(filePath, existing.diagnostics)
        return diags
      }

      // Wait for diagnostics notification
      return new Promise<ReadonlyArray<FormattedDiagnostic>>((resolve) => {
        const timer = setTimeout(() => {
          const entry = pendingDiagnostics.get(filePath)
          if (entry) {
            entry.resolvers = entry.resolvers.filter(r => r !== onDiag)
          }
          resolve([])
        }, timeoutMs)

        const onDiag = (diagnostics: Diagnostic[]) => {
          clearTimeout(timer)
          resolve(formatDiagnostics(filePath, diagnostics))
        }

        if (!pendingDiagnostics.has(filePath)) {
          pendingDiagnostics.set(filePath, { diagnostics: [], resolvers: [] })
        }
        pendingDiagnostics.get(filePath)!.resolvers.push(onDiag)
      })
    },

    async shutdown(): Promise<void> {
      if (connection && initialized) {
        try {
          await connection.sendRequest('shutdown')
          connection.sendNotification('exit')
        } catch {
          // Server may have already exited
        }
        connection.dispose()
      }
      if (process) {
        process.kill()
      }
      initialized = false
      fileVersions.clear()
      pendingDiagnostics.clear()
    },
  }
}
