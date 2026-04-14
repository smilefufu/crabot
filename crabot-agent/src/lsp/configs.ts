export type Language = 'typescript' | 'python' | 'rust' | 'go'

export interface LSPServerConfig {
  readonly command: string
  readonly args: readonly string[]
  /** npm package name (null = must be pre-installed by user) */
  readonly npmPackage: string | null
  readonly fileExtensions: readonly string[]
}

export const LSP_CONFIGS: Record<Language, LSPServerConfig> = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    npmPackage: 'typescript-language-server',
    fileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  python: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    npmPackage: 'pyright',
    fileExtensions: ['.py'],
  },
  rust: {
    command: 'rust-analyzer',
    args: [],
    npmPackage: null,
    fileExtensions: ['.rs'],
  },
  go: {
    command: 'gopls',
    args: ['serve'],
    npmPackage: null,
    fileExtensions: ['.go'],
  },
}

export function detectLanguage(filePath: string): Language | undefined {
  const ext = filePath.slice(filePath.lastIndexOf('.'))
  for (const [lang, config] of Object.entries(LSP_CONFIGS)) {
    if (config.fileExtensions.includes(ext)) return lang as Language
  }
  return undefined
}
