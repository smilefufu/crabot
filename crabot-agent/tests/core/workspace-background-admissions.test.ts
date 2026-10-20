import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { spawnPersistentShell, runShellWithGrace, killShellTree } from '../../src/engine/bg-entities/bg-shell.js'
import { spawnPersistentAgent } from '../../src/engine/bg-entities/bg-agent.js'
import { runEngine } from '../../src/engine/query-loop.js'
import { relocationAgentConfig } from './fixtures/relocation-agent-config.js'

vi.mock('../../src/engine/query-loop.js', async importOriginal => ({ ...await importOriginal<typeof import('../../src/engine/query-loop.js')>(), runEngine: vi.fn() }))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
let data: string, agent: any, finish: ReturnType<typeof deferred>
const controllers = new Map<string, AbortController>()
const owner = { friend_id: 'original-friend', worker_id: 'original-worker', incarnation_id: 'original-incarnation' }
const task = 'original-task'
function shellOptions() {
  return { command: `"${process.execPath}" -e 'setTimeout(()=>{},30000)'`, cwd: data, owner, spawned_by_task_id: task, registry: agent.builtinBgRegistry }
}
function agentOptions() {
  return { prompt: 'original prompt', task_description: 'original task', tools: [], systemPrompt: 'fixture', model: 'offline-fixture',
    adapter: { stream: vi.fn(), updateConfig() {} } as any, owner, spawned_by_task_id: task, registry: agent.builtinBgRegistry, abortControllers: controllers }
}
beforeEach(async () => {
  data = await fs.mkdtemp(path.join(tmpdir(), 'workspace-bg-admission-'))
  vi.stubEnv('DATA_DIR', data); vi.stubEnv('CRABOT_AGENT_DATA_DIR', path.join(data, 'agent'))
  agent = new UnifiedAgent(relocationAgentConfig) as any
  agent.managerStack.harness.deps.isWorkspaceRelocationReady = () => true
  finish = deferred()
  vi.mocked(runEngine).mockImplementation(async () => { await finish.promise; return { outcome: 'completed', finalText: 'done', finalMessages: [] } as any })
})
afterEach(async () => {
  finish.resolve()
  const registry = agent.builtinBgRegistry
  for (const record of await registry.list()) if (record.type === 'shell' && record.status === 'running') killShellTree(record.pgid)
  await vi.waitFor(async () => {
    expect((await registry.list()).every((record: any) => record.status !== 'running')).toBe(true)
    expect(controllers.size).toBe(0)
  })
  await agent.managerStack.dispose()
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs()
  await fs.rm(data, { recursive: true, force: true })
})

describe('workspace background registration admission', () => {
  it.each(['persistent shell', 'grace shell', 'persistent agent'])('waits for admitted registration without waiting for the business execution: %s', async kind => {
    const entered = deferred(), release = deferred(), registry = agent.builtinBgRegistry
    const originalRegister = registry.register.bind(registry)
    vi.spyOn(registry, 'register').mockImplementation(async (record: any) => { entered.resolve(); await release.promise; await originalRegister(record) })
    const capture = vi.spyOn(agent.managerStack.harness, 'captureWorkspaceRelocationScope')
    const starting = kind === 'persistent shell' ? spawnPersistentShell(shellOptions())
      : kind === 'grace shell' ? runShellWithGrace({ ...shellOptions(), gracePeriodMs: 10 }) : spawnPersistentAgent(agentOptions())
    let scope: Promise<unknown> | undefined
    try {
      await entered.promise
      scope = agent.captureWorkspaceRelocationScope()
      await new Promise(resolve => setImmediate(resolve))
      expect(capture).not.toHaveBeenCalled()
      release.resolve(); await starting
      expect(await scope).toEqual([])
      const records = await registry.list()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ owner, spawned_by_task_id: task, status: 'running', ended_at: null })
      if (kind === 'persistent agent') expect(runEngine).toHaveBeenCalledOnce()
      else expect(() => process.kill(records[0].pid, 0)).not.toThrow()
    } finally { release.resolve(); await starting; await scope }
  })
  it('rejects all new background starts after drainage while query and exit settlement stay available', async () => {
    await agent.captureWorkspaceRelocationScope()
    const register = vi.spyOn(agent.builtinBgRegistry, 'register')
    await expect(spawnPersistentShell(shellOptions())).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
    expect(await runShellWithGrace({ ...shellOptions(), gracePeriodMs: 10 })).toMatchObject({ kind: 'spawn_error', message: expect.stringContaining('迁移') })
    await expect(spawnPersistentAgent(agentOptions())).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
    expect(register).not.toHaveBeenCalled(); expect(runEngine).not.toHaveBeenCalled()
    expect(await agent.builtinBgRegistry.list()).toEqual([])
    await expect(fs.stat(path.join(data, 'agent/bg-entities'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects a new background Agent at the durable fence before trace, file, registration or engine creation', async () => {
    const startTrace = vi.fn(() => ({ trace_id: 'must-not-create' })), createExecution = vi.fn()
    await fs.mkdir(path.join(data, 'workspace-control'), { recursive: true })
    await fs.writeFile(path.join(data, 'workspace-control/relocation.json'), 'fixed job')
    const register = vi.spyOn(agent.builtinBgRegistry, 'register')
    await expect(spawnPersistentAgent({ ...agentOptions(), createExecution,
      subTrace: { traceStore: { startTrace, endTrace: vi.fn() } as any, parentTraceId: 'original-parent' } })).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
    expect(startTrace).not.toHaveBeenCalled(); expect(createExecution).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled(); expect(runEngine).not.toHaveBeenCalled(); expect(controllers.size).toBe(0)
    await expect(fs.stat(path.join(data, 'agent/bg-entities'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
