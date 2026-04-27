import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UndoLog } from '../undo-log.js'

let tmpDir: string
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'crabot-undo-cmd-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('UndoLog 与 undo 命令交互', () => {
  it('list 后 removeById 后 list 为空', async () => {
    const log = new UndoLog(tmpDir)
    const r = await log.append({
      original_command: 'provider add --name test --apikey ***',
      reverse: { command: 'provider delete a3c1', preview_description: 'delete provider test' },
      actor: 'agent-1',
      snapshot: null,
    })
    expect(await log.list()).toHaveLength(1)
    await log.removeById(r.id)
    expect(await log.list()).toHaveLength(0)
  })

  it('list 返回最新的在前（倒序）', async () => {
    const log = new UndoLog(tmpDir)
    const e1 = await log.append({
      original_command: 'mcp add --name first',
      reverse: { command: 'mcp delete id1', preview_description: 'delete mcp first' },
      actor: 'agent-1',
      snapshot: null,
    })
    const e2 = await log.append({
      original_command: 'mcp add --name second',
      reverse: { command: 'mcp delete id2', preview_description: 'delete mcp second' },
      actor: 'agent-1',
      snapshot: null,
    })
    const items = await log.list()
    expect(items).toHaveLength(2)
    expect(items[0]!.id).toBe(e2.id)
    expect(items[1]!.id).toBe(e1.id)
  })

  it('findById 返回正确条目', async () => {
    const log = new UndoLog(tmpDir)
    const entry = await log.append({
      original_command: 'friend add --name Bob',
      reverse: { command: 'friend delete bob-id', preview_description: 'delete friend Bob' },
      actor: 'agent-2',
      snapshot: null,
    })
    const found = await log.findById(entry.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(entry.id)
    expect(found!.actor).toBe('agent-2')
  })

  it('findById 不存在时返回 null', async () => {
    const log = new UndoLog(tmpDir)
    const found = await log.findById('undo-9999-xxxx')
    expect(found).toBeNull()
  })

  it('条目 snapshot 保存并可读', async () => {
    const log = new UndoLog(tmpDir)
    const snapshot = { name: 'old-name', config: { retries: 3 } }
    const entry = await log.append({
      original_command: 'config set --name old-name',
      reverse: { command: 'config restore-snapshot', preview_description: 'restore global config' },
      actor: 'agent-1',
      snapshot,
    })
    const found = await log.findById(entry.id)
    expect(found!.snapshot).toEqual(snapshot)
  })

  it('reverse.command 包含 preview_description', async () => {
    const log = new UndoLog(tmpDir)
    const entry = await log.append({
      original_command: 'schedule enable my-sched',
      reverse: { command: 'schedule pause my-sched', preview_description: 'pause schedule my-sched' },
      actor: 'agent-3',
      snapshot: null,
    })
    expect(entry.reverse.preview_description).toBe('pause schedule my-sched')
    expect(entry.reverse.command).toBe('schedule pause my-sched')
  })
})
