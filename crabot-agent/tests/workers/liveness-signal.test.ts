import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter'
import { BuiltinWorkerAdapter } from '../../src/workers/builtin/adapter'
import type { IncarnationHandle, WorkerAdapter } from '../../src/workers/types'

/**
 * `lastActivityAt` 是任务/执行进展信号,不是 pane 的任意字节活动。
 * CLI 的 output 可能只因 TUI 的 Auto-updating/spinner 重绘而增长;那不能掩盖停摆。
 */
describe('lastActivityAt(活性信号,adapter 层边界)', () => {
  let dataDir: string
  let workspaceRoot: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'liveness-signal-'))
    workspaceRoot = path.join(dataDir, 'workspace')
    await fs.mkdir(workspaceRoot, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  function handle(workerId: string, impl: IncarnationHandle['impl'], sessionRef: string): IncarnationHandle {
    return { worker_id: workerId, seq: 1, impl, session_ref: sessionRef }
  }

  async function writeMeta(workerId: string, meta: Record<string, unknown>, mtime: number): Promise<string> {
    const dir = path.join(dataDir, workerId)
    const metaPath = path.join(dir, 'meta-1.json')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(metaPath, JSON.stringify(meta), 'utf-8')
    await fs.utimes(metaPath, new Date(mtime), new Date(mtime))
    return metaPath
  }

  async function replaceWithBrokenSymlink(filePath: string): Promise<void> {
    await fs.rm(filePath)
    await fs.symlink(filePath, filePath)
  }

  async function seedCliSignal(
    impl: IncarnationHandle['impl'],
    make: (workerId: string, sessionId: string) => Promise<{ adapter: WorkerAdapter; handle: IncarnationHandle; nativePath: string }>,
    suffix: string,
  ): Promise<{ adapter: WorkerAdapter; h: IncarnationHandle; metaPath: string; nativePath: string; metaAt: number }> {
    const workerId = `w-${impl}-${suffix}`
    const sessionId = '33333333-3333-4333-8333-333333333333'
    const metaAt = Date.parse('2026-08-05T00:00:00.000Z')
    const { adapter, handle: h, nativePath } = await make(workerId, sessionId)
    const metaPath = await writeMeta(workerId, {
      seq: 1,
      state: 'running',
      session_id: sessionId,
      workspace_root: workspaceRoot,
      ...(impl === 'codex' ? { session_discovery: 'discovered' } : {}),
    }, metaAt)
    return { adapter, h, metaPath, nativePath, metaAt }
  }

  const cases: Array<[
    IncarnationHandle['impl'],
    (workerId: string, sessionId: string) => Promise<{ adapter: WorkerAdapter; handle: IncarnationHandle; nativePath: string }>,
  ]> = [
    [
      'claude-code',
      async (workerId, sessionId) => {
        const projectsDir = path.join(dataDir, 'claude-projects')
        const slug = workspaceRoot.replace(/[/.]/g, '-')
        const nativePath = path.join(projectsDir, slug, `${sessionId}.jsonl`)
        await fs.mkdir(path.dirname(nativePath), { recursive: true })
        await fs.writeFile(nativePath, '{}\n', 'utf-8')
        return {
          adapter: new ClaudeCodeAdapter({ dataDir, claudeProjectsDir: projectsDir }),
          handle: handle(workerId, 'claude-code', sessionId),
          nativePath,
        }
      },
    ],
    [
      'codex',
      async (workerId, sessionId) => {
        const nativePath = path.join(workspaceRoot, '.codex', 'sessions', '2026', '08', '06', `rollout-2026-08-06T00-00-00-${sessionId}.jsonl`)
        await fs.mkdir(path.dirname(nativePath), { recursive: true })
        await fs.writeFile(nativePath, JSON.stringify({ type: 'session_meta', payload: { session_id: sessionId } }) + '\n', 'utf-8')
        return {
          adapter: new CodexWorkerAdapter({ dataDir }),
          handle: handle(workerId, 'codex', sessionId),
          nativePath,
        }
      },
    ],
  ]

  it.each(cases)('%s:取 meta 与原生记录的最新 mtime,忽略持续刷新的 pane output', async (impl, make) => {
    const workerId = `w-${impl}-activity`
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const metaAt = Date.parse('2026-08-05T00:00:00.000Z')
    const nativeAt = metaAt + 60_000
    const outputAt = nativeAt + 24 * 60 * 60_000
    const { adapter, handle: h, nativePath } = await make(workerId, sessionId)

    await writeMeta(workerId, {
      seq: 1,
      state: 'running',
      session_id: sessionId,
      workspace_root: workspaceRoot,
      ...(impl === 'codex' ? { session_discovery: 'discovered' } : {}),
    }, metaAt)
    await fs.utimes(nativePath, new Date(nativeAt), new Date(nativeAt))

    const outputPath = path.join(dataDir, workerId, 'output-1.log')
    await fs.writeFile(outputPath, 'Auto-updating…', 'utf-8')
    await fs.utimes(outputPath, new Date(outputAt), new Date(outputAt))

    expect(await adapter.lastActivityAt!(h)).toBe(nativeAt)
  })

  it.each(cases)('%s:原生记录缺失时回退 meta mtime,而非 output mtime', async (impl, make) => {
    const workerId = `w-${impl}-fallback`
    const sessionId = '22222222-2222-4222-8222-222222222222'
    const metaAt = Date.parse('2026-08-05T00:00:00.000Z')
    const outputAt = metaAt + 24 * 60 * 60_000
    const { adapter, handle: h, nativePath } = await make(workerId, sessionId)

    await writeMeta(workerId, {
      seq: 1,
      state: 'running',
      session_id: sessionId,
      workspace_root: workspaceRoot,
      ...(impl === 'codex' ? { session_discovery: 'discovered' } : {}),
    }, metaAt)
    await fs.rm(nativePath)
    const outputPath = path.join(dataDir, workerId, 'output-1.log')
    await fs.writeFile(outputPath, 'Auto-updating…', 'utf-8')
    await fs.utimes(outputPath, new Date(outputAt), new Date(outputAt))

    expect(await adapter.lastActivityAt!(h)).toBe(metaAt)
  })

  it.each(cases)('%s:原生记录 stat 非 ENOENT 失败时告警并回退 meta', async (impl, make) => {
    const { adapter, h, nativePath, metaAt } = await seedCliSignal(impl, make, 'native-error')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await replaceWithBrokenSymlink(nativePath)

    expect(await adapter.lastActivityAt!(h)).toBe(metaAt)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`worker liveness] stat failed for ${h.worker_id}#${h.seq} at ${nativePath}`),
      expect.anything(),
    )
  })

  it.each(cases)('%s:meta 不可读且无法定位原生记录时告警并返回 undefined', async (impl, make) => {
    const { adapter, h, metaPath } = await seedCliSignal(impl, make, 'all-errors')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await replaceWithBrokenSymlink(metaPath)

    expect(await adapter.lastActivityAt!(h)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`worker liveness] stat failed for ${h.worker_id}#${h.seq} at ${metaPath}`),
      expect.anything(),
    )
  })

  it('codex:rollout 目录非正常不可读时告警并保留 meta 基线', async () => {
    const impl = 'codex' as const
    const make = cases.find(([id]) => id === impl)![1]
    const { adapter, h, metaAt } = await seedCliSignal(impl, make, 'discovery-error')
    const sessionsDir = path.join(workspaceRoot, '.codex', 'sessions')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await fs.rm(sessionsDir, { recursive: true })
    await fs.symlink(sessionsDir, sessionsDir)

    expect(await adapter.lastActivityAt!(h)).toBe(metaAt)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`worker liveness] rollout discovery failed for ${h.worker_id}#${h.seq} at ${sessionsDir}`),
      expect.anything(),
    )
  })

  it('codex:候选 rollout 内容非正常不可读时告警并保留 meta 基线', async () => {
    const impl = 'codex' as const
    const make = cases.find(([id]) => id === impl)![1]
    const { adapter, h, nativePath, metaAt } = await seedCliSignal(impl, make, 'candidate-read-error')
    const sessionsDir = path.join(workspaceRoot, '.codex', 'sessions')
    const candidateId = '44444444-4444-4444-8444-444444444444'
    const candidatePath = path.join(path.dirname(nativePath), `rollout-2026-08-06T00-00-01-${candidateId}.jsonl`)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await fs.rm(nativePath)
    await fs.symlink(candidatePath, candidatePath)

    expect(await adapter.lastActivityAt!(h)).toBe(metaAt)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`worker liveness] rollout discovery failed for ${h.worker_id}#${h.seq} at ${sessionsDir}`),
      expect.anything(),
    )
  })

  it('builtin 实现该方法:无常驻化身时回退 meta mtime,不借 output 当活性', async () => {
    const workerId = 'w-builtin-fallback'
    const metaAt = Date.parse('2026-08-05T00:00:00.000Z')
    const outputAt = metaAt + 24 * 60 * 60_000
    await writeMeta(workerId, { seq: 1, state: 'running', tip_node_id: 'tip-1' }, metaAt)
    const outputPath = path.join(dataDir, workerId, 'output-1.log')
    await fs.writeFile(outputPath, 'assistant text', 'utf-8')
    await fs.utimes(outputPath, new Date(outputAt), new Date(outputAt))

    const adapter: WorkerAdapter = new BuiltinWorkerAdapter({ dataDir })
    expect(await adapter.lastActivityAt!(handle(workerId, 'builtin', 'tip-1'))).toBe(metaAt)
  })

  it('没有 meta 或原生进展记录时返回 undefined', async () => {
    const adapter = new ClaudeCodeAdapter({ dataDir, claudeProjectsDir: path.join(dataDir, 'claude-projects') })
    expect(await adapter.lastActivityAt!(handle('w-nolog', 'claude-code', 'unused'))).toBeUndefined()
  })
})
