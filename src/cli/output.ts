import { CliError } from './errors.js'

export type OutputMode = 'ai' | 'human'

export interface Column {
  readonly key: string
  readonly header: string
  readonly width?: number
  readonly transform?: (value: unknown) => string
}

export interface RenderOptions {
  readonly mode: OutputMode
  readonly columns?: Column[]
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

function getCellValue(row: Record<string, unknown>, col: Column): string {
  const value = row[col.key]
  if (col.transform) {
    return col.transform(value)
  }
  if (value === null || value === undefined) {
    return ''
  }
  return String(value)
}

function printTableImpl(
  data: ReadonlyArray<Record<string, unknown>>,
  columns: Column[]
): void {
  if (data.length === 0) {
    process.stdout.write('(no results)\n')
    return
  }

  const colWidths = columns.map((col) => {
    const maxDataWidth = data.reduce((max, row) => {
      const cell = getCellValue(row, col)
      return Math.max(max, cell.length)
    }, 0)
    const width = col.width ?? Math.max(col.header.length, maxDataWidth)
    return Math.max(col.header.length, width)
  })

  const headerLine = columns
    .map((col, i) => col.header.padEnd(colWidths[i] ?? col.header.length))
    .join('  ')

  const separatorLine = colWidths.map((w) => '-'.repeat(w)).join('  ')

  process.stdout.write(`${headerLine}\n`)
  process.stdout.write(`${separatorLine}\n`)

  for (const row of data) {
    const rowLine = columns
      .map((col, i) => {
        const cell = getCellValue(row, col)
        return cell.padEnd(colWidths[i] ?? cell.length)
      })
      .join('  ')
    process.stdout.write(`${rowLine}\n`)
  }
}

function printJsonImpl(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

// New AI-first API

export function renderResult(data: unknown, opts: RenderOptions): void {
  if (opts.mode === 'human' && opts.columns) {
    if (
      Array.isArray(data) &&
      data.length > 0 &&
      typeof data[0] === 'object'
    ) {
      printTableImpl(data as ReadonlyArray<Record<string, unknown>>, opts.columns)
      return
    }
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      printTableImpl([data as Record<string, unknown>], opts.columns)
      return
    }
  }
  printJsonImpl(data)
}

export function renderError(err: CliError, opts: RenderOptions): void {
  if (opts.mode === 'ai') {
    process.stderr.write(JSON.stringify(err.toJson(), null, 2) + '\n')
    return
  }
  process.stderr.write(`Error [${err.code}]: ${err.message}\n`)
  if (err.details && Array.isArray(err.details['candidates'])) {
    process.stderr.write('Candidates:\n')
    for (const c of err.details['candidates'] as Array<{ id: string; name: string }>) {
      process.stderr.write(`  - ${shortId(c.id)} (${c.name})\n`)
    }
  }
}

// Legacy API (backward compatible) — used by current commands until they migrate

export function printJson(data: unknown): void {
  printJsonImpl(data)
}

export function printTable(
  data: ReadonlyArray<Record<string, unknown>>,
  columns: Column[]
): void {
  printTableImpl(data, columns)
}

export function printResult(
  data: unknown,
  json: boolean,
  columns?: Column[]
): void {
  if (json) {
    printJsonImpl(data)
    return
  }

  if (
    columns &&
    Array.isArray(data) &&
    data.length > 0 &&
    typeof data[0] === 'object'
  ) {
    printTableImpl(data as ReadonlyArray<Record<string, unknown>>, columns)
    return
  }

  if (
    columns &&
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data)
  ) {
    printTableImpl([data as Record<string, unknown>], columns)
    return
  }

  printJsonImpl(data)
}
