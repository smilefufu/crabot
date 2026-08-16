/**
 * Worker operation assertion（P6-B plan §9）。
 *
 * 从 AdminChatAssertions 抽出的无业务语义小组件同形实现：canonical sign/verify +
 * consumed store。chat 与 worker 用不同 purpose/audience/claim validator，assertion
 * 不可跨域复用。worker assertion 精确绑定 action、operation ID、impl、mode、
 * policy revision、nonce、issued/expiry。consumed nonce 在返回成功前原子持久，
 * 保留到 expiry，重启仍拒绝。
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { generateId } from 'crabot-shared'

const AUDIENCE = 'crabot-agent'
const PURPOSE = 'worker_operation'
const ISSUER = 'admin-web'
const TTL_SECONDS = 120
const CLAIM_KEYS = ['assertion_id', 'issuer_module_id', 'audience', 'purpose', 'action', 'operation_id', 'impl', 'mode', 'policy_revision', 'nonce', 'issued_at', 'expires_at'] as const

export type WorkerOperationAction = 'verify' | 'cancel'

export interface WorkerOperationClaims {
  assertion_id: string
  issuer_module_id: typeof ISSUER
  audience: typeof AUDIENCE
  purpose: typeof PURPOSE
  action: WorkerOperationAction
  operation_id: string
  impl: 'claude-code' | 'codex'
  mode: string
  policy_revision: number
  nonce: string
  issued_at: string
  expires_at: string
}

export type ExpectedWorkerOperation = Pick<WorkerOperationClaims, 'action' | 'operation_id' | 'impl' | 'mode' | 'policy_revision'>

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
function validClaims(value: unknown): value is WorkerOperationClaims {
  if (!exactKeys(value, CLAIM_KEYS)) return false
  const claims = value as Record<string, unknown>
  return typeof claims.assertion_id === 'string' && claims.assertion_id.length > 0
    && claims.issuer_module_id === ISSUER && claims.audience === AUDIENCE && claims.purpose === PURPOSE
    && ['verify', 'cancel'].includes(claims.action as string)
    && typeof claims.operation_id === 'string' && claims.operation_id.length > 0
    && (claims.impl === 'claude-code' || claims.impl === 'codex')
    && typeof claims.mode === 'string' && claims.mode.length > 0
    && typeof claims.policy_revision === 'number' && Number.isInteger(claims.policy_revision) && claims.policy_revision >= 1
    && typeof claims.nonce === 'string' && claims.nonce.length >= 16
    && typeof claims.issued_at === 'string' && Number.isFinite(Date.parse(claims.issued_at))
    && typeof claims.expires_at === 'string' && Number.isFinite(Date.parse(claims.expires_at))
    && Date.parse(claims.issued_at) <= Date.parse(claims.expires_at)
}
function sign(payload: WorkerOperationClaims, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64Url(JSON.stringify(payload))
  return `${header}.${body}.${base64Url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest())}`
}
function verifyToken(token: string, secret: string): WorkerOperationClaims | undefined {
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

export class WorkerOperationAssertions {
  private readonly consumedPath: string
  private consumed: Map<string, string> | null = null

  constructor(
    private readonly dataDir: string,
    private readonly secret: string,
  ) {
    this.consumedPath = path.join(dataDir, 'worker-operation-assertions.json')
  }

  issue(input: { action: WorkerOperationAction; operation_id: string; impl: 'claude-code' | 'codex'; mode: string; policy_revision: number }): string {
    const now = Date.now()
    return sign({
      assertion_id: generateId(),
      issuer_module_id: ISSUER,
      audience: AUDIENCE,
      purpose: PURPOSE,
      action: input.action,
      operation_id: input.operation_id,
      impl: input.impl,
      mode: input.mode,
      policy_revision: input.policy_revision,
      nonce: crypto.randomBytes(24).toString('base64url'),
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + TTL_SECONDS * 1000).toISOString(),
    }, this.secret)
  }

  /**
   * 核销：exact claims 匹配 + nonce 一次性（原子持久后再返回成功）。
   * 并发双核销只有一个成功；重启仍拒绝（consumed 落盘）。
   */
  async consume(token: string, expected: ExpectedWorkerOperation): Promise<{ consumed: true; expires_at: string }> {
    const claims = verifyToken(token, this.secret)
    if (!claims) throw new Error('invalid worker operation assertion')
    if (Date.parse(claims.expires_at) <= Date.now()) throw new Error('worker operation assertion expired')
    for (const key of Object.keys(expected) as Array<keyof ExpectedWorkerOperation>) {
      if (claims[key] !== expected[key]) throw new Error(`worker operation assertion claim mismatch: ${key}`)
    }
    await this.loadConsumed()
    // 每次核销都按 TTL 裁剪（长跑 Admin 不再单调增长）。
    const now = Date.now()
    for (const [nonce, expiry] of this.consumed!) {
      if (Date.parse(expiry) <= now) this.consumed!.delete(nonce)
    }
    if (this.consumed!.has(claims.nonce)) throw new Error('worker operation assertion already consumed')
    this.consumed!.set(claims.nonce, claims.expires_at)
    await this.persistConsumed()
    return { consumed: true, expires_at: claims.expires_at }
  }

  private async loadConsumed(): Promise<void> {
    if (this.consumed) return
    try {
      const raw = await fs.readFile(this.consumedPath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, string>
      const now = Date.now()
      // 只保留未过期的 nonce（过期断言本就会被 TTL 拒绝）。
      this.consumed = new Map(Object.entries(parsed).filter(([, expiry]) => Date.parse(expiry) > now))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.consumed = new Map()
        return
      }
      throw error
    }
  }

  private async persistConsumed(): Promise<void> {
    await fs.mkdir(path.dirname(this.consumedPath), { recursive: true, mode: 0o700 })
    const tmpPath = `${this.consumedPath}.tmp-${process.pid}`
    await fs.writeFile(tmpPath, JSON.stringify(Object.fromEntries(this.consumed!)), { mode: 0o600 })
    await fs.rename(tmpPath, this.consumedPath)
  }
}
