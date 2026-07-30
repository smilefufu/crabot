import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ManagerSessionStore } from '../../src/manager/session-store'
import { encodeSegment, decodeSegment } from '../../src/workers/harness/ledger-store'
import type { ManagerKey, ManagerSessionState } from '../../src/manager/types'
import { createUserMessage } from '../../src/engine/index.js'

describe('ManagerSessionStore', () => {
  let dir: string
  let store: ManagerSessionStore

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'manager-session-store-test-'))
    store = new ManagerSessionStore(dir)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('save 后 load 往返,含 rollingSummary/recent/lastActiveAt/foldedCount 全部字段', async () => {
    const key: ManagerKey = 'wechat::sess-1'
    const state: ManagerSessionState = {
      key,
      rollingSummary: '此前对话摘要:用户询问了天气',
      recent: [createUserMessage('今天天气怎么样')],
      lastActiveAt: '2026-07-30T08:00:00.000Z',
      foldedCount: 12,
    }

    await store.save(state)
    const loaded = await store.load(key)

    expect(loaded.key).toBe(key)
    expect(loaded.rollingSummary).toBe(state.rollingSummary)
    expect(loaded.recent).toHaveLength(1)
    expect(loaded.recent[0]).toMatchObject({ role: 'user', content: '今天天气怎么样' })
    expect(loaded.lastActiveAt).toBe('2026-07-30T08:00:00.000Z')
    expect(loaded.foldedCount).toBe(12)
  })

  it('不存在的 key 返回空态,且不建目录', async () => {
    const key: ManagerKey = 'wechat::sess-never-seen'
    const loaded = await store.load(key)

    expect(loaded).toEqual({ key, recent: [], foldedCount: 0 })

    const entries = await fs.readdir(dir).catch(() => [])
    expect(entries).toHaveLength(0)
  })

  it('并发 save 同一个 key 不丢(锁串行化写入)', async () => {
    const key: ManagerKey = 'wechat::sess-concurrent'
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.save({ key, recent: [], foldedCount: i, lastActiveAt: `t-${i}` })
      )
    )

    const loaded = await store.load(key)
    // 10 次并发 save 里最后落盘的一定是某一次完整写入(不会出现半写/损坏的 JSON)
    expect(loaded.key).toBe(key)
    expect(typeof loaded.foldedCount).toBe('number')
    expect(loaded.foldedCount).toBeGreaterThanOrEqual(0)
    expect(loaded.foldedCount).toBeLessThan(10)
  })

  it('编码方案对含 ::、/、中文的 key 双向可逆', () => {
    const keys = ['wechat::sess-1', 'group:wechat/leaks::sess-中文-1', '中文频道::中文会话']
    for (const k of keys) {
      const encoded = encodeSegment(k)
      expect(encoded).not.toContain('/')
      expect(decodeSegment(encoded)).toBe(k)
    }
  })

  it('坏 state.json 抛明确错误,不静默当空', async () => {
    const key: ManagerKey = 'wechat::sess-corrupt'
    const encodedDir = join(dir, encodeSegment(key))
    await fs.mkdir(encodedDir, { recursive: true })
    await fs.writeFile(join(encodedDir, 'state.json'), '{ this is not json', 'utf-8')

    await expect(store.load(key)).rejects.toThrow(/损坏|JSON/)
  })

  it('appendEpisodeLog 追加成行,且不影响 load(不参与 load 语义)', async () => {
    const key: ManagerKey = 'wechat::sess-episode'
    const msg1 = createUserMessage('第一条')
    const msg2 = createUserMessage('第二条')

    await store.appendEpisodeLog(key, 'ep-1', [msg1])
    await store.appendEpisodeLog(key, 'ep-1', [msg2])

    const episodePath = join(dir, encodeSegment(key), 'episodes', 'ep-1.jsonl')
    const raw = await fs.readFile(episodePath, 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toMatchObject({ role: 'user', content: '第一条' })
    expect(JSON.parse(lines[1])).toMatchObject({ role: 'user', content: '第二条' })

    // appendEpisodeLog 只写诊断日志,不写 state.json,load 仍返回空态
    const loaded = await store.load(key)
    expect(loaded).toEqual({ key, recent: [], foldedCount: 0 })
  })
})
