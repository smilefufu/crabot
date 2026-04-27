import { readFileSync } from 'node:fs'

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

export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    throw new Error(`Failed to read or parse file ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// Build the args + command_text for a delete command of the given subcommand+ref,
// optionally with a confirmation token (used by 6 delete handlers).
export function buildDeleteParams(
  subcommand: string,
  ref: string,
  confirm: string | undefined,
): { args: Record<string, unknown>; command_text: string } {
  const args: Record<string, unknown> = { _positional: ref }
  let command_text = `${subcommand} ${ref}`
  if (confirm) {
    args['--confirm'] = confirm
    command_text = `${subcommand} ${ref} --confirm ${confirm}`
  }
  return { args, command_text }
}
