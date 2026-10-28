import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCrabMemoryServer } from '../../src/mcp/crab-memory.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import { buildManagerStack } from '../../src/manager/bootstrap.js'
import { checkProjectFileAccess, authorizeProjectRoot } from '../../src/manager/tools/project-doc-tools.js'
import { checkFileAccess } from '../../src/permissions/tool-authorization.js'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { WorkerHarness } from '../../src/workers/harness/harness.js'
import { LedgerStore } from '../../src/workers/harness/ledger-store.js'
import { WorkerContextStore } from '../../src/workers/harness/context-store.js'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager.js'
import { BUILTIN_WORKER_PERMISSIONS } from '../../src/workers/builtin/runtime.js'
import { assertExecutionPolicy } from '../../src/workers/execution-policy.js'
import type { SpawnSpec, WorkerAdapter } from '../../src/workers/types.js'

const key = 'fixture::session' as const
const principal = () => ({ ...BUILTIN_WORKER_PERMISSIONS, storage: null })
let root: string, ledger: LedgerStore, contexts: WorkerContextStore, workspaces: WorkspaceManager
let harness: WorkerHarness, adapter: WorkerAdapter, lastSpec: SpawnSpec
const params = () => ({ managerKey: key, title: 'task result', prompt: 'make result',
  origin: { trigger_type: 'message' as const, creator_friend_id: 'owner' },
  report_to: { channel_id: 'fixture', session_id: 'session' }, principal_permissions: principal() })
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-host-')))
  ledger = new LedgerStore(path.join(root, 'ledgers'))
  contexts = new WorkerContextStore(path.join(root, 'workers'))
  await fs.mkdir(path.join(root, 'data'), { mode: 0o700 })
  workspaces = new WorkspaceManager(path.join(root, 'data', 'workspaces'), path.join(root, 'data'))
  adapter = { implId: 'builtin', provision: vi.fn(async () => undefined),
    spawn: vi.fn(async (spec: SpawnSpec) => { lastSpec = spec; return { worker_id: spec.worker_id,
      incarnation_id: spec.incarnation_id, seq: 1, impl: 'builtin', session_ref: 'fixture' } }),
    state: async () => 'running', dispose: async () => undefined,
  } as unknown as WorkerAdapter
  harness = new WorkerHarness({ adapters: new Map([['builtin', adapter]]), defaultImpl: 'builtin',
    ledger, workspaces, workersDir: path.join(root, 'workers'), now: () => new Date().toISOString(), onEvent() {} })
})
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })
function projectDeps() {
  return { ledger, managerKey: key, managerPrincipalPermissions: principal(), readWorkerContext: (id: string) => contexts.read(id),
    managedWorkspace: (id: string, workspace: string) => harness.managedWorkspaceScope(id, workspace) }
}
describe('host task ownership and compatibility', () => {
  it('reads valid existing snapshots after restart without rewriting ownership or granting Manager writes', async () => {
    const worker = await harness.spawnWorker(params()), workspace = worker.incarnations[0].workspace
    const file = path.join(workspace, 'deliverables', 'result.html')
    await fs.mkdir(path.dirname(file)); await fs.writeFile(file, 'result')
    const saved = await fs.readFile(path.join(root, 'workers', worker.worker_id, 'context.json'), 'utf8')
    const restarted = new WorkerHarness({ adapters: new Map(), defaultImpl: 'builtin', ledger: new LedgerStore(path.join(root, 'ledgers')),
      workspaces, workersDir: path.join(root, 'workers'), now: () => new Date().toISOString(), onEvent() {} })
    expect((await checkFileAccess(principal(), file, '/', false, restarted.managedWorkspaceScope(worker.worker_id, workspace))).allowed).toBe(true)
    expect((await checkProjectFileAccess(projectDeps(), file)).allowed).toBe(true)
    expect(await authorizeProjectRoot(projectDeps(), workspace, false)).toBe(workspace)
    expect((await checkProjectFileAccess(projectDeps(), file, true)).allowed).toBe(false)
    expect((await checkProjectFileAccess({ ...projectDeps(), managerKey: 'fixture::other' }, file)).allowed).toBe(false)
    expect(await fs.readFile(path.join(root, 'workers', worker.worker_id, 'context.json'), 'utf8')).toBe(saved)
    expect((await contexts.read(worker.worker_id))?.principal_permissions?.storage).toBeNull()
    expect((await ledger.findWorker(worker.worker_id))?.worker.origin).toEqual(worker.origin)
    expect((await ledger.findWorker(worker.worker_id))?.worker.report_to).toEqual(worker.report_to)
  })
  it.each(['missing', 'manager', 'creator', 'workspace'] as const)('denies automatic scope with %s ownership evidence', async fault => {
    const worker = await harness.spawnWorker(params()), workspace = worker.incarnations[0].workspace
    const context = await contexts.read(worker.worker_id)
    if (fault === 'missing') await contexts.write(worker.worker_id, { ...context, principal_permissions: undefined })
    if (fault === 'manager') await contexts.write(worker.worker_id, { ...context, manager_key: 'fixture::other' })
    if (fault === 'creator') await contexts.write(worker.worker_id, { ...context, creator_friend_id: 'another' })
    const claimed = fault === 'workspace' ? (await workspaces.resolve('w-other')).root : workspace
    expect((await checkFileAccess(principal(), workspace, '/', false, harness.managedWorkspaceScope(worker.worker_id, claimed))).allowed).toBe(false)
    expect((await checkProjectFileAccess(projectDeps(), claimed)).allowed).toBe(false)
    expect((await checkFileAccess(principal(), workspace, '/', false, harness.managedWorkspaceScope('unknown', workspace))).allowed).toBe(false)
  })
  it('keeps file_io=false tasks running without reading workspace rules or Git', async () => {
    const external = path.join(root, 'external'); await fs.mkdir(external)
    await fs.writeFile(path.join(external, 'AGENTS.md'), 'private rules')
    const disabled = principal(); disabled.tool_access = { ...disabled.tool_access, file_io: false }
    const worker = await harness.spawnWorker({ ...params(), workspace: external, principal_permissions: disabled })
    expect(worker.incarnations[0].workspace_git?.state).toMatchObject({ reason_code: 'access_denied' })
    expect(lastSpec.workspace_instructions).toMatchObject({ snapshot: { source: 'absent' } })
    expect(lastSpec.workspace_instructions?.text).toBeUndefined()
    expect(await fs.readdir(external)).toEqual(['AGENTS.md'])
  })
  it('rejects external rules before provision and releases admission/fence once', async () => {
    const external = path.join(root, 'external'); await fs.mkdir(external)
    await fs.writeFile(path.join(external, 'AGENTS.md'), 'private rules')
    const release = vi.fn(), dispose = vi.fn(async () => undefined)
    const guarded = new WorkerHarness({ adapters: new Map([['builtin', adapter]]), defaultImpl: 'builtin', ledger,
      workspaces, workersDir: path.join(root, 'workers'), now: () => new Date().toISOString(), onEvent() {},
      acquireWorkerFence: async () => ({ release }), admitWorkerConnection: async () => ({ env: {}, dispose }) })
    await expect(guarded.spawnWorker({ ...params(), workspace: external })).rejects.toThrow('PERMISSION_DENIED')
    expect(release).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce()
    expect(adapter.provision).not.toHaveBeenCalled(); expect(adapter.spawn).not.toHaveBeenCalled()
    expect(await ledger.listAllWorkers()).toEqual([])
    expect(await fs.readdir(external)).toEqual(['AGENTS.md'])
  })
  it('checks rule symlinks and readonly normalization before any writes', async () => {
    const external = path.join(root, 'external'); await fs.mkdir(external)
    const secret = path.join(root, 'secret.md'); await fs.writeFile(secret, 'private')
    await fs.symlink(secret, path.join(external, 'AGENTS.md'))
    const read = { ...principal(), storage: { workspace_path: external, access: 'read' as const } }
    await expect(harness.spawnWorker({ ...params(), workspace: external, principal_permissions: read })).rejects.toThrow('PERMISSION_DENIED')
    await fs.unlink(path.join(external, 'AGENTS.md')); await fs.writeFile(path.join(external, 'AGENTS.md'), 'rules')
    await expect(harness.spawnWorker({ ...params(), workspace: external, principal_permissions: read })).rejects.toThrow('只读')
    expect(await fs.readdir(external)).toEqual(['AGENTS.md'])
  })
  it('keeps native CLI admission unchanged', () => {
    for (const impl of ['codex', 'claude-code'] as const) expect(() => assertExecutionPolicy(impl, principal())).toThrow('EXECUTION_POLICY_UNSUPPORTED')
  })
  it('wires the production runtime factory to actual Write/Read and rechecks saved ownership', async () => {
    const agent = Object.create(UnifiedAgent.prototype) as any
    Object.assign(agent, { config: { moduleId: 'fixture' }, agentConfig: { skills: [{ id: 'tmp-page', name: 'tmp-page', description: 'fixture', skill_dir: root }], subagents: [] },
      agentHandler: { createBuiltinBgToolOptions: () => undefined }, mcpConnector: { getAllTools: () => [] }, knownSecrets: [] })
    vi.stubEnv('WORKER_WORKSPACES_DIR', path.join(root, 'configured-workspaces'))
    const stack = buildManagerStack({ dataRoot: root, now: () => new Date().toISOString(), managerAdapter: () => ({ async *stream() { yield* chunksFromContent([{ type: 'text', text: 'fixture' }], 'end_turn') }, updateConfig() {} }), managerModel: () => 'fixture',
      messagingDeps: {} as never, memoryServerFor: () => createCrabMemoryServer({ rpcClient: { call: vi.fn(), callSensitive: vi.fn() } as never, moduleId: 'fixture', getMemoryPort: async () => 1 }, { accessContext: { actor_kind: 'conversation', memory_enabled: false }, visibility: 'internal', scopes: [], isMasterPrivate: false }), callAdmin: async () => ({} as never), principalResolver: {} as never,
      builtinSpawnDefaults: ctx => ({ adapter: {} as never, model: 'fixture', systemPrompt: '', tools: () => agent.buildBuiltinWorkerTools(ctx) }) })
    stack.adapters.set('builtin', adapter)
    try {
      const worker = await stack.harness.spawnWorker(params()), workspace = worker.incarnations[0].workspace
      const tools = (lastSpec.builtin!.tools as () => any[])(), write = tools.find(tool => tool.name === 'Write')
      const file = path.join(workspace, 'deliverables', 'result.html')
      expect(workspace).toBe(path.join(root, 'configured-workspaces', 'default', 'tasks', worker.worker_id))
      expect((await write.call({ file_path: file, content: 'task result' }, {})).isError).toBe(false)
      expect(await fs.readFile(file, 'utf8')).toBe('task result')
      expect((await tools.find(tool => tool.name === 'Read').call({ file_path: file }, {})).output).toContain('task result')
      const savedContexts = new WorkerContextStore(path.join(root, 'agent', 'workers'))
      await savedContexts.write(worker.worker_id, { ...await savedContexts.read(worker.worker_id), creator_friend_id: 'another' })
      expect((await write.call({ file_path: file, content: 'must not write' }, {})).isError).toBe(true)
      expect(await fs.readFile(file, 'utf8')).toBe('task result')
      expect(tools.some(tool => tool.category === 'messaging' || tool.category === 'memory')).toBe(false)
    } finally { await stack.dispose() }
  })
})
