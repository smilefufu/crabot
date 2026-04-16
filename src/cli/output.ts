export interface Column {
  readonly key: string
  readonly header: string
  readonly width?: number
  readonly transform?: (value: unknown) => string
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

export function printTable(
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

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

export function printResult(
  data: unknown,
  json: boolean,
  columns?: Column[]
): void {
  if (json) {
    printJson(data)
    return
  }

  if (
    columns &&
    Array.isArray(data) &&
    data.length > 0 &&
    typeof data[0] === 'object'
  ) {
    printTable(data as ReadonlyArray<Record<string, unknown>>, columns)
    return
  }

  if (
    columns &&
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data)
  ) {
    printTable([data as Record<string, unknown>], columns)
    return
  }

  printJson(data)
}
