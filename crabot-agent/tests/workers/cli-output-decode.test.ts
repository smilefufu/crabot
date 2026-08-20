import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter.js'
import {
  readFinalTerminalSnapshot,
  terminalSnapshotPath,
  writeFinalTerminalSnapshot,
} from '../../src/workers/tmux/terminal-snapshot.js'

describe('终端最终画面快照', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-snapshot-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('只保留同一化身最后一次非空画面', async () => {
    await writeFinalTerminalSnapshot(dir, 1, '第一帧\n\n', '2026-08-19T00:00:00.000Z')
    await writeFinalTerminalSnapshot(dir, 1, '最终画面\n', '2026-08-19T00:01:00.000Z')

    await expect(readFinalTerminalSnapshot(dir, 1)).resolves.toEqual({
      text: '最终画面',
      captured_at: '2026-08-19T00:01:00.000Z',
    })
    await expect(fs.readdir(dir)).resolves.toEqual(['terminal-final-1.json'])
  })

  it('空画面不会抹掉已有的最终快照', async () => {
    await writeFinalTerminalSnapshot(dir, 2, '仍应保留', '2026-08-19T00:00:00.000Z')
    await expect(writeFinalTerminalSnapshot(dir, 2, '   \n\n')).resolves.toBeUndefined()
    await expect(readFinalTerminalSnapshot(dir, 2)).resolves.toEqual({
      text: '仍应保留',
      captured_at: '2026-08-19T00:00:00.000Z',
    })
  })

  it('快照是结构化终端画面，不保留 raw pipe-pane 字节流', async () => {
    await writeFinalTerminalSnapshot(dir, 3, 'Codex 已就绪', '2026-08-19T00:00:00.000Z')
    const raw = await fs.readFile(terminalSnapshotPath(dir, 3), 'utf-8')
    expect(raw).toBe('{"text":"Codex 已就绪","captured_at":"2026-08-19T00:00:00.000Z"}\n')
    expect(raw).not.toContain('\u001b')
  })

  it('dead pane 的 tmux 状态提示不会覆盖 cc/codex 已有最终画面', async () => {
    for (const Adapter of [ClaudeCodeAdapter, CodexWorkerAdapter]) {
      const adapter = Object.create(Adapter.prototype) as {
        tmux: { capturePane: () => Promise<{ text: string; dead: boolean }> }
        capture: (runtime: { sessionName: string; dir: string; seq: number; worker_id: string }) => Promise<unknown>
      }
      adapter.tmux = {
        capturePane: async () => ({ text: 'Pane is dead (status 0)', dead: true }),
      }
      await writeFinalTerminalSnapshot(dir, 4, '最后有效画面', '2026-08-19T00:00:00.000Z')

      await adapter.capture({ sessionName: 'dead-pane', dir, seq: 4, worker_id: 'w-1' })

      await expect(readFinalTerminalSnapshot(dir, 4)).resolves.toEqual({
        text: '最后有效画面',
        captured_at: '2026-08-19T00:00:00.000Z',
      })
    }
  })
})
