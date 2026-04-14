import type { FormattedDiagnostic, LspManagerLike } from '../hooks/types'
import type { Language } from './configs'
import { LSP_CONFIGS, detectLanguage } from './configs'
import { createLSPClient, type LSPClient } from './lsp-client'
import { DiagnosticStore } from './diagnostic-store'
import { execSync } from 'child_process'

export interface LSPManager extends LspManagerLike {
  start(rootUri: string, languages?: Language[]): Promise<void>
  stop(): Promise<void>
  notifyFileChanged(filePath: string, content: string): void
  getDiagnostics(filePath: string): Promise<ReadonlyArray<FormattedDiagnostic>>
  isLanguageAvailable(lang: string): boolean
}

export function createLSPManager(): LSPManager {
  const clients = new Map<Language, LSPClient>()
  const diagnosticStore = new DiagnosticStore()
  let rootUri: string | undefined
  const startingLanguages = new Set<Language>()

  function isServerInstalled(command: string): boolean {
    try {
      execSync(`which ${command}`, { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }

  async function ensureClient(language: Language): Promise<LSPClient | undefined> {
    if (clients.has(language)) return clients.get(language)
    if (!rootUri) return undefined
    if (startingLanguages.has(language)) return undefined

    const config = LSP_CONFIGS[language]
    if (!isServerInstalled(config.command)) return undefined

    startingLanguages.add(language)
    try {
      const client = createLSPClient(language, config)
      await client.initialize(rootUri)
      clients.set(language, client)
      return client
    } catch (error) {
      console.error(`Failed to start LSP server for ${language}:`, error)
      return undefined
    } finally {
      startingLanguages.delete(language)
    }
  }

  return {
    async start(uri: string, languages?: Language[]): Promise<void> {
      rootUri = uri
      if (languages) {
        await Promise.all(languages.map((lang) => ensureClient(lang)))
      }
    },

    async stop(): Promise<void> {
      const shutdowns = [...clients.values()].map((client) => client.shutdown())
      await Promise.all(shutdowns)
      clients.clear()
      diagnosticStore.clearAll()
    },

    notifyFileChanged(filePath: string, content: string): void {
      const language = detectLanguage(filePath)
      if (!language) return

      // Lazy start: trigger client initialization in background
      void ensureClient(language).then((client) => {
        if (!client) return
        client.didChange(filePath, content)
      })
    },

    async getDiagnostics(filePath: string): Promise<ReadonlyArray<FormattedDiagnostic>> {
      const language = detectLanguage(filePath)
      if (!language) return []

      const client = await ensureClient(language)
      if (!client) return []

      const diagnostics = await client.waitForDiagnostics(filePath)
      diagnosticStore.update(filePath, [...diagnostics])
      return diagnosticStore.get(filePath)
    },

    isLanguageAvailable(lang: string): boolean {
      return clients.has(lang as Language)
    },
  }
}
