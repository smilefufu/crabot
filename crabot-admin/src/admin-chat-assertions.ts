import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { generateId } from 'crabot-shared'

const AUDIENCE = 'crabot-agent'
const PURPOSE = 'admin_chat'
const ISSUER = 'admin-web'
const TTL_SECONDS = 60
const CLAIM_KEYS = ['assertion_id', 'issuer_module_id', 'audience', 'purpose', 'manager_key', 'request_id', 'payload_sha256', 'issued_at', 'expires_at'] as const

type AssertionClaims = {
  assertion_id: string
  issuer_module_id: typeof ISSUER
  audience: typeof AUDIENCE
  purpose: typeof PURPOSE
  manager_key: 'admin-web::admin-chat'
  request_id: string
  payload_sha256: string
  issued_at: string
  expires_at: string
}
type ExpectedAssertion = Pick<AssertionClaims, 'manager_key' | 'request_id' | 'payload_sha256'>
type ConsumedAssertions = Record<string, string>

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}
function decodeJson(part: string): unknown | undefined {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) } catch { return undefined }
}
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}
function validClaims(value: unknown): value is AssertionClaims {
  if (!exactKeys(value, CLAIM_KEYS)) return false
  const claims = value as Record<string, unknown>
  return typeof claims.assertion_id === 'string' && claims.assertion_id.length > 0
    && claims.issuer_module_id === ISSUER && claims.audience === AUDIENCE && claims.purpose === PURPOSE
    && claims.manager_key === 'admin-web::admin-chat'
    && typeof claims.request_id === 'string' && claims.request_id.length > 0
    && typeof claims.payload_sha256 === 'string' && /^[a-f0-9]{64}$/.test(claims.payload_sha256)
    && typeof claims.issued_at === 'string' && Number.isFinite(Date.parse(claims.issued_at))
    && typeof claims.expires_at === 'string' && Number.isFinite(Date.parse(claims.expires_at))
    && Date.parse(claims.issued_at) <= Date.parse(claims.expires_at)
}
function sign(payload: AssertionClaims, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64Url(JSON.stringify(payload))
  return `${header}.${body}.${base64Url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest())}`
}
function verify(token: string, secret: string): AssertionClaims | undefined {
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

/** Issues and atomically consumes opaque Admin Chat assertions. Assertion values never enter chat storage. */
export class AdminChatAssertions {
  private readonly filePath: string
  private consumed: ConsumedAssertions = {}
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly dataDir: string, private readonly secret: string, private readonly now: () => Date = () => new Date()) {
    this.filePath = path.join(dataDir, 'admin-chat-assertions.json')
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid consumed assertion store')
      const current = this.now().getTime()
      const loaded: ConsumedAssertions = {}
      for (const [id, expiry] of Object.entries(parsed)) {
        if (!id || typeof expiry !== 'string' || !Number.isFinite(Date.parse(expiry))) {
          throw new Error('invalid consumed assertion store')
        }
        if (Date.parse(expiry) > current) loaded[id] = expiry
      }
      this.consumed = loaded
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }

  issue(input: { requestId: string; payloadSha256: string }): string {
    if (!input.requestId || !/^[a-f0-9]{64}$/.test(input.payloadSha256)) throw new Error('invalid assertion input')
    const issued = this.now()
    const expires = new Date(issued.getTime() + TTL_SECONDS * 1000)
    return sign({ assertion_id: generateId(), issuer_module_id: ISSUER, audience: AUDIENCE, purpose: PURPOSE,
      manager_key: 'admin-web::admin-chat', request_id: input.requestId, payload_sha256: input.payloadSha256,
      issued_at: issued.toISOString(), expires_at: expires.toISOString() }, this.secret)
  }

  async consume(assertion: string, expected: ExpectedAssertion): Promise<{ consumed: true; expires_at: string }> {
    return this.serialize(async () => {
      const claims = verify(assertion, this.secret)
      if (!claims || claims.manager_key !== expected.manager_key || claims.request_id !== expected.request_id || claims.payload_sha256 !== expected.payload_sha256) {
        throw new Error('invalid admin chat assertion')
      }
      const current = this.now().getTime()
      if (Date.parse(claims.expires_at) <= current) throw new Error('expired admin chat assertion')
      if (this.consumed[claims.assertion_id]) throw new Error('consumed admin chat assertion')
      this.consumed[claims.assertion_id] = claims.expires_at
      for (const [id, expiry] of Object.entries(this.consumed)) if (Date.parse(expiry) <= current) delete this.consumed[id]
      await fs.mkdir(this.dataDir, { recursive: true })
      const temporary = `${this.filePath}.tmp-${generateId()}`
      await fs.writeFile(temporary, JSON.stringify(this.consumed), { mode: 0o600 })
      await fs.rename(temporary, this.filePath)
      return { consumed: true, expires_at: claims.expires_at }
    })
  }

  private async serialize<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.writeTail
    let release!: () => void
    this.writeTail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await action() } finally { release() }
  }
}
