import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UndoLog } from './undo-log.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'crabot-undo-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('UndoLog', () => {
  it('append 后能 list 出条目', async () => {
    const log = new UndoLog(tmpDir)
    await log.append({
      original_command: 'provider add --name x',
      reverse: { command: 'provider delete a3c1', preview_description: 'delete provider x' },
      actor: 'agent-1',
      snapshot: null,
    })
    const items = await log.list()
    expect(items).toHaveLength(1)
    expect(items[0]!.original_command).toBe('provider add --name x')
    expect(items[0]!.id).toMatch(/^undo-\d+-[a-z0-9]{4}$/)
  })

  it('list 按时间倒序', async () => {
    const log = new UndoLog(tmpDir)
    await log.append({ original_command: 'a', reverse: { command: 'A', preview_description: '' }, actor: 'h', snapshot: null })
    await new Promise(r => setTimeout(r, 5))
    await log.append({ original_command: 'b', reverse: { command: 'B', preview_description: '' }, actor: 'h', snapshot: null })
    const items = await log.list()
    expect(items[0]!.original_command).toBe('b')
    expect(items[1]!.original_command).toBe('a')
  })

  it('过期条目被过滤', async () => {
    const log = new UndoLog(tmpDir, { now: () => 0 })
    await log.append({ original_command: 'old', reverse: { command: 'X', preview_description: '' }, actor: 'h', snapshot: null })
    const futureLog = new UndoLog(tmpDir, { now: () => 25 * 3600 * 1000 })
    expect(await futureLog.list()).toHaveLength(0)
  })

  it('FIFO 上限滚动', async () => {
    const log = new UndoLog(tmpDir, { maxEntries: 3 })
    for (const c of ['a', 'b', 'c', 'd']) {
      await log.append({ original_command: c, reverse: { command: c.toUpperCase(), preview_description: '' }, actor: 'h', snapshot: null })
    }
    const items = await log.list()
    expect(items.map(i => i.original_command)).toEqual(['d', 'c', 'b'])
  })

  it('removeById 移除指定条目', async () => {
    const log = new UndoLog(tmpDir)
    const r = await log.append({ original_command: 'x', reverse: { command: 'X', preview_description: '' }, actor: 'h', snapshot: null })
    await log.removeById(r.id)
    expect(await log.list()).toHaveLength(0)
  })

  it('findById 找得到与找不到', async () => {
    const log = new UndoLog(tmpDir)
    const r = await log.append({ original_command: 'y', reverse: { command: 'Y', preview_description: '' }, actor: 'h', snapshot: null })
    expect((await log.findById(r.id))?.original_command).toBe('y')
    expect(await log.findById('undo-bad-xxxx')).toBeNull()
  })

  it('敏感字段被 mask 后写入', async () => {
    const log = new UndoLog(tmpDir)
    await log.append({
      original_command: 'provider add --apikey sk-proj-abcdefghij',
      reverse: { command: 'provider delete x', preview_description: '' },
      actor: 'h', snapshot: null,
    })
    const items = await log.list()
    expect(items[0]!.original_command).not.toContain('sk-proj-abcdefghij')
    expect(items[0]!.original_command).toContain('--apikey ')
  })
})
