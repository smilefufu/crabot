import { describe, it, expect } from 'vitest'
import { DiagnosticStore } from '../../src/lsp/diagnostic-store'
import type { FormattedDiagnostic } from '../../src/hooks/types'

function makeDiag(
  filePath: string,
  severity: 'error' | 'warning' | 'info',
  line: number,
  message: string,
): FormattedDiagnostic {
  return { filePath, line, column: 1, severity, message, source: 'typescript' }
}

describe('DiagnosticStore', () => {
  it('stores and retrieves diagnostics by file', () => {
    const store = new DiagnosticStore()
    const diags = [makeDiag('/src/a.ts', 'error', 1, 'type error')]
    store.update('/src/a.ts', diags)

    expect(store.get('/src/a.ts')).toEqual(diags)
  })

  it('returns empty array for unknown file', () => {
    const store = new DiagnosticStore()
    expect(store.get('/unknown.ts')).toEqual([])
  })

  it('limits to MAX_PER_FILE diagnostics', () => {
    const store = new DiagnosticStore()
    const diags = Array.from({ length: 20 }, (_, i) =>
      makeDiag('/src/a.ts', 'error', i + 1, `error ${i}`)
    )
    store.update('/src/a.ts', diags)

    expect(store.get('/src/a.ts')).toHaveLength(10)
  })

  it('filters out info and hint, keeps only error and warning', () => {
    const store = new DiagnosticStore()
    store.update('/src/a.ts', [
      makeDiag('/src/a.ts', 'error', 1, 'err'),
      makeDiag('/src/a.ts', 'warning', 2, 'warn'),
      makeDiag('/src/a.ts', 'info', 3, 'info'),
    ])

    const result = store.get('/src/a.ts')
    expect(result).toHaveLength(2)
    expect(result.map(d => d.severity)).toEqual(['error', 'warning'])
  })

  it('clears diagnostics for a file', () => {
    const store = new DiagnosticStore()
    store.update('/src/a.ts', [makeDiag('/src/a.ts', 'error', 1, 'err')])
    store.clear('/src/a.ts')

    expect(store.get('/src/a.ts')).toEqual([])
  })

  it('replaces diagnostics on update', () => {
    const store = new DiagnosticStore()
    store.update('/src/a.ts', [makeDiag('/src/a.ts', 'error', 1, 'old')])
    store.update('/src/a.ts', [makeDiag('/src/a.ts', 'warning', 2, 'new')])

    const result = store.get('/src/a.ts')
    expect(result).toHaveLength(1)
    expect(result[0].message).toBe('new')
  })
})
