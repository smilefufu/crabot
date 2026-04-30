import { readFileSync } from 'node:fs'
import { CliError } from '../errors.js'

/**
 * 从 admin POST 响应里取新建实体的 id。
 * admin 的创建响应有时包一层（如 `{schedule: {id}}` / `{friend: {id}}`），有时直接 flat（如 `{id}`）。
 * 传 wrapKey 时先尝试包装路径，再 fallback 到 flat。
 */
export function extractCreatedId(result: unknown, wrapKey?: string): string {
  const r = result as Record<string, unknown> | null
  if (wrapKey) {
    const wrapped = r?.[wrapKey] as { id?: string } | undefined
    if (wrapped?.id) return wrapped.id
  }
  return (r as { id?: string } | null)?.id ?? '<unknown>'
}

/**
 * 校验 value 是否在白名单内，否则抛 INVALID_ARGUMENT。
 * 用于 CLI flag 值（priority / format / permission 等）的枚举校验。
 */
export function assertEnum<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[]
): T {
  if (!value || !allowed.includes(value as T)) {
    throw new CliError(
      'INVALID_ARGUMENT',
      `${flag} 必须是 ${allowed.join(' | ')}，收到: "${value ?? ''}"`
    )
  }
  return value as T
}

/**
 * 校验 value trim 后非空，否则抛 INVALID_ARGUMENT 并返回 trimmed 字符串。
 */
export function assertNonEmpty(flag: string, value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new CliError('INVALID_ARGUMENT', `${flag} 不能为空`)
  }
  return trimmed
}

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
