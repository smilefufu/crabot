import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'

const scryptAsync = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>

export interface ScryptParams {
  N: number
  r: number
  p: number
  keylen: number
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64,
}

export interface Credentials {
  algo: 'scrypt'
  salt: string
  hash: string
  params: ScryptParams
  is_temp: boolean
  token_epoch: number
  created_at: string
  last_changed_at: string
  changed_via: 'start' | 'cli' | 'ui'
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<{ salt: string; hash: string; params: ScryptParams }> {
  const salt = crypto.randomBytes(16).toString('hex')
  const buf = await scryptAsync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
  })
  return { salt, hash: buf.toString('hex'), params }
}

export async function verifyPassword(
  password: string,
  c: Pick<Credentials, 'salt' | 'hash' | 'params'>,
): Promise<boolean> {
  const buf = await scryptAsync(password, c.salt, c.params.keylen, {
    N: c.params.N,
    r: c.params.r,
    p: c.params.p,
  })
  const actual = buf.toString('hex')
  if (actual.length !== c.hash.length) return false
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(c.hash, 'hex'))
}

const FILE_NAME = 'credentials.json'

export async function newCredentialsFromPassword(
  password: string,
  opts: { is_temp: boolean; changed_via: Credentials['changed_via'] },
): Promise<Credentials> {
  const { salt, hash, params } = await hashPassword(password)
  const now = new Date().toISOString()
  return {
    algo: 'scrypt',
    salt,
    hash,
    params,
    is_temp: opts.is_temp,
    token_epoch: 0,
    created_at: now,
    last_changed_at: now,
    changed_via: opts.changed_via,
  }
}

export async function rotateCredentials(
  prev: Credentials,
  newPassword: string,
  changed_via: 'cli' | 'ui',
): Promise<Credentials> {
  const { salt, hash, params } = await hashPassword(newPassword)
  return {
    ...prev,
    salt,
    hash,
    params,
    is_temp: false,
    token_epoch: prev.token_epoch + 1,
    last_changed_at: new Date().toISOString(),
    changed_via,
  }
}

function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/#.*$/, '').trim()
    if (!trimmed || !trimmed.includes('=')) continue
    const idx = trimmed.indexOf('=')
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1)
  }
  return out
}

export async function readCredentials(dataDir: string): Promise<Credentials | null> {
  const target = path.join(dataDir, FILE_NAME)
  try {
    const raw = await fs.readFile(target, 'utf-8')
    return JSON.parse(raw) as Credentials
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e
  }

  // 兜底迁移：.env 含 CRABOT_ADMIN_PASSWORD
  const envPath = path.join(dataDir, '.env')
  let envRaw: string
  try {
    envRaw = await fs.readFile(envPath, 'utf-8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null
    throw e
  }

  const env = parseEnvFile(envRaw)
  const password = env['CRABOT_ADMIN_PASSWORD']
  if (!password) return null

  const cred = await newCredentialsFromPassword(password, {
    is_temp: true,
    changed_via: 'start',
  })
  await writeCredentials(dataDir, cred)

  delete env['CRABOT_ADMIN_PASSWORD']
  const remainingKeys = Object.keys(env)
  if (remainingKeys.length === 0) {
    await fs.unlink(envPath)
    console.log(`[crabot] migrated CRABOT_ADMIN_PASSWORD to ${FILE_NAME}; .env removed`)
  } else {
    throw new Error(
      `CRABOT_ADMIN_PASSWORD migrated to ${FILE_NAME}, but .env still contains other keys (${remainingKeys.join(', ')}). Please review and remove the password line yourself.`,
    )
  }

  return cred
}

export async function writeCredentials(dataDir: string, c: Credentials): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  const tmp = path.join(dataDir, `${FILE_NAME}.tmp.${process.pid}`)
  const target = path.join(dataDir, FILE_NAME)
  await fs.writeFile(tmp, JSON.stringify(c, null, 2), { mode: 0o600 })
  await fs.rename(tmp, target)
}

/** Publish a first human password atomically without overwriting a concurrent writer. */
export async function createCredentialsIfAbsent(dataDir: string, credentials: Credentials): Promise<boolean> {
  await fs.mkdir(dataDir, { recursive: true })
  const temporary = path.join(dataDir, `${FILE_NAME}.tmp.${crypto.randomUUID()}`)
  try {
    await fs.writeFile(temporary, JSON.stringify(credentials, null, 2), { flag: 'wx', mode: 0o600 })
    try { await fs.link(temporary, path.join(dataDir, FILE_NAME)); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error }
  } finally { await fs.rm(temporary, { force: true }) }
}
