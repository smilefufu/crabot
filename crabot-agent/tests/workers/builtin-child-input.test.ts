import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BuiltinSubagentRunner } from '../../src/workers/builtin/subagent-runner.js'
import { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
import { TraceStore } from '../../src/core/trace-store.js'
import type { LSPManager } from '../../src/lsp/lsp-manager.js'
import type { SubAgentConfig } from '../../src/types.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter.js'
import type { EngineMessage, ToolDefinition } from '../../src/engine/types.js'
import * as llmModule from '../../src/engine/llm-adapter.js'
import { BUILTIN_WORKER_PERMISSIONS } from '../../src/workers/builtin/runtime.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
const text = (value: string) => chunksFromContent([{ type: 'text', text: value }], 'end_turn')
const toolCalls = (names: string[], input: Record<string, unknown> = {}) => chunksFromContent(
  names.map((name, i) => ({ type: 'tool_use', id: `tool-${i}`, name, input })), 'tool_use',
)

describe('builtin child input through the real Engine', () => {
  let dir: string
  let registry: BgEntityRegistry
  let store: TraceStore
  let runner: BuiltinSubagentRunner
  let previousDataDir: string | undefined
  let caller: { worker_id: string; caller_instance_id: string; parent_trace_id: string }
  let releases: Array<() => void>
  const notify = vi.fn()

  beforeEach(async () => {
    releases = []; notify.mockClear()
    dir = await fs.mkdtemp(join(tmpdir(), 'child-input-engine-'))
    previousDataDir = process.env.DATA_DIR; process.env.DATA_DIR = dir
    registry = new BgEntityRegistry(join(dir, 'registry.json'))
    store = new TraceStore(1, join(dir, 'traces'))
    const parent = store.startTrace({ module_id: 'test', trigger: { type: 'task', summary: 'parent' } })
    caller = { worker_id: 'worker-1', caller_instance_id: 'worker-1#1', parent_trace_id: parent.trace_id }
    runner = new BuiltinSubagentRunner(store, {} as LSPManager, notify, registry, s => s.replaceAll('SECRET', '[redacted]'))
  })
  afterEach(async () => {
    for (const release of releases) release()
    await runner.stopWorker('worker-1')
    await vi.waitFor(() => expect((runner as any).abortControllers.size).toBe(0), { timeout: 5000 })
    vi.restoreAllMocks()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await fs.rm(dir, { recursive: true, force: true })
  })
  function barrier() { const result = gate(); releases.push(result.release); return result }
  async function launch(adapter: LLMAdapter, tools: ToolDefinition[] = []) {
    vi.spyOn(llmModule, 'createAdapter').mockReturnValue(adapter)
    const result = await runner.run({ id: 'test', name: 'test', description: 'test', when_to_use: 'test',
      model: { endpoint: 'https://test.invalid', apikey: 'test', model_id: 'test', format: 'openai' },
      builtin_capabilities: { file_system: true, shell: true }, allowed_mcp_server_ids: [], allowed_skill_ids: [],
    } as unknown as SubAgentConfig, { task: 'INITIAL_TASK' }, { worker_subagent: caller }, tools,
    { permissionConfig: { mode: 'bypass' }, resolvedPermissions: BUILTIN_WORKER_PERMISSIONS, availableSkills: [], getCwd: () => dir })
    expect(result.isError).toBe(false)
    return JSON.parse(result.output) as { agent_id: string; child_trace_id: string }
  }
  const send = (id: string, value: string) => runner.sendInput(id, value, { worker_subagent: caller })

  it('queues during LLM/tools, preserves both parallel results, then injects FIFO exactly once', async () => {
    const llmGate = barrier(); const readGate = barrier(); const grepGate = barrier()
    const requests: EngineMessage[][] = []; const entered: string[] = []
    const tools = ['Read', 'Grep'].map((name, index): ToolDefinition => ({
      name, description: name, inputSchema: { type: 'object' }, isReadOnly: true,
      call: async () => { entered.push(name); await [readGate, grepGate][index].promise; return { output: `${name}_RESULT`, isError: false } },
    }))
    const child = await launch({
      async *stream(params) {
        requests.push(structuredClone(params.messages) as EngineMessage[])
        if (requests.length === 1) { await llmGate.promise; yield* toolCalls(['Read', 'Grep']) }
        else yield* text('DONE')
      }, updateConfig() {},
    }, tools)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect((await send(child.agent_id, 'first SECRET')).isError).toBe(false)
    expect((await runner.readTrace('worker-1', child.agent_id)).events.some(e => e.detail?.sender === 'parent')).toBe(false)
    llmGate.release()
    await vi.waitFor(() => expect(entered).toHaveLength(2))
    expect((await send(child.agent_id, 'second')).isError).toBe(false)
    readGate.release()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(requests).toHaveLength(1)
    grepGate.release()
    await vi.waitFor(async () => expect((await registry.get(child.agent_id))?.status).toBe('completed'))
    expect(requests).toHaveLength(2)
    const final = JSON.stringify(requests[1])
    expect(final.match(/INITIAL_TASK/g)).toHaveLength(1)
    expect(final).toContain('Read_RESULT'); expect(final).toContain('Grep_RESULT')
    expect(final.indexOf('Grep_RESULT')).toBeLessThan(final.indexOf('first SECRET'))
    expect(final.indexOf('first SECRET')).toBeLessThan(final.indexOf('second'))
    expect(final.match(/first SECRET/g)).toHaveLength(1)
    const events = (await runner.readTrace('worker-1', child.agent_id)).events
    const inputs = events.filter(e => e.detail?.sender === 'parent')
    expect(inputs.map(e => e.detail?.content)).toEqual(['[parent input]\nfirst [redacted]', '[parent input]\nsecond'])
    expect(notify).toHaveBeenCalledTimes(1)
    expect((await send(child.agent_id, 'late')).isError).toBe(true)
    expect(await registry.list({ type: 'agent' })).toHaveLength(1)
  })

  it('accepted input during end_turn resumes original messages instead of finalizing', async () => {
    const first = barrier(); const requests: EngineMessage[][] = []
    const child = await launch({
      async *stream(params) {
        requests.push(structuredClone(params.messages) as EngineMessage[])
        if (requests.length === 1) { await first.promise; yield* text('FIRST_RESULT') }
        else yield* text('UPDATED_RESULT')
      }, updateConfig() {},
    })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect((await send(child.agent_id, 'use FIRST_RESULT')).isError).toBe(false)
    first.release()
    await vi.waitFor(async () => expect((await registry.get(child.agent_id))?.status).toBe('completed'))
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain('FIRST_RESULT')
    expect(JSON.stringify(requests[1]).match(/INITIAL_TASK/g)).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await fs.readFile((await registry.get(child.agent_id) as any).result_file, 'utf8')).toBe('UPDATED_RESULT')
  })

  it('parent input releases Output, resumes a suspended child, and keeps Shell notification ownership', async () => {
    const first = barrier(); const requests: EngineMessage[][] = []
    const child = await launch({
      async *stream(params) {
        requests.push(structuredClone(params.messages) as EngineMessage[])
        if (requests.length === 1) { await first.promise; yield* toolCalls(['Output'], { entity_id: 'shell_pending' }) }
        else yield* text(`RESULT_${requests.length}`)
      }, updateConfig() {},
    }, [{ name: 'Output', description: 'output', inputSchema: {}, isReadOnly: true, call: async () => { throw new Error('must rebind') } }])
    const now = new Date().toISOString(); const log = join(dir, 'shell.log'); await fs.writeFile(log, '')
    await registry.register({ entity_id: 'shell_pending', type: 'shell', status: 'running', exit_code: null,
      owner: { friend_id: '__system_worker-1', worker_id: 'worker-1', subagent_id: child.agent_id },
      spawned_by_task_id: 'worker-1', spawned_at: now, last_activity_at: now, ended_at: null,
      command: 'fixture only', pid: 99999999, pgid: 99999999, process_started_at: now, log_file: log })
    first.release()
    await vi.waitFor(async () => expect((await runner.readTrace('worker-1', child.agent_id)).events.some(e => e.kind === 'tool_call' && e.summary === 'Output')).toBe(true))
    expect((await send(child.agent_id, 'redirect')).isError).toBe(false)
    await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 3500 })
    expect(JSON.stringify(requests[1])).toContain('reason: external_input')
    expect(JSON.stringify(requests[1])).toContain('[parent input]')
    expect((await registry.get(child.agent_id))?.status).toBe('running')
    expect(notify).not.toHaveBeenCalled()
    expect((await send(child.agent_id, 'supplement')).isError).toBe(false)
    await vi.waitFor(() => expect(requests).toHaveLength(3), { timeout: 3500 })
    expect(JSON.stringify(requests[2])).toContain('RESULT_2')
    await registry.update('shell_pending', { status: 'completed', exit_code: 0, ended_at: new Date().toISOString() })
    await runner.routeShellExit('shell_pending')
    await vi.waitFor(async () => expect((await registry.get(child.agent_id))?.status).toBe('completed'), { timeout: 3500 })
    expect(requests).toHaveLength(4)
    expect(JSON.stringify(requests[3])).toContain('<bg-notification>')
    expect(JSON.stringify(requests[3]).match(/INITIAL_TASK/g)).toHaveLength(1)
    expect((await registry.get('shell_pending'))?.exit_notification?.status).toBe('delivered')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('worker-1', child.agent_id)
  }, 12000)
})
