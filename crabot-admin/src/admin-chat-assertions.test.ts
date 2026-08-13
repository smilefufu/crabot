import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AdminChatAssertions } from './admin-chat-assertions.js'

describe('AdminChatAssertions', () => {
  let dir: string
  let now: Date

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'admin-chat-assertion-'))
    now = new Date('2026-08-10T00:00:00.000Z')
  })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('issues required opaque claims and atomically rejects wrong expected values and replay after restart', async () => {
    const issue = new AdminChatAssertions(dir, 'secret', () => now)
    await issue.load()
    const assertion = issue.issue({ requestId: 'request-1', payloadSha256: 'a'.repeat(64) })
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString('utf8'))
    expect(claims).toMatchObject({
      assertion_id: expect.any(String), issuer_module_id: 'admin-web', audience: 'crabot-agent', purpose: 'admin_chat',
      manager_key: 'admin-web::admin-chat', request_id: 'request-1', payload_sha256: 'a'.repeat(64),
      issued_at: now.toISOString(), expires_at: expect.any(String),
    })
    await expect(issue.consume(assertion, { manager_key: 'admin-web::admin-chat', request_id: 'request-1', payload_sha256: 'b'.repeat(64) })).rejects.toThrow(/invalid/)
    await expect(issue.consume(assertion, { manager_key: 'admin-web::admin-chat', request_id: 'request-1', payload_sha256: 'a'.repeat(64) })).resolves.toMatchObject({ consumed: true })
    const restarted = new AdminChatAssertions(dir, 'secret', () => now)
    await restarted.load()
    await expect(restarted.consume(assertion, { manager_key: 'admin-web::admin-chat', request_id: 'request-1', payload_sha256: 'a'.repeat(64) })).rejects.toThrow(/consumed/)
  })

  it('rejects tampered header/body/signature, malformed claims, corrupt stores, and permits exactly one concurrent consume', async () => {
    const assertions = new AdminChatAssertions(dir, 'secret', () => now)
    await assertions.load()
    const assertion = assertions.issue({ requestId: 'request-1', payloadSha256: 'a'.repeat(64) })
    const [header, body, signature] = assertion.split('.')
    const expected = { manager_key: 'admin-web::admin-chat' as const, request_id: 'request-1', payload_sha256: 'a'.repeat(64) }
    for (const token of [
      `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${body}.${signature}`,
      `${header}.${Buffer.from(JSON.stringify({ assertion_id: 'x' })).toString('base64url')}.${signature}`,
      // 篡改首字符（base64url 首字符编码完整 6 bit，必然改变解码字节；
      // 末尾字符的低位是填充位，篡改可能不改变解码结果）。
      `${header}.${body}.${signature!.charAt(0) === 'A' ? 'B' : 'A'}${signature!.slice(1)}`,
    ]) await expect(assertions.consume(token, expected)).rejects.toThrow(/invalid/)
    const concurrent = await Promise.allSettled([assertions.consume(assertion, expected), assertions.consume(assertion, expected)])
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1)

    await fs.writeFile(join(dir, 'admin-chat-assertions.json'), JSON.stringify({ good: now.toISOString(), bad: 4 }))
    await expect(new AdminChatAssertions(dir, 'secret', () => now).load()).rejects.toThrow(/invalid consumed assertion store/)
  })

  it('rejects expired assertion', async () => {
    const assertions = new AdminChatAssertions(dir, 'secret', () => now)
    const assertion = assertions.issue({ requestId: 'request-1', payloadSha256: 'a'.repeat(64) })
    now = new Date(now.getTime() + 61_000)
    await expect(assertions.consume(assertion, { manager_key: 'admin-web::admin-chat', request_id: 'request-1', payload_sha256: 'a'.repeat(64) })).rejects.toThrow(/expired/)
  })
})
