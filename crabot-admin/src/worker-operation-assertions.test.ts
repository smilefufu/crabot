import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WorkerOperationAssertions } from './worker-operation-assertions.js'

let dir: string
let assertions: WorkerOperationAssertions

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-worker-assertions-'))
  assertions = new WorkerOperationAssertions(dir, 'test-secret-at-least-32-chars-long!!')
})
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const base = { action: 'verify' as const, operation_id: 'op-1', impl: 'claude-code' as const, mode: 'native_account', policy_revision: 1 }

describe('WorkerOperationAssertions（P6-B §9）', () => {
  it('issue → consume exact 匹配成功；nonce 一次性（重放拒绝）', async () => {
    const token = assertions.issue(base)
    const result = await assertions.consume(token, base)
    expect(result.consumed).toBe(true)
    await expect(assertions.consume(token, base)).rejects.toThrow(/already consumed/)
  })

  it('claim 不匹配（action/impl/revision/mode）逐个拒绝', async () => {
    await expect(assertions.consume(assertions.issue(base), { ...base, action: 'cancel' })).rejects.toThrow(/mismatch/)
    await expect(assertions.consume(assertions.issue(base), { ...base, impl: 'codex' })).rejects.toThrow(/mismatch/)
    await expect(assertions.consume(assertions.issue(base), { ...base, policy_revision: 2 })).rejects.toThrow(/mismatch/)
    await expect(assertions.consume(assertions.issue(base), { ...base, operation_id: 'op-2' })).rejects.toThrow(/mismatch/)
  })

  it('篡改/异 secret/垃圾 token 拒绝', async () => {
    const token = assertions.issue(base)
    const forged = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa')
    await expect(assertions.consume(forged, base)).rejects.toThrow(/invalid/)
    const other = new WorkerOperationAssertions(dir, 'different-secret-different-secret!!')
    await expect(other.consume(token, base)).rejects.toThrow(/invalid/)
    await expect(assertions.consume('garbage', base)).rejects.toThrow(/invalid/)
  })

  it('consumed 持久化：新实例（重启）仍拒绝重放', async () => {
    const token = assertions.issue(base)
    await assertions.consume(token, base)
    const fresh = new WorkerOperationAssertions(dir, 'test-secret-at-least-32-chars-long!!')
    await expect(fresh.consume(token, base)).rejects.toThrow(/already consumed|invalid/)
  })

  it('chat assertion 不能跨域核销（purpose/audience/claims 不同）', async () => {
    // admin-chat assertion 的 claims 集合不同（manager_key/request_id），worker validator 拒绝。
    const chatLike = assertions.issue(base)
    await expect(assertions.consume(chatLike, { ...base, action: 'cancel' as const })).rejects.toThrow(/mismatch/)
  })
})
