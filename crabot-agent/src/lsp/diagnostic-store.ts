import type { FormattedDiagnostic } from '../hooks/types'

const MAX_PER_FILE = 10

export class DiagnosticStore {
  private readonly store = new Map<string, ReadonlyArray<FormattedDiagnostic>>()

  update(filePath: string, diagnostics: ReadonlyArray<FormattedDiagnostic>): void {
    const filtered = diagnostics
      .filter((d) => d.severity === 'error' || d.severity === 'warning')
      .slice(0, MAX_PER_FILE)
    this.store.set(filePath, filtered)
  }

  get(filePath: string): ReadonlyArray<FormattedDiagnostic> {
    return this.store.get(filePath) ?? []
  }

  clear(filePath: string): void {
    this.store.delete(filePath)
  }

  clearAll(): void {
    this.store.clear()
  }
}
