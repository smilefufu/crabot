import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
import type { BgAgentRegistryRecord } from '../../src/engine/bg-entities/types.js'
import { createListEntitiesTool } from '../../src/engine/tools/list-entities-tool.js'
import { createKillTool } from '../../src/engine/tools/kill-tool.js'
import { BuiltinSubagentRunner } from '../../src/workers/builtin/subagent-runner.js'
import type { TraceStore } from '../../src/core/trace-store.js'
import type { LSPManager } from '../../src/lsp/lsp-manager.js'
import * as llmModule from '../../src/engine/llm-adapter.js'
import { TraceStore as RealTraceStore } from '../../src/core/trace-store.js'
import { BUILTIN_WORKER_PERMISSIONS } from '../../src/workers/builtin/runtime.js'
import type { SubAgentConfig } from '../../src/types.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

describe('builtin child durable recovery and control', () => {
  let dir: string
  let registry: BgEntityRegistry
  function child(id = 'agent_own', worker = 'worker-1'): BgAgentRegistryRecord {
    const now = new Date().toISOString()
    return { entity_id: id, type: 'agent', status: 'running', owner: { friend_id: '__builtin_worker__', worker_id: worker }, spawned_by_task_id: worker, spawned_at: now, last_activity_at: now, ended_at: null, exit_code: null, task_description: 'test', messages_log_file: join(dir, id), result_file: null }
  }
  function runner() { return new BuiltinSubagentRunner({} as TraceStore, {} as LSPManager, undefined, registry) }
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'child-control-'))
    registry = new BgEntityRegistry(join(dir, 'registry.json'))
    await registry.register(child())
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }) })

  it.each([true, false])('recovery order registry-first=%s preserves one pending receipt across two restarts', async (registryFirst) => {
    if (registryFirst) await registry.recoverPersistent()
    await runner().recoverAfterRestart()
    if (!registryFirst) await registry.recoverPersistent()
    const first = await registry.get('agent_own')
    expect(first).toMatchObject({ status: 'stalled', exit_notification: { status: 'pending', attempts: 0 } })
    registry = new BgEntityRegistry(join(dir, 'registry.json'))
    await registry.recoverPersistent()
    await runner().recoverAfterRestart()
    expect(await registry.get('agent_own')).toEqual(first)
  })

  it('all scope includes own child despite friend sentinel and excludes another worker', async () => {
    await registry.register(child('agent_other', 'worker-2'))
    const tool = createListEntitiesTool({ registry, taskId: 'worker-1', ownerWorkerId: 'worker-1', ownerFriendId: '__system_worker-1', cursorMap: new Map() })
    const result = await tool.call({ scope: 'all' }, {})
    expect(result.output).toContain('agent_own')
    expect(result.output).not.toContain('agent_other')
  })

  it('failed atomic write publishes neither terminal nor receipt; retry persists both', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk write failed'))
    await expect(registry.update('agent_own', { status: 'completed', ended_at: new Date().toISOString() })).rejects.toThrow('disk write failed')
    expect(await registry.get('agent_own')).toMatchObject({ status: 'running' })
    expect((await registry.get('agent_own'))?.exit_notification).toBeUndefined()
    rename.mockRestore()
    await registry.update('agent_own', { status: 'completed', ended_at: new Date().toISOString() })
    expect(await registry.get('agent_own')).toMatchObject({ status: 'completed', exit_notification: { status: 'pending' } })
  })

  it('missing controller never fabricates a killed terminal record', async () => {
    const owner = runner()
    const tool = createKillTool({ registry, taskId: 'worker-1', ownerWorkerId: 'worker-1', cursorMap: new Map(), stopWorkerAgent: (id) => owner.stopAgent('worker-1', id) })
    expect((await tool.call({ entity_id: 'agent_own' }, {})).isError).toBe(true)
    expect((await registry.get('agent_own'))?.status).toBe('running')
  })

  it('stop remains running until executor exits; restart settles killed without a notification', async () => {
    const owner = runner()
    const controller = new AbortController()
    ;(owner as unknown as { abortControllers: Map<string, AbortController> }).abortControllers.set('agent_own', controller)
    const result = await owner.stopAgent('worker-1', 'agent_own')
    expect(controller.signal.aborted).toBe(true)
    expect(result.output).toContain('not confirmed')
    expect(await registry.get('agent_own')).toMatchObject({ status: 'running', stop_requested_at: expect.any(String) })
    await registry.recoverPersistent()
    expect(await registry.get('agent_own')).toMatchObject({ status: 'killed' })
    expect((await registry.get('agent_own'))?.exit_notification).toBeUndefined()
  })

  it('does not add a receipt to old terminal records or overwrite a confirmed natural outcome', async () => {
    await registry.register({ ...child(), status: 'completed' })
    await registry.update('agent_own', { last_activity_at: new Date().toISOString() })
    expect((await registry.get('agent_own'))?.exit_notification).toBeUndefined()
    await runner().stopAgent('worker-1', 'agent_own')
    expect((await registry.get('agent_own'))?.status).toBe('completed')
  })

  it('real child engine blocked in a tool stays running after Kill, then exits without another call', async () => {
    const previous = process.env.DATA_DIR
    process.env.DATA_DIR = dir
    let release!: () => void
    let entered!: () => void
    const inTool = new Promise<void>((resolve) => { entered = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    vi.spyOn(llmModule, 'createAdapter').mockReturnValue({
      async *stream() {
        calls++
        yield* chunksFromContent([{ type: 'tool_use', id: 'blocked-read', name: 'Read', input: { file_path: 'test' } }], 'tool_use', { inputTokens: 1, outputTokens: 1 })
      },
      updateConfig() {},
    } as any)
    const store = new RealTraceStore(1, join(dir, 'traces'))
    const parent = store.startTrace({ module_id: 'test', trigger: { type: 'task', summary: 'parent' } })
    const notify = vi.fn()
    const owner = new BuiltinSubagentRunner(store, {} as LSPManager, notify, registry)
    try {
      const launched = await owner.run({ id: 'reader', name: 'reader', description: 'reader', when_to_use: 'test', model: { endpoint: 'https://test.invalid', apikey: 'test', model_id: 'test', format: 'openai' }, builtin_capabilities: { file_system: true }, allowed_mcp_server_ids: [], allowed_skill_ids: [] } as unknown as SubAgentConfig,
        { task: 'read test' }, { worker_subagent: { worker_id: 'worker-1', parent_trace_id: parent.trace_id } },
        [{ name: 'Read', description: 'read', inputSchema: { type: 'object' }, isReadOnly: true, call: async () => { entered(); await blocked; return { output: 'read result', isError: false } } }],
        { permissionConfig: { mode: 'bypass' }, resolvedPermissions: BUILTIN_WORKER_PERMISSIONS, availableSkills: [], getCwd: () => dir })
      const id = JSON.parse(launched.output).agent_id
      await inTool
      const result = await createKillTool({ registry, taskId: 'worker-1', ownerWorkerId: 'worker-1', cursorMap: new Map(), stopWorkerAgent: (entityId) => owner.stopAgent('worker-1', entityId) }).call({ entity_id: id }, {})
      expect(result.output).toContain('not confirmed')
      expect((await registry.get(id))?.status).toBe('running')
      release()
      await vi.waitFor(async () => expect((await registry.get(id))?.status).toBe('killed'))
      await vi.waitFor(() => expect((owner as any).abortControllers.size).toBe(0))
      expect(calls).toBe(1)
      expect(notify).not.toHaveBeenCalled()
      expect((await registry.get(id))?.exit_notification).toBeUndefined()
    } finally {
      release()
      if (previous === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = previous
    }
  })
})
