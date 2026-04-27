import { createHash } from 'node:crypto'

export const MUST_CONFIRM_COMMANDS: ReadonlySet<string> = new Set([
  'provider delete',
  'mcp delete',
  'skill delete',
  'schedule delete',
  'friend delete',
  'permission delete',
  'schedule trigger',
])

const TOKEN_TTL_SECONDS = 15 * 60

export function mustConfirm(subcommand: string): boolean {
  return MUST_CONFIRM_COMMANDS.has(subcommand)
}

export function canonicalize(subcommand: string, args: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (k === '--confirm') continue
    filtered[k] = v
  }
  const sortedKeys = Object.keys(filtered).sort()
  const argString = sortedKeys.map(k => `${k}=${String(filtered[k])}`).join('&')
  return `${subcommand}|${argString}`
}

export function generateToken(subcommand: string, args: Record<string, unknown>): string {
  const canon = canonicalize(subcommand, args)
  const hash = createHash('sha256').update(canon).digest('hex').slice(0, 12)
  const ts = Math.floor(Date.now() / 1000)
  return `${hash}-${ts}`
}

export type VerifyResult = { valid: true } | { valid: false; reason: 'expired' | 'mismatch' | 'malformed' }

export function verifyToken(token: string, subcommand: string, args: Record<string, unknown>): VerifyResult {
  const parts = token.split('-')
  if (parts.length !== 2) return { valid: false, reason: 'malformed' }
  const [hashPart, tsPart] = parts
  const ts = Number(tsPart)
  if (!Number.isFinite(ts)) return { valid: false, reason: 'malformed' }
  const ageSec = Math.floor(Date.now() / 1000) - ts
  if (ageSec > TOKEN_TTL_SECONDS) return { valid: false, reason: 'expired' }
  const expected = createHash('sha256').update(canonicalize(subcommand, args)).digest('hex').slice(0, 12)
  if (hashPart !== expected) return { valid: false, reason: 'mismatch' }
  return { valid: true }
}

export function expiresAt(): string {
  return new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString()
}
