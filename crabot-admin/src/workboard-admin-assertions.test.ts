import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { WorkboardAdminAssertions } from './workboard-admin-assertions.js'

const EXPECTED = {
  manager_key: 'feishu::cotton-candy',
  action: 'revise_work_item' as const,
  expected_revision: 7,
  payload_sha256: 'a'.repeat(64),
}

describe('WorkboardAdminAssertions', () => {
  let dir: string
  let now: Date

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'workboard-admin-assertion-'))
    now = new Date('2026-09-05T00:00:00.000Z')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('精确绑定 mutation，核销结果和持久化状态都不携带权限', async () => {
    const assertions = new WorkboardAdminAssertions(dir, 'test-secret', () => now)
    const token = await assertions.issue(EXPECTED)
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))

    expect(claims).toMatchObject({
      assertion_id: expect.any(String),
      issuer_module_id: 'admin-web',
      audience: 'crabot-agent',
      purpose: 'admin_workboard_change',
      ...EXPECTED,
      issued_at: now.toISOString(),
    })
    await expect(assertions.consume(token, { ...EXPECTED, expected_revision: 8 })).rejects.toThrow(/claim mismatch/)
    await expect(assertions.consume(token, EXPECTED)).resolves.toMatchObject({
      consumed: true,
    })
    expect(await fs.readFile(join(dir, 'workboard-admin-assertions.json'), 'utf8')).not.toContain('principal_permissions')
  })

  it('过期、重放和重启后的重复核销都被拒绝', async () => {
    const assertions = new WorkboardAdminAssertions(dir, 'test-secret', () => now)
    const consumed = await assertions.issue(EXPECTED)
    await assertions.consume(consumed, EXPECTED)

    const restarted = new WorkboardAdminAssertions(dir, 'test-secret', () => now)
    await expect(restarted.consume(consumed, EXPECTED)).rejects.toThrow(/already consumed/)

    const expired = await restarted.issue(EXPECTED)
    now = new Date(now.getTime() + 61_000)
    await expect(restarted.consume(expired, EXPECTED)).rejects.toThrow(/expired/)
  })

  it('并发核销只有一次成功，篡改 token 不产生可用 assertion', async () => {
    const assertions = new WorkboardAdminAssertions(dir, 'test-secret', () => now)
    const token = await assertions.issue(EXPECTED)
    const concurrent = await Promise.allSettled([
      assertions.consume(token, EXPECTED),
      assertions.consume(token, EXPECTED),
    ])
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1)

    const fresh = await assertions.issue(EXPECTED)
    const [header, payload, signature] = fresh.split('.')
    const tamperedPayload = `${payload!.slice(0, -1)}${payload!.endsWith('A') ? 'B' : 'A'}`
    const tampered = `${header}.${tamperedPayload}.${signature}`
    await expect(assertions.consume(tampered, EXPECTED)).rejects.toThrow(/invalid/)
  })

  it('签发时拒绝退役的扁平事项 action', async () => {
    const assertions = new WorkboardAdminAssertions(dir, 'test-secret', () => now)

    await expect(assertions.issue({ ...EXPECTED, action: 'revise' as never })).rejects.toThrow(/invalid assertion action/)
  })

  it('兼容旧 assertion store 的权限残留，并在正常持久化时删除', async () => {
    const file = join(dir, 'workboard-admin-assertions.json')
    await fs.writeFile(file, JSON.stringify({
      issued: {
        legacy: {
          expires_at: '2026-09-05T00:01:00.000Z',
          principal_permissions: { obsolete: true },
        },
      },
      consumed: {},
    }))

    const assertions = new WorkboardAdminAssertions(dir, 'test-secret', () => now)
    await assertions.issue(EXPECTED)

    expect(await fs.readFile(file, 'utf8')).not.toContain('principal_permissions')
  })
})
