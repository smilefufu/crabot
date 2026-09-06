import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { generateId } from 'crabot-shared'

const AUDIENCE = 'crabot-agent'
const PURPOSE = 'admin_workboard_change'
const ISSUER = 'admin-web'
const TTL_SECONDS = 60
const CLAIM_KEYS = ['assertion_id', 'issuer_module_id', 'audience', 'purpose', 'manager_key', 'action', 'expected_revision', 'payload_sha256', 'issued_at', 'expires_at'] as const

export type WorkboardAdminAction = 'create' | 'revise' | 'archive'

export interface WorkboardAdminAssertionClaims {
  assertion_id: string
  issuer_module_id: typeof ISSUER
  audience: typeof AUDIENCE
  purpose: typeof PURPOSE
  manager_key: string
  action: WorkboardAdminAction
  expected_revision: number
  payload_sha256: string
  issued_at: string
  expires_at: string
}

export type ExpectedWorkboardAdminAssertion = Pick<
  WorkboardAdminAssertionClaims,
  'manager_key' | 'action' | 'expected_revision' | 'payload_sha256'
>

interface PersistedAssertions {
  issued: Record<string, { expires_at: string }>
  consumed: Record<string, string>
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function decodeJson(part: string): unknown | undefined {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) } catch { return undefined }
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function validClaims(value: unknown): value is WorkboardAdminAssertionClaims {
  if (!exactKeys(value, CLAIM_KEYS)) return false
  const claims = value as Record<string, unknown>
  return typeof claims.assertion_id === 'string' && claims.assertion_id.length > 0
    && claims.issuer_module_id === ISSUER && claims.audience === AUDIENCE && claims.purpose === PURPOSE
    && typeof claims.manager_key === 'string' && claims.manager_key.length > 0
    && (claims.action === 'create' || claims.action === 'revise' || claims.action === 'archive')
    && typeof claims.expected_revision === 'number' && Number.isSafeInteger(claims.expected_revision) && claims.expected_revision >= 0
    && typeof claims.payload_sha256 === 'string' && /^[a-f0-9]{64}$/.test(claims.payload_sha256)
    && typeof claims.issued_at === 'string' && Number.isFinite(Date.parse(claims.issued_at))
    && typeof claims.expires_at === 'string' && Number.isFinite(Date.parse(claims.expires_at))
    && Date.parse(claims.issued_at) <= Date.parse(claims.expires_at)
}

function sign(payload: WorkboardAdminAssertionClaims, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64Url(JSON.stringify(payload))
  return `${header}.${body}.${base64Url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest())}`
}

function verify(token: string, secret: string): WorkboardAdminAssertionClaims | undefined {
  const [header, body, signature, extra] = token.split('.')
  if (!header || !body || !signature || extra) return undefined
  const parsedHeader = decodeJson(header)
  if (!exactKeys(parsedHeader, ['alg', 'typ']) || parsedHeader.alg !== 'HS256' || parsedHeader.typ !== 'JWT') return undefined
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest()
  let actual: Buffer
  try { actual = Buffer.from(signature, 'base64url') } catch { return undefined }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return undefined
  const claims = decodeJson(body)
  return validClaims(claims) ? claims : undefined
}

/**
 * Admin task-board writes get their own assertion namespace and persistent one-time redemption.
 * An assertion authorizes only one board mutation; it never carries execution permissions.
 */
export class WorkboardAdminAssertions {
  private readonly filePath: string
  private state: PersistedAssertions | undefined
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly dataDir: string,
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.filePath = path.join(dataDir, 'workboard-admin-assertions.json')
  }

  async issue(input: ExpectedWorkboardAdminAssertion): Promise<string> {
    if (!input.manager_key || !/^[a-f0-9]{64}$/.test(input.payload_sha256)) throw new Error('invalid assertion input')
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) throw new Error('invalid expected revision')
    const issued = this.now()
    const expires = new Date(issued.getTime() + TTL_SECONDS * 1_000)
    const claims: WorkboardAdminAssertionClaims = {
      assertion_id: generateId(),
      issuer_module_id: ISSUER,
      audience: AUDIENCE,
      purpose: PURPOSE,
      manager_key: input.manager_key,
      action: input.action,
      expected_revision: input.expected_revision,
      payload_sha256: input.payload_sha256,
      issued_at: issued.toISOString(),
      expires_at: expires.toISOString(),
    }
    await this.serialize(async () => {
      const state = await this.loadUnlocked()
      this.prune(state, issued.getTime())
      state.issued[claims.assertion_id] = { expires_at: claims.expires_at }
      await this.persistUnlocked(state)
    })
    return sign(claims, this.secret)
  }

  async consume(
    assertion: string,
    expected: ExpectedWorkboardAdminAssertion,
  ): Promise<{ consumed: true; expires_at: string }> {
    return this.serialize(async () => {
      const claims = verify(assertion, this.secret)
      if (!claims) throw new Error('invalid workboard admin assertion')
      if (
        claims.manager_key !== expected.manager_key
        || claims.action !== expected.action
        || claims.expected_revision !== expected.expected_revision
        || claims.payload_sha256 !== expected.payload_sha256
      ) throw new Error('workboard admin assertion claim mismatch')
      const current = this.now().getTime()
      if (Date.parse(claims.expires_at) <= current) throw new Error('workboard admin assertion expired')
      const state = await this.loadUnlocked()
      this.prune(state, current)
      if (state.consumed[claims.assertion_id]) throw new Error('workboard admin assertion already consumed')
      const issued = state.issued[claims.assertion_id]
      if (!issued || issued.expires_at !== claims.expires_at) {
        throw new Error('workboard admin assertion is unavailable')
      }
      delete state.issued[claims.assertion_id]
      state.consumed[claims.assertion_id] = claims.expires_at
      await this.persistUnlocked(state)
      return { consumed: true, expires_at: claims.expires_at }
    })
  }

  private async loadUnlocked(): Promise<PersistedAssertions> {
    if (this.state) return this.state
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid assertion store')
      const record = parsed as Record<string, unknown>
      if (!exactKeys(record, ['issued', 'consumed']) || !record.issued || !record.consumed || typeof record.issued !== 'object' || typeof record.consumed !== 'object') {
        throw new Error('invalid assertion store')
      }
      const issued: PersistedAssertions['issued'] = {}
      for (const [id, value] of Object.entries(record.issued as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid assertion store')
        const item = value as Record<string, unknown>
        // Existing stores may retain the retired permission snapshot. It is deliberately
        // ignored, and the next ordinary persistence rewrites the entry without it.
        if (
          (!exactKeys(item, ['expires_at']) && !exactKeys(item, ['expires_at', 'principal_permissions']))
          || typeof item.expires_at !== 'string'
          || !Number.isFinite(Date.parse(item.expires_at))
        ) {
          throw new Error('invalid assertion store')
        }
        issued[id] = { expires_at: item.expires_at }
      }
      const consumed: PersistedAssertions['consumed'] = {}
      for (const [id, expiry] of Object.entries(record.consumed as Record<string, unknown>)) {
        if (typeof expiry !== 'string' || !Number.isFinite(Date.parse(expiry))) throw new Error('invalid assertion store')
        consumed[id] = expiry
      }
      this.state = { issued, consumed }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.state = { issued: {}, consumed: {} }
      else throw error
    }
    return this.state
  }

  private prune(state: PersistedAssertions, nowMs: number): void {
    for (const [id, item] of Object.entries(state.issued)) if (Date.parse(item.expires_at) <= nowMs) delete state.issued[id]
    for (const [id, expiry] of Object.entries(state.consumed)) if (Date.parse(expiry) <= nowMs) delete state.consumed[id]
  }

  private async persistUnlocked(state: PersistedAssertions): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.tmp-${generateId()}`
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
    await fs.rename(temporary, this.filePath)
  }

  private async serialize<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.writeTail
    let release!: () => void
    this.writeTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await action() } finally { release() }
  }
}
