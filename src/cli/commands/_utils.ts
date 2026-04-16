export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: string
): void {
  const parts = path.split('.')
  let current: Record<string, unknown> = obj

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string
    if (
      current[part] === undefined ||
      current[part] === null ||
      typeof current[part] !== 'object'
    ) {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }

  const lastPart = parts[parts.length - 1] as string
  current[lastPart] = value
}

export function parseKeyValuePairs(pairs: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=')
    if (eqIndex === -1) {
      throw new Error(`Invalid key=value pair: ${pair}`)
    }
    const key = pair.slice(0, eqIndex)
    const value = pair.slice(eqIndex + 1)
    setNestedValue(result, key, value)
  }

  return result
}
