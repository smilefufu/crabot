import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ManagerSessionStore } from '../../src/manager/session-store'
import { encodeSegment, decodeSegment } from '../../src/workers/harness/ledger-store'
import type { ManagerKey, ManagerSessionState } from '../../src/manager/types'
import type { ManagerResumeCheckpoint } from '../../src/manager/resume-checkpoint.js'
import { resumeManagerMessages } from '../../src/manager/resume-checkpoint.js'
import { createUserMessage, createAssistantMessage, createBatchToolResultMessage } from '../../src/engine/types.js'

describe('ManagerSessionStore', () => {
  it('validates a relocation checkpoint without touching history or completing an unknown tool call', () => {
    const key: ManagerKey = 'wechat::offline-checkpoint'
    const state = { key, foldedCount: 0, recent: [createAssistantMessage([{ type: 'tool_use', id: 'unknown-call', name: 'Write', input: { path: '/original' } }], 'tool_use')] }
    const checkpoint: ManagerResumeCheckpoint = { episodeId: 'original-episode', state, envelopes: [], wakeIndex: -1, pending: [], hasEngineMessages: true,
      turns: [], responses: [], tools: [], pendingToolCallIds: ['unknown-call'], adminChatClaims: [['original-admin-request', 'unclaimed']], transientMessageIds: [], spawnedWorkerIds: ['original-worker'],
      execution: { needsSpawnRecheck: false, spawnRecheckInjected: false, spawnRecheckOutcomeRecorded: false, postSendRecheckSequence: 0,
        successfulSendMessageTargets: [], continuedWorkers: [] } }
    const raw = JSON.stringify(checkpoint, null, 4) + '\n'
    expect(ManagerSessionStore.parseWorkspaceRelocationCheckpoint(key, raw)).toEqual(checkpoint)
    expect(ManagerSessionStore.parseWorkspaceRelocationCheckpoint(key, raw).state.recent).toHaveLength(1)
    expect(() => ManagerSessionStore.parseWorkspaceRelocationCheckpoint('other::manager', raw)).toThrow('invalid resume checkpoint')
    expect(() => ManagerSessionStore.parseWorkspaceRelocationCheckpoint(key, JSON.stringify({ ...checkpoint, pendingToolCallIds: null }))).toThrow('invalid resume checkpoint')
    expect(() => ManagerSessionStore.parseWorkspaceRelocationCheckpoint(key, JSON.stringify({ ...checkpoint, execution: {} }))).toThrow('invalid resume checkpoint')
    expect(JSON.stringify(checkpoint, null, 4) + '\n').toBe(raw)
  })

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

  it('repairs missing legacy results once and backs up the exact original bytes', async () => {
    const key: ManagerKey = 'wechat::legacy'
    const state: ManagerSessionState = { key, foldedCount: 7, recent: [
      createUserMessage('human'),
      createAssistantMessage([{ type: 'text', text: 'keep original text' },
        { type: 'tool_use', id: 'a', name: 'Read', input: { path: '/old' } },
        { type: 'tool_use', id: 'b', name: 'Read', input: {} }], 'tool_use'),
      createBatchToolResultMessage([{ tool_use_id: 'b', content: 'known', is_error: false,
        images: [{ media_type: 'image/png', data: 'image' }] }]),
      createUserMessage('later'),
    ] }
    const path = join(dir, encodeSegment(key), 'state.json')
    await fs.mkdir(join(dir, encodeSegment(key)), { recursive: true })
    const original = JSON.stringify(state) + '\n'
    await fs.writeFile(path, original, { mode: 0o640 })
    const loaded = await store.load(key)
    expect(loaded.recent[1]).toEqual(state.recent[1])
    expect(loaded.recent[2]).toMatchObject({ id: state.recent[2].id, timestamp: state.recent[2].timestamp, toolResults: [
      { tool_use_id: 'b', content: 'known', is_error: false, images: [{ media_type: 'image/png', data: 'image' }] },
      { tool_use_id: 'a', is_error: true, content: expect.stringContaining('unknown') },
    ] })
    expect(loaded.recent[3]).toEqual(state.recent[3])
    const backups = (await fs.readdir(join(dir, encodeSegment(key)))).filter(n => n.startsWith('state.json.bak-tool-history-'))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(join(dir, encodeSegment(key), backups[0]), 'utf-8')).toBe(original)
    expect((await fs.stat(join(dir, encodeSegment(key), backups[0]))).mode & 0o137).toBe(0)
    expect(await store.load(key)).toEqual(loaded)
    expect((await fs.readdir(join(dir, encodeSegment(key)))).filter(n => n.startsWith('state.json.bak-tool-history-'))).toEqual(backups)
  })

  it('rejects incomplete ordinary history commits before touching disk', async () => {
    const key: ManagerKey = 'wechat::reject'
    const valid: ManagerSessionState = { key, recent: [createUserMessage('original')], foldedCount: 0 }
    await store.save(valid)
    const incomplete = createAssistantMessage([{ type: 'tool_use', id: 'orphan', name: 'Read', input: {} }], 'tool_use')
    await expect(store.save({ ...valid, recent: [...valid.recent, incomplete] })).rejects.toThrow(/missing tool_result/)
    await expect(store.appendEpisodeLog(key, 'bad', [incomplete])).rejects.toThrow(/missing tool_result/)
    expect(await store.load(key)).toEqual(valid)
    expect(await fs.readdir(join(dir, encodeSegment(key)))).toEqual(['state.json'])
  })

  it('leaves the original history intact when backup fails', async () => {
    const key: ManagerKey = 'wechat::backup-failure'
    const path = join(dir, encodeSegment(key), 'state.json')
    await fs.mkdir(join(dir, encodeSegment(key)), { recursive: true })
    const original = JSON.stringify({ key, foldedCount: 0, recent: [createAssistantMessage([
      { type: 'tool_use', id: 'lost', name: 'Read', input: {} }], 'tool_use')] })
    await fs.writeFile(path, original)
    const open = vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('backup unavailable'))
    try { await expect(store.load(key)).rejects.toThrow('backup unavailable') }
    finally { open.mockRestore() }
    expect(await fs.readFile(path, 'utf-8')).toBe(original)
  })

  it('keeps the original state when atomic repair save fails and reuses the verified backup on retry', async () => {
    const key: ManagerKey = 'wechat::save-failure'
    const path = join(dir, encodeSegment(key), 'state.json')
    await fs.mkdir(join(dir, encodeSegment(key)), { recursive: true })
    const original = JSON.stringify({ key, foldedCount: 0, recent: [createAssistantMessage([
      { type: 'tool_use', id: 'lost', name: 'Read', input: {} }], 'tool_use')] })
    await fs.writeFile(path, original)
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('atomic save unavailable'))
    try { await expect(store.load(key)).rejects.toThrow('atomic save unavailable') }
    finally { rename.mockRestore() }
    expect(await fs.readFile(path, 'utf-8')).toBe(original)
    expect((await fs.readdir(join(dir, encodeSegment(key)))).filter(n => n.startsWith('.tmp-'))).toEqual([])
    const repaired = await store.load(key)
    expect(repaired.recent).toHaveLength(2)
    expect((await fs.readdir(join(dir, encodeSegment(key)))).filter(n => n.startsWith('state.json.bak-tool-history-'))).toHaveLength(1)
  })

  it('prefers an unambiguous checkpoint result and does not duplicate an already-recorded call on recovery', async () => {
    const key: ManagerKey = 'wechat::checkpoint'
    const original = { key, foldedCount: 0, recent: [createAssistantMessage([
      { type: 'tool_use', id: 'lost', name: 'Read', input: { path: '/same' } }], 'tool_use')] }
    const checkpoint: ManagerResumeCheckpoint = { episodeId: 'known-episode', state: original,
      envelopes: [], wakeIndex: -1, pending: [], hasEngineMessages: true, turns: [], responses: [],
      tools: [{ type: 'tool_finished', toolUseId: 'lost', callId: 'internal-call', responseId: 'response', turnNumber: 1,
        name: 'Read', input: { path: '/same' }, output: 'known completed output', isError: false,
        startedAtMs: 0, endedAtMs: 1, durationMs: 1 }], pendingToolCallIds: ['internal-call'],
      adminChatClaims: [], transientMessageIds: [], spawnedWorkerIds: [],
      execution: { needsSpawnRecheck: false, spawnRecheckInjected: false, spawnRecheckOutcomeRecorded: false,
        postSendRecheckSequence: 0, successfulSendMessageTargets: [], continuedWorkers: [] } }
    await store.ensureSession(key)
    await fs.writeFile(join(dir, encodeSegment(key), 'state.json'), JSON.stringify(original))
    store.saveCheckpoint(checkpoint)
    const recovered = resumeManagerMessages(checkpoint)
    expect(recovered.filter(m => m.role === 'assistant')).toHaveLength(1)
    expect(recovered[1]).toMatchObject({ toolResults: [{ tool_use_id: 'lost', content: 'known completed output', is_error: false }] })
    const loaded = await store.load(key)
    expect(loaded.recent[0]).toEqual(original.recent[0])
    expect(loaded.recent[1]).toMatchObject({ toolResults: [{ content: 'known completed output', is_error: false }] })
    store.saveCheckpoint({ ...checkpoint, state: { ...original, recent: [...original.recent,
      createBatchToolResultMessage([
        { tool_use_id: 'lost', content: 'first possible result', is_error: false },
        { tool_use_id: 'lost', content: 'conflicting result', is_error: true },
      ])] } })
    const originalBytes = JSON.stringify(original)
    await fs.writeFile(join(dir, encodeSegment(key), 'state.json'), originalBytes)
    await expect(store.load(key)).rejects.toThrow('duplicate tool_result')
    expect(await fs.readFile(join(dir, encodeSegment(key), 'state.json'), 'utf-8')).toBe(originalBytes)
  })

  it('does not rewrite complete history or ambiguous history', async () => {
    const key: ManagerKey = 'wechat::unchanged'
    await store.ensureSession(key)
    const path = join(dir, encodeSegment(key), 'state.json')
    const original = await fs.readFile(path)
    await store.load(key)
    expect((await fs.readFile(path)).equals(original)).toBe(true)
    expect(await fs.readdir(join(dir, encodeSegment(key)))).toEqual(['state.json'])
    const invalid = JSON.stringify({ key, foldedCount: 0, recent: [
      createAssistantMessage([{ type: 'tool_use', id: 'same', name: 'Read', input: {} },
        { type: 'tool_use', id: 'same', name: 'Read', input: {} }], 'tool_use')] })
    await fs.writeFile(path, invalid)
    await expect(store.load(key)).rejects.toThrow('duplicate')
    expect(await fs.readFile(path, 'utf-8')).toBe(invalid)
    expect(await fs.readdir(join(dir, encodeSegment(key)))).toEqual(['state.json'])
  })
})
