import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { finishResourceScope, scopedArgv, type ToolResourceScope } from '../../src/engine/tool-resource-scope'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })) })

// Protocol fixtures are not evidence of kernel enforcement; the separate Linux acceptance tests that.
function fixture(events = 'oom_kill 0\noom 0\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-scope-')); dirs.push(root)
  const id = randomUUID(), dir = path.join(root, id); fs.mkdirSync(dir)
  for (const [name, text] of Object.entries({ 'cgroup.kill': '', 'cgroup.events': 'populated 0\n', 'memory.events': events, 'pids.events': 'max 0\n', 'memory.peak': '1000' })) fs.writeFileSync(path.join(dir, name), text)
  const r = fs.statSync(root), d = fs.statSync(dir)
  const scope: ToolResourceScope = { version: 1, id, root, root_inode: r.ino, inode: d.ino, device: d.dev, memory_bytes: 1024, tasks: 512, cpu_quota: 2 }
  vi.spyOn(fs, 'statfsSync').mockReturnValue({ type: 0x63677270 } as any)
  vi.spyOn(fs, 'rmdirSync').mockImplementation(p => fs.rmSync(p, { recursive: true }))
  return { root, dir, scope }
}
it('refuses user code when the trusted launcher cannot join the group', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-gate-')); dirs.push(root)
  const marker = path.join(root, 'executed')
  const [file, ...args] = scopedArgv({ root, id: randomUUID() } as ToolResourceScope,
    [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`])
  const result = spawnSync(file, args)
  expect(result.status).toBe(125); expect(fs.existsSync(marker)).toBe(false)
})
it('classifies from kernel events, preserves raw exit/signal and partial side effects, then removes only an empty group', async () => {
  const { root, dir, scope } = fixture('oom 1\noom_kill 1\n')
  fs.writeFileSync(path.join(root, 'side-effect'), 'kept')
  const result = await finishResourceScope(scope, null, 'SIGKILL')
  expect(result).toMatchObject({ status: 'limit', exit_code: null, signal: 'SIGKILL', cleanup: 'complete', memory_peak_bytes: 1000 })
  expect(result.message).toContain('partial side effects')
  expect(fs.existsSync(dir)).toBe(false); expect(fs.readFileSync(path.join(root, 'side-effect'), 'utf8')).toBe('kept')
})
it('never equates SIGKILL with OOM without kernel evidence', async () => {
  const { scope } = fixture()
  expect(await finishResourceScope(scope, null, 'SIGKILL')).toMatchObject({ status: 'ok', memory_events: { oom_kill: 0 }, signal: 'SIGKILL' })
})
it('reports task exhaustion even if the shell later exits zero', async () => {
  const { scope, dir } = fixture(); fs.writeFileSync(path.join(dir, 'pids.events'), 'max 2\n')
  expect(await finishResourceScope(scope, 0, null)).toMatchObject({ status: 'limit', exit_code: 0, pids_events: { max: 2 } })
})
it('rejects changed persistent identities before killing anything', async () => {
  const { dir, scope } = fixture(); scope.inode++
  expect(await finishResourceScope(scope, null, null)).toMatchObject({ status: 'unknown', cleanup: 'unknown' })
  expect(fs.readFileSync(path.join(dir, 'cgroup.kill'), 'utf8')).toBe('')
})
it('does not report an unempty group as cleaned up', async () => {
  const { dir, scope } = fixture(); fs.writeFileSync(path.join(dir, 'cgroup.events'), 'populated 1\n')
  expect(await finishResourceScope(scope, null, null)).toMatchObject({ status: 'unknown', cleanup: 'unknown' })
  expect(fs.existsSync(dir)).toBe(true)
})

it('does not execute user code if the entry receipt channel is missing, even after joining', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-gate-')); dirs.push(root)
  const id = randomUUID(), dir = path.join(root, id); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'cgroup.procs'), '')
  const marker = path.join(root, 'executed')
  const [file, ...args] = scopedArgv({ root, id } as ToolResourceScope,
    [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`])
  const result = spawnSync(file, args)
  expect(result.status).toBe(125); expect(fs.existsSync(marker)).toBe(false)
})
