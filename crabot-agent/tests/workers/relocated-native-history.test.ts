import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter.js'
import type { IncarnationHandle } from '../../src/workers/types.js'

const session = '11111111-1111-4111-8111-111111111111'
const time = '2026-10-21T00:00:00.000Z'
for (const impl of ['claude-code', 'codex'] as const) describe('relocated native parent history: ' + impl, () => {
  let root: string, before: string, after: string, data: string, projects: string, metaFile: string, source: string
  let handle: IncarnationHandle, adapter: ClaudeCodeAdapter | CodexWorkerAdapter, tmux: any, proof: any, originalMeta: string, originalSource: string
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'relocated-native-history-')))
    before = path.join(root, 'before'); after = path.join(root, 'after'); data = path.join(root, 'private'); projects = path.join(root, 'claude-projects')
    handle = { worker_id: 'history-native-worker', incarnation_id: 'history-native-incarnation', seq: 1, impl, session_ref: session }
    metaFile = path.join(data, handle.worker_id, 'meta-1.json')
    originalMeta = JSON.stringify({ workspace_root: before, session_id: session, state: 'exited', ended_reason: 'killed', session_discovery: 'discovered' })
    await fs.mkdir(path.dirname(metaFile), { recursive: true }); await fs.writeFile(metaFile, originalMeta)
    await fs.writeFile(path.join(path.dirname(metaFile), 'terminal-final-1.json'), JSON.stringify({ text: 'retained terminal', captured_at: time }))
    originalSource = JSON.stringify(impl === 'claude-code'
      ? { type: 'assistant', timestamp: time, message: { role: 'assistant', content: [{ type: 'text', text: 'retained native history' }] } }
      : { type: 'response_item', timestamp: time, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'retained native history' }] } }) + '\n'
    source = impl === 'claude-code' ? path.join(projects, before.replace(/[^a-zA-Z0-9]/g, '-'), session + '.jsonl')
      : path.join(before, '.codex/sessions/2026/10/21', 'rollout-2026-10-21T00-00-00-' + session + '.jsonl')
    await fs.mkdir(before, { recursive: true }); await fs.mkdir(path.dirname(source), { recursive: true }); await fs.writeFile(source, originalSource)
    await fs.rename(before, after)
    if (impl === 'codex') source = path.join(after, path.relative(before, source))
    tmux = { isAlive: vi.fn(async () => { throw new Error('history must not probe tmux') }), killSession: vi.fn(async () => { throw new Error('history must not kill tmux') }) }
    proof = { before_root: before, after_root: after, verify: vi.fn(async () => undefined) }
    const common = { dataDir: data, tmux, readWorkspaceHistory: vi.fn(async () => proof) }
    adapter = impl === 'claude-code' ? new ClaudeCodeAdapter({ ...common, claudeProjectsDir: projects, claudeConfigPath: path.join(root, 'never-configure.json') })
      : new CodexWorkerAdapter({ ...common, codexHomeSource: path.join(root, 'never-auth') })
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })
  it('reads the original parent JSONL and retained final terminal without runtime reconstruction', async () => {
    const result = await adapter.readTrace(handle)
    expect(result.unavailableReason).toBeUndefined(); expect(result.events[0].summary).toContain('retained native history')
    expect(result.nextCursor).toEqual({ offset: 1 })
    expect((await adapter.readTrace(handle, result.nextCursor)).events).toEqual([])
    expect(await adapter.readTerminal(handle)).toEqual({ kind: 'final_terminal', text: 'retained terminal', captured_at: time })
    expect(tmux.isAlive).not.toHaveBeenCalled(); expect(tmux.killSession).not.toHaveBeenCalled()
    expect((adapter as any).runtimes.size).toBe(0)
    expect(await fs.readFile(metaFile, 'utf8')).toBe(originalMeta); expect(await fs.readFile(source, 'utf8')).toBe(originalSource)
    expect((await fs.readdir(path.dirname(metaFile))).sort()).toEqual(['meta-1.json', 'terminal-final-1.json'])
    expect(proof.verify).toHaveBeenCalled()
  })
  it('keeps a missing native source unavailable with its original cursor and never probes a CLI', async () => {
    await fs.unlink(source)
    const result = await adapter.readTrace(handle, { offset: 7 })
    expect(result.events).toEqual([]); expect(result.nextCursor).toEqual({ offset: 7 }); expect(result.unavailableReason).toBeTruthy()
    expect(tmux.isAlive).not.toHaveBeenCalled(); expect(await fs.readFile(metaFile, 'utf8')).toBe(originalMeta)
  })
  it('rejects original metadata changing after the actual native file opens', async () => {
    const open = fs.open; let changed = false
    vi.spyOn(fs, 'open').mockImplementation((async (file: any, ...args: any[]) => {
      const handle = await (open as any)(file, ...args)
      if (file === source && !changed) { changed = true; await fs.writeFile(metaFile, JSON.stringify({ ...JSON.parse(originalMeta), session_id: '22222222-2222-4222-8222-222222222222' })) }
      return handle
    }) as typeof fs.open)
    await expect(adapter.readTrace(handle)).rejects.toThrow()
    expect(changed).toBe(true); expect(tmux.isAlive).not.toHaveBeenCalled()
    expect(await fs.readFile(source, 'utf8')).toBe(originalSource)
  })
  it('retains ordinary runtime observation when no relocation proof is supplied', async () => {
    ;(adapter as any).deps.readWorkspaceHistory = async () => null
    tmux.isAlive.mockResolvedValue(false); tmux.killSession.mockResolvedValue(undefined)
    await adapter.readTrace(handle)
    expect(tmux.isAlive).toHaveBeenCalledOnce(); expect((adapter as any).runtimes.size).toBe(1)
  })
  if (impl === 'codex') {
    it('does not relocate a pre-existing private profile outside the original workspace', async () => {
      const home = path.join(root, 'private-profile'), file = path.join(home, 'sessions/2026/10/21', path.basename(source))
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, originalSource)
      const metadata = JSON.stringify({ ...JSON.parse(originalMeta), codex_home: home }); await fs.writeFile(metaFile, metadata)
      await fs.unlink(source)
      const result = await adapter.readTrace(handle)
      expect(result.events[0].summary).toContain('retained native history'); expect(tmux.isAlive).not.toHaveBeenCalled()
      expect(await fs.readFile(file, 'utf8')).toBe(originalSource); expect(await fs.readFile(metaFile, 'utf8')).toBe(metadata)
    })
    it('refuses a mapped sessions directory redirected outside the original incarnation', async () => {
      const sessions = path.join(after, '.codex/sessions'), retained = sessions + '-retained', outside = path.join(root, 'outside-sessions')
      await fs.rename(sessions, retained); await fs.mkdir(outside)
      const sentinel = path.join(outside, path.basename(source)); await fs.writeFile(sentinel, originalSource)
      await fs.symlink(outside, sessions, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(adapter.readTrace(handle)).rejects.toThrow()
      expect(tmux.isAlive).not.toHaveBeenCalled(); expect(await fs.readFile(sentinel, 'utf8')).toBe(originalSource)
    })
  }
  for (const damage of ['workspace', 'session']) it('rejects changed original native metadata: ' + damage, async () => {
    const changed = { ...JSON.parse(originalMeta), ...(damage === 'workspace' ? { workspace_root: root } : { session_id: '22222222-2222-4222-8222-222222222222' }) }
    await fs.writeFile(metaFile, JSON.stringify(changed))
    await expect(adapter.readTrace(handle)).rejects.toThrow()
    expect(tmux.isAlive).not.toHaveBeenCalled(); expect(await fs.readFile(source, 'utf8')).toBe(originalSource)
  })
})
