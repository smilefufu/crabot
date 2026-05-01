/**
 * MessageStore 单元测试
 *
 * 回归覆盖：limit 语义必须拿最新 N 条（slice(-limit)），
 * 不能在 page 默认 1 时退化成 slice(0, limit) → 拿最早 N 条。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MessageStore, type StoredMessage } from '../src/message-store'

let tmpDir: string
let store: MessageStore
const sessionId = 'session-test'

function makeMsg(idx: number): StoredMessage {
  const ts = new Date(2026, 3, 30, 12, 0, idx).toISOString()
  return {
    platform_message_id: `msg-${idx}`,
    platform_timestamp: ts,
    sender: { platform_user_id: 'u1', platform_display_name: 'U1' },
    content: { type: 'text', text: `m${idx}` },
    features: { is_mention_crab: false },
    direction: 'inbound',
  }
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-ms-'))
  store = new MessageStore(tmpDir)
  for (let i = 0; i < 20; i++) {
    await store.append(sessionId, makeMsg(i))
  }
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('query', () => {
  it('limit-only returns the LAST N messages (newest)', async () => {
    const { items, total } = await store.query({ sessionId, limit: 5 })
    expect(total).toBe(20)
    expect(items.map((m) => m.content.text)).toEqual(['m15', 'm16', 'm17', 'm18', 'm19'])
  })

  it('page+pageSize returns the slice from the start (page 1 = oldest)', async () => {
    const { items, total } = await store.query({ sessionId, page: 1, pageSize: 5 })
    expect(total).toBe(20)
    expect(items.map((m) => m.content.text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  })

  it('regression: when caller passes limit, page must be undefined to avoid slice(0, N)', async () => {
    // Mimic the buggy invocation: page=1, pageSize=limit → would return oldest.
    const buggy = await store.query({ sessionId, page: 1, pageSize: 5 })
    const correct = await store.query({ sessionId, limit: 5 })
    expect(buggy.items[0].content.text).toBe('m0')
    expect(correct.items[0].content.text).toBe('m15')
  })
})
