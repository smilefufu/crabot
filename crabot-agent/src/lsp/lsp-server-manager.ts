import * as path from 'path'
import { readFile } from 'fs/promises'
import { LspClient } from './lsp-client'

export interface LspServerConfig {
  /** Server name (e.g., 'typescript-language-server') */
  readonly name: string
  /** Command to start (e.g., 'npx') */
  readonly command: string
  /** Arguments (e.g., ['typescript-language-server', '--stdio']) */
  readonly args: readonly string[]
  /** File extensions this server handles (e.g., ['.ts', '.tsx', '.js', '.jsx']) */
  readonly extensions: readonly string[]
  /** Map extension to LSP languageId (e.g., { '.ts': 'typescript', '.tsx': 'typescriptreact' }) */
  readonly languageIds: Readonly<Record<string, string>>
}

/**
 * Manages multiple LSP server instances, routing requests to the correct
 * language server based on file extension. Servers are started lazily on
 * first access.
 */
export class LspServerManager {
  /** Registry of server configs: serverName → config */
  private readonly configs: Map<string, LspServerConfig> = new Map()
  /** Running server instances: serverName → LspClient */
  private readonly servers: Map<string, LspClient> = new Map()
  /** Extension → serverName mapping */
  private readonly extensionMap: Map<string, string> = new Map()
  /** Tracking which files are open on which server: fileUri → serverName */
  private readonly openFiles: Map<string, string> = new Map()
  /** Version counter per file URI for didChange notifications */
  private readonly fileVersions: Map<string, number> = new Map()

  constructor(private readonly cwd: string) {}

  /**
   * Register a language server config.
   * Builds extensionMap from config.extensions → config.name.
   */
  registerServer(config: LspServerConfig): void {
    this.configs.set(config.name, config)
    for (const ext of config.extensions) {
      this.extensionMap.set(ext.toLowerCase(), config.name)
    }
  }

  /**
   * Get or start the server for a given file path.
   * Returns null if no server handles this extension.
   * Lazily starts the server on first access.
   */
  async getServerForFile(filePath: string): Promise<LspClient | null> {
    const ext = path.extname(filePath).toLowerCase()
    const serverName = this.extensionMap.get(ext)

    if (!serverName) {
      return null
    }

    const existingServer = this.servers.get(serverName)
    if (existingServer) {
      return existingServer
    }

    const config = this.configs.get(serverName)
    if (!config) {
      return null
    }

    const client = new LspClient({
      command: config.command,
      args: [...config.args],
      cwd: this.cwd,
    })

    await client.start()
    this.servers.set(serverName, client)

    return client
  }

  /**
   * Notify server that a file was opened (textDocument/didOpen).
   * Skips if file is already tracked as open.
   */
  async openFile(filePath: string, content: string): Promise<void> {
    const server = await this.getServerForFile(filePath)
    if (!server) {
      return
    }

    const fileUri = pathToFileUri(filePath)

    if (this.openFiles.has(fileUri)) {
      return
    }

    const ext = path.extname(filePath).toLowerCase()
    const serverName = this.extensionMap.get(ext)!
    const config = this.configs.get(serverName)!
    const languageId = config.languageIds[ext] ?? 'plaintext'

    server.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: fileUri,
        languageId,
        version: 1,
        text: content,
      },
    })

    this.openFiles.set(fileUri, serverName)
    this.fileVersions.set(fileUri, 1)
  }

  /**
   * Notify server that a file changed (textDocument/didChange).
   * Increments the version counter for the file.
   */
  async changeFile(filePath: string, content: string): Promise<void> {
    const server = await this.getServerForFile(filePath)
    if (!server) {
      return
    }

    const fileUri = pathToFileUri(filePath)

    // If file hasn't been opened, open it first
    if (!this.openFiles.has(fileUri)) {
      await this.openFile(filePath, content)
      return
    }

    const currentVersion = this.fileVersions.get(fileUri) ?? 1
    const nextVersion = currentVersion + 1
    this.fileVersions.set(fileUri, nextVersion)

    server.sendNotification('textDocument/didChange', {
      textDocument: {
        uri: fileUri,
        version: nextVersion,
      },
      contentChanges: [{ text: content }],
    })
  }

  /**
   * Notify server that a file was saved (textDocument/didSave).
   */
  async saveFile(filePath: string): Promise<void> {
    const server = await this.getServerForFile(filePath)
    if (!server) {
      return
    }

    const fileUri = pathToFileUri(filePath)

    server.sendNotification('textDocument/didSave', {
      textDocument: {
        uri: fileUri,
      },
    })
  }

  /**
   * Notify server that a file was closed (textDocument/didClose).
   * Removes the file from tracking so it can be reopened later.
   */
  async closeFile(filePath: string): Promise<void> {
    const server = await this.getServerForFile(filePath)
    if (!server) {
      return
    }

    const fileUri = pathToFileUri(filePath)

    server.sendNotification('textDocument/didClose', {
      textDocument: {
        uri: fileUri,
      },
    })

    this.openFiles.delete(fileUri)
    this.fileVersions.delete(fileUri)
  }

  /**
   * Send an LSP request for a specific file.
   * Auto-opens the file (reading from disk) if not yet open.
   * Returns null if no server handles this extension.
   */
  async sendRequest<R>(filePath: string, method: string, params: unknown): Promise<R | null> {
    const server = await this.getServerForFile(filePath)
    if (!server) {
      return null
    }

    const fileUri = pathToFileUri(filePath)

    // Auto-open file if not yet tracked
    if (!this.openFiles.has(fileUri)) {
      const content = await readFile(filePath, 'utf-8')
      await this.openFile(filePath, content)
    }

    return server.sendRequest<R>(method, params)
  }

  /**
   * Stop all running servers and clear all internal state.
   */
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.servers.values()).map((server) =>
      server.stop(),
    )

    await Promise.allSettled(stopPromises)

    this.servers.clear()
    this.extensionMap.clear()
    this.openFiles.clear()
    this.fileVersions.clear()
    this.configs.clear()
  }
}

/**
 * Returns default server configs for common languages.
 */
export function getDefaultServerConfigs(): LspServerConfig[] {
  return [
    {
      name: 'typescript-language-server',
      command: 'npx',
      args: ['typescript-language-server', '--stdio'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
      languageIds: {
        '.ts': 'typescript',
        '.tsx': 'typescriptreact',
        '.js': 'javascript',
        '.jsx': 'javascriptreact',
        '.mjs': 'javascript',
        '.cjs': 'javascript',
      },
    },
  ]
}

function pathToFileUri(filePath: string): string {
  const resolved = path.resolve(filePath)
  return `file://${resolved}`
}
