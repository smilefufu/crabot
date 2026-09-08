import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerHarness } from '../../../src/workers/harness/harness.js'
import { LedgerStore } from '../../../src/workers/harness/ledger-store.js'
import { WorkspaceManager } from '../../../src/workers/harness/workspace-manager.js'
import { WorkspaceGitInspector } from '../../../src/workers/harness/workspace-git-inspector.js'
import { BUILTIN_WORKER_PERMISSIONS } from '../../../src/workers/builtin/runtime.js'
import { buildWorkerTools } from '../../../src/manager/tools/worker-tools.js'
import { authorizeProjectRoot } from '../../../src/manager/tools/project-doc-tools.js'
import type { WorkerAdapter, WorkerImplId, SpawnSpec, IncarnationHandle, ForkOptions, ResumeOptions, IncarnationRef } from '../../../src/workers/types.js'
import type { HarnessEvent } from '../../../src/workers/harness/worker-events.js'

const exec = promisify(execFile)
const KEY = 'test::project-git'
let root: string
let workspace: string
let ledger: LedgerStore
let harness: WorkerHarness
let adapter: WorkerAdapter
let events: HarnessEvent[]
let seq: number

async function git(...args: string[]): Promise<string> {
  return (await exec('git', ['-C', workspace, ...args], { env: { ...process.env,
    GIT_AUTHOR_NAME: 'Harness Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Harness Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } })).stdout.trim()
}

function makeHarness(impl: WorkerImplId = 'builtin'): WorkerHarness {
  adapter = {
    implId: impl,
    provision: vi.fn(async () => { await fs.writeFile(path.join(workspace, 'provision.tmp'), 'generated') }),
    preflightProvision: vi.fn(async () => undefined),
    spawn: vi.fn(async (spec: SpawnSpec) => ({ worker_id: spec.worker_id, incarnation_id: spec.incarnation_id,
      seq: ++seq, impl, session_ref: 'native-session' })),
    resume: vi.fn(async (prev: IncarnationRef, _input: string, opts: ResumeOptions) => ({
      worker_id: prev.worker_id, incarnation_id: opts.incarnation_id, seq: ++seq, impl, session_ref: prev.session_ref,
    })),
    fork: vi.fn(async (prev: IncarnationRef, _input: string, opts: ForkOptions) => ({
      worker_id: prev.worker_id, incarnation_id: opts.incarnation_id, seq: ++seq, impl, session_ref: 'fork-session', query_id: opts.query_id,
    })),
    state: vi.fn(async () => 'running'),
    readTrace: vi.fn(async () => ({ events: [], nextCursor: { offset: 0 } })),
    capabilities: () => ({ fork: true, revive: true, goalMode: false, subagent: false, structuredTrace: true }),
  } as unknown as WorkerAdapter
  return new WorkerHarness({ adapters: new Map([[impl, adapter]]), defaultImpl: impl, ledger,
    workspaces: new WorkspaceManager(path.join(root, 'workspaces')), workersDir: path.join(root, 'workers'),
    now: () => new Date().toISOString(), onOperationNotification: async (_key, event) => { events.push(event) },
  })
}

async function spawn(fileIo = true) {
  return harness.spawnWorker({ managerKey: KEY, title: 'project task', prompt: 'inspect project', workspace,
    origin: { trigger_type: 'message', creator_friend_id: 'owner' }, report_to: { channel_id: 'test', session_id: 'project-git' },
    principal_permissions: { ...BUILTIN_WORKER_PERMISSIONS, tool_access: { ...BUILTIN_WORKER_PERMISSIONS.tool_access, file_io: fileIo } },
  })
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'harness-workspace-git-')))
  workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  ledger = new LedgerStore(path.join(root, 'ledgers'))
  seq = 0
  events = []
  harness = makeHarness()
})

afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })

describe('Harness workspace Git contract', () => {
  it.each(['builtin', 'claude-code', 'codex'] as const)('captures %s baseline before links/provision, keeps it after refresh and delivers one turn summary', async (impl) => {
    harness = makeHarness(impl)
    await git('init', '-b', 'main')
    await git('config', 'commit.gpgsign', 'false')
    await git('config', 'core.hooksPath', path.join(root, 'no-hooks'))
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), '# Rules\n')
    await git('add', 'AGENTS.md')
    await git('commit', '-m', 'baseline')
    await fs.writeFile(path.join(workspace, 'existing.txt'), 'other work')
    await git('add', 'existing.txt')
    const worker = await spawn()
    const incarnation = worker.incarnations[0]
    if (incarnation.impl === 'legacy') throw new Error('unexpected legacy')
    expect(incarnation.workspace_git?.state).toMatchObject({ dirty: true, change_count: 1,
      changes: [{ path: 'existing.txt', index_status: 'A', worktree_status: '.' }] })
    const spec = vi.mocked(adapter.spawn).mock.calls[0][0]
    expect(spec.prompt).toContain(JSON.stringify(incarnation.workspace_git))
    expect(spec.workspace_git).toMatchObject({ incarnation_id: incarnation.incarnation_id, baseline: incarnation.workspace_git })
    const indexBefore = await fs.readFile(path.join(workspace, '.git/index'))
    const inspected = await harness.inspectWorkspaceGit(worker.worker_id, async (actual) => { expect(actual).toBe(workspace); return actual })
    expect(inspected.git.current.state).toMatchObject({ dirty: true, change_count: 3 })
    expect(inspected.git.baseline).toEqual(incarnation.workspace_git)
    expect(await fs.readFile(path.join(workspace, '.git/index'))).toEqual(indexBefore)
    const handle: IncarnationHandle = { worker_id: worker.worker_id, incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq, impl, session_ref: incarnation.session_ref }
    harness.handleStateChange(handle, 'idle', { completionSource: impl === 'builtin' ? 'builtin_end_turn' : impl === 'codex' ? 'codex_turn_complete' : 'claude_stop', lastText: 'done' })
    await vi.waitFor(() => expect(events.filter((event) => event.kind === 'turn_completed')).toHaveLength(1))
    const turn = await harness.getWorkerTurn(worker.worker_id)
    expect(turn?.workspace_git).toMatchObject({ baseline: incarnation.workspace_git, comparison: 'same_head' })
    expect(turn?.disposition).toEqual({ status: 'pending' })
    const event = events.find((item) => item.kind === 'turn_completed')!
    expect(event.detail).toMatchObject({ workspace_git: { status: 'repository', comparison: 'same_head', change_count: 3 } })
    expect(JSON.stringify(event.detail)).not.toContain('existing.txt')
    const after = (await ledger.findWorker(worker.worker_id))!.worker
    expect(after.origin).toEqual(worker.origin)
    expect(after.report_to).toEqual(worker.report_to)
    expect(after.incarnations[0]).toMatchObject({ workspace_git: incarnation.workspace_git })
  })

  it('denies automatic Git reads without file_io, including turn completion; explicit denial calls no inspector', async () => {
    const inspect = vi.spyOn(WorkspaceGitInspector.prototype, 'inspect')
    const worker = await spawn(false)
    const incarnation = worker.incarnations[0]
    expect(incarnation).toMatchObject({ workspace_git: { state: { status: 'error', reason_code: 'access_denied' } } })
    await expect(harness.inspectWorkspaceGit(worker.worker_id, async (actual) => actual)).rejects.toThrow('file_io')
    harness.handleStateChange({ worker_id: worker.worker_id, incarnation_id: incarnation.incarnation_id, seq: 1,
      impl: 'builtin', session_ref: 'native-session' }, 'idle', { completionSource: 'builtin_end_turn' })
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'turn_completed')).toBe(true))
    expect((await harness.getWorkerTurn(worker.worker_id))?.workspace_git?.current.state).toMatchObject({ reason_code: 'access_denied' })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('fork/resume obtain new baselines while an Agent restart preserves the old baseline', async () => {
    const worker = await spawn()
    const initial = worker.incarnations[0]
    await git('init', '-b', 'main')
    harness = makeHarness()
    expect((await harness.inspectWorkspaceGit(worker.worker_id, async (actual) => actual)).git.comparison).toBe('repository_appeared')
    await harness.queryWorker(worker.worker_id, 'side question')
    const forkOpts = vi.mocked(adapter.fork).mock.calls[0][2]
    expect(forkOpts.workspace_git).toMatchObject({ baseline: { state: { status: 'repository', head: null } } })
    expect(forkOpts.workspace_git?.incarnation_id).not.toBe(initial.incarnation_id)
    await ledger.upsertWorker(KEY, worker.worker_id, (value) => ({ ...value!, incarnations: value!.incarnations.map((inc) =>
      inc.incarnation_id === initial.incarnation_id ? { ...inc, state: 'exited', ended_reason: 'completed', ended_at: new Date().toISOString() } : inc) }))
    await harness.sendToWorker(worker.worker_id, 'continue')
    const resumed = vi.mocked(adapter.resume).mock.calls[0]
    expect(resumed[1]).toContain('<workspace-git-observation>')
    expect(resumed[2]?.workspace_git?.incarnation_id).not.toBe(initial.incarnation_id)
    expect(resumed[2]?.workspace_git?.baseline?.state.status).toBe('repository')
    expect((await ledger.findWorker(worker.worker_id))!.worker.incarnations[0]).toMatchObject({ ...initial, state: 'exited' })
  })

  it('historic missing baseline is unavailable and Manager uses episode project-read authorization', async () => {
    const worker = await spawn()
    await ledger.upsertWorker(KEY, worker.worker_id, (value) => ({ ...value!, incarnations: value!.incarnations.map((inc) => {
      const { workspace_git: _git, ...rest } = inc as typeof inc & { workspace_git?: unknown }
      return rest
    }) }))
    expect((await harness.inspectWorkspaceGit(worker.worker_id, async (actual) => actual)).git).toMatchObject({ comparison: 'unavailable', comparison_reason: 'baseline_missing' })
    const inspect = vi.spyOn(WorkspaceGitInspector.prototype, 'inspect')
    const denied = { ...BUILTIN_WORKER_PERMISSIONS, tool_access: { ...BUILTIN_WORKER_PERMISSIONS.tool_access, file_io: false } }
    const projectDeps = { ledger, managerKey: KEY, readWorkerContext: async () => undefined,
      wakeEvent: { kind: 'human_messages' as const, messages: [], principalPermissions: denied } }
    const tools = buildWorkerTools({ harness, context: () => ({ managerKey: KEY, reportTo: worker.report_to }),
      authorizeProjectRead: (workspaceRoot) => authorizeProjectRoot(projectDeps, workspaceRoot, false) })
    const tool = tools.find((item) => item.name === 'inspect_workspace_git')!
    expect((await tool.call({ worker_id: worker.worker_id }, {} as never)).isError).toBe(true)
    expect((await tool.call({ worker_id: worker.worker_id, path: '/' }, {} as never)).isError).toBe(true)
    for (const invalid of [null, [], 'worker-id']) expect((await tool.call(invalid as never, {} as never)).isError).toBe(true)
    expect(inspect).not.toHaveBeenCalled()
    projectDeps.wakeEvent.principalPermissions = { ...BUILTIN_WORKER_PERMISSIONS,
      storage: { workspace_path: path.join(root, 'other'), access: 'readwrite' } } as typeof denied
    await fs.mkdir(path.join(root, 'other'))
    expect((await tool.call({ worker_id: worker.worker_id }, {} as never)).isError).toBe(true)
    expect(inspect).not.toHaveBeenCalled()
    projectDeps.wakeEvent.principalPermissions = BUILTIN_WORKER_PERMISSIONS
    expect((await tool.call({ worker_id: worker.worker_id }, {} as never)).isError).toBe(false)
    expect(inspect).toHaveBeenCalledTimes(1)
  })
})
