import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, readCredentials, writeCredentials, createCredentialsIfAbsent, newCredentialsFromPassword, rotateCredentials, DEFAULT_SCRYPT_PARAMS, type Credentials } from './credentials'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

async function makeTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'crab-cred-'))
}

describe('credentials hash/verify', () => {
  it('hashPassword 产出可验证的 hash', async () => {
    const { salt, hash, params } = await hashPassword('hello-world')

    expect(salt).toMatch(/^[0-9a-f]{32}$/) // 16 bytes hex
    expect(hash).toMatch(/^[0-9a-f]+$/)
    expect(params).toEqual(DEFAULT_SCRYPT_PARAMS)

    expect(await verifyPassword('hello-world', { salt, hash, params })).toBe(true)
    expect(await verifyPassword('wrong', { salt, hash, params })).toBe(false)
  })

  it('同样密码两次 hash 产生不同 salt 与 hash', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
  })
})

describe('credentials read/write', () => {
  it('writeCredentials 原子写入，readCredentials 读回', async () => {
    const dir = await makeTmpDir()
    const cred: Credentials = {
      algo: 'scrypt',
      salt: 'aa',
      hash: 'bb',
      params: DEFAULT_SCRYPT_PARAMS,
      is_temp: true,
      token_epoch: 0,
      created_at: new Date().toISOString(),
      last_changed_at: new Date().toISOString(),
      changed_via: 'start',
    }
    await writeCredentials(dir, cred)

    const stat = await fs.stat(path.join(dir, 'credentials.json'))
    expect(stat.mode & 0o777).toBe(0o600)

    const read = await readCredentials(dir)
    expect(read).toEqual(cred)
  })

  it('readCredentials 在文件不存在且无 .env 时返回 null', async () => {
    const dir = await makeTmpDir()
    expect(await readCredentials(dir)).toBeNull()
  })

  it('readCredentials 在 JSON 损坏时抛错', async () => {
    const dir = await makeTmpDir()
    await fs.writeFile(path.join(dir, 'credentials.json'), 'not-json{', 'utf-8')
    await expect(readCredentials(dir)).rejects.toThrow()
  })
})

describe('credentials .env migration', () => {
  it('credentials.json 不存在但 .env 含密码 → 迁移 + 删 .env + is_temp=true', async () => {
    const dir = await makeTmpDir()
    await fs.writeFile(path.join(dir, '.env'), 'CRABOT_ADMIN_PASSWORD=plain-old\n', 'utf-8')

    const cred = await readCredentials(dir)
    expect(cred).not.toBeNull()
    expect(cred!.is_temp).toBe(true)
    expect(cred!.changed_via).toBe('start')
    expect(await verifyPassword('plain-old', cred!)).toBe(true)

    // .env 被删
    await expect(fs.access(path.join(dir, '.env'))).rejects.toThrow()
  })

  it('.env 含其他 keys 时只迁移密码 + 抛错让用户处理', async () => {
    const dir = await makeTmpDir()
    await fs.writeFile(
      path.join(dir, '.env'),
      'CRABOT_ADMIN_PASSWORD=p\nOTHER=keep-me\n',
      'utf-8',
    )
    await expect(readCredentials(dir)).rejects.toThrow(/other keys/i)
  })

  it('.env 不含密码键 → 返回 null，不动文件', async () => {
    const dir = await makeTmpDir()
    await fs.writeFile(path.join(dir, '.env'), 'OTHER=x\n', 'utf-8')
    expect(await readCredentials(dir)).toBeNull()
    const raw = await fs.readFile(path.join(dir, '.env'), 'utf-8')
    expect(raw).toContain('OTHER=x')
  })

  it('迁移幂等：第二次调用直接读到迁移结果', async () => {
    const dir = await makeTmpDir()
    await fs.writeFile(path.join(dir, '.env'), 'CRABOT_ADMIN_PASSWORD=x\n', 'utf-8')
    const a = await readCredentials(dir)
    const b = await readCredentials(dir)
    expect(b).toEqual(a)
  })
})

describe('rotateCredentials', () => {
  it('epoch++、is_temp=false、changed_via=cli、新 hash 可验证', async () => {
    const initial = await newCredentialsFromPassword('old', { is_temp: true, changed_via: 'start' })
    const rotated = await rotateCredentials(initial, 'new-secret', 'cli')

    expect(rotated.token_epoch).toBe(initial.token_epoch + 1)
    expect(rotated.is_temp).toBe(false)
    expect(rotated.changed_via).toBe('cli')
    expect(rotated.created_at).toBe(initial.created_at)
    expect(rotated.last_changed_at).not.toBe(initial.last_changed_at)
    expect(await verifyPassword('new-secret', rotated)).toBe(true)
    expect(await verifyPassword('old', rotated)).toBe(false)
  })
})

it('首次密码并发发布只有一个成功，不覆盖赢家，且不留下临时凭据', async () => {
  const dir = await makeTmpDir()
  try {
    const candidates = await Promise.all(['first', 'second'].map(password => newCredentialsFromPassword(password, { is_temp: false, changed_via: 'ui' })))
    const results = await Promise.all(candidates.map(credentials => createCredentialsIfAbsent(dir, credentials)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await readCredentials(dir)).toEqual(candidates[results.indexOf(true)])
    expect(await fs.readdir(dir)).toEqual(['credentials.json'])
    expect(await createCredentialsIfAbsent(dir, candidates[results.indexOf(false)])).toBe(false)
    expect(await readCredentials(dir)).toEqual(candidates[results.indexOf(true)])
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
