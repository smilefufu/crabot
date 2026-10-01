import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BuiltinWorkerAdapter } from '../../src/workers/builtin/adapter.js'
import { WorkerHarness } from '../../src/workers/harness/harness.js'
import { LedgerStore } from '../../src/workers/harness/ledger-store.js'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager.js'
import { createOutputTool } from '../../src/engine/tools/output-tool.js'
import type { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
import type { WorkerAdapter, WorkerImplId } from '../../src/workers/types.js'
import type { HarnessEvent } from '../../src/workers/harness/worker-events.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

const sleepControl = vi.hoisted(() => ({ wait: undefined as undefined | ((ms: number, signal?: AbortSignal) => Promise<void>) }))
vi.mock('../../src/engine/retry-utils.js', async original => ({
  ...await original<object>(), sleep: (ms: number, signal?: AbortSignal) => sleepControl.wait!(ms, signal),
}))
const MINUTE = 60_000

describe('Output -> builtin Adapter -> liveness sweep', () => {
  let dir: string
  let clock: number
  let adapter: BuiltinWorkerAdapter
  let harness: WorkerHarness
  let events: HarnessEvent[]
  let sleeps: number
  let pendingSleeps: Array<() => void>
  let workerId: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'output-liveness-'))
    clock = Date.parse('2026-10-01T00:00:00Z')
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    events = []; sleeps = 0; pendingSleeps = []
    sleepControl.wait = (ms, signal) => {
      expect(ms).toBeLessThanOrEqual(2000)
      const n = sleeps++
      if (n < 5) { clock += 2 ** n * 2 * MINUTE; return Promise.resolve() }
      return new Promise((resolve, reject) => {
        const stop = () => { signal?.removeEventListener('abort', stop); reject(new Error('aborted')) }
        pendingSleeps.push(() => { signal?.removeEventListener('abort', stop); resolve() })
        if (signal?.aborted) stop()
        else signal?.addEventListener('abort', stop, { once: true })
      })
    }
    const log = join(dir, 'shell.log'); await fs.writeFile(log, '')
    const adapters = new Map<WorkerImplId, WorkerAdapter>()
    let calls = 0
    const llm: LLMAdapter = {
      async *stream() {
        if (calls++ < 6) yield* chunksFromContent([{ type: 'tool_use', id: `read-${calls}`, name: 'Output', input: { entity_id: 'shell_fixture' } }], 'tool_use')
        else yield* chunksFromContent([{ type: 'text', text: 'continued' }], 'end_turn')
      }, updateConfig() {},
    }
    harness = new WorkerHarness({
      adapters, defaultImpl: 'builtin', ledger: new LedgerStore(join(dir, 'ledgers')),
      workspaces: new WorkspaceManager(join(dir, 'workspaces')), workersDir: join(dir, 'workers'),
      now: () => new Date(clock).toISOString(),
      onEvent: event => { events.push(event); return { consumed: true } },
      builtinSpawnDefaults: context => ({ adapter: llm, model: 'test', systemPrompt: '', tools: [createOutputTool({
        taskId: context.worker_id, ownerWorkerId: context.worker_id, cursorMap: new Map(),
        registry: { get: async () => ({ entity_id: 'shell_fixture', type: 'shell', status: 'running',
          exit_code: null, log_file: log, owner: { worker_id: context.worker_id } }), update: async () => {} } as unknown as BgEntityRegistry,
      })] }),
    })
    adapter = new BuiltinWorkerAdapter({ dataDir: join(dir, 'builtin'), onStateChange: harness.handleStateChange })
    adapters.set('builtin', adapter)
    const worker = await harness.spawnWorker({ managerKey: 'test::output-liveness', title: 'controlled download', prompt: 'read output',
      origin: { trigger_type: 'message' }, report_to: { channel_id: 'test', session_id: 'output-liveness' } })
    workerId = worker.worker_id
    await vi.waitFor(() => expect(sleeps).toBe(6))
    events.length = 0
  })

  afterEach(async () => {
    await adapter?.dispose()
    if (harness) await Promise.all([...(harness as any).stateChangeTails.values()])
    harness?.stopLivenessSweep()
    sleepControl.wait = undefined
    vi.restoreAllMocks()
    await fs.rm(dir, { recursive: true, force: true })
  })

  const stalls = (events: HarnessEvent[]) => events.filter(event => event.kind === 'liveness_stall')

  it('does not wake Manager at minute 32 of an actual 64-minute Output', async () => {
    clock += 32 * MINUTE
    await harness.sweepLiveness()
    expect(stalls(events)).toHaveLength(0)
  })

  it('still reports an Output stuck past its fixed deadline and deduplicates it', async () => {
    clock += 64 * MINUTE + 2001
    await harness.sweepLiveness()
    expect(stalls(events)).toHaveLength(1)
    clock += 5 * MINUTE
    await harness.sweepLiveness()
    expect(stalls(events)).toHaveLength(1)
  })

  it('receives Manager input while waiting and resumes the existing Worker', async () => {
    clock += 32 * MINUTE
    await harness.sendToWorker(workerId, 'continue from retained results')
    for (const release of pendingSleeps.splice(0)) release()
    await vi.waitFor(async () => expect((await adapter.readRuntime({ worker_id: workerId, seq: 1, impl: 'builtin', session_ref: '' }))?.phase).toBe('idle'))
    const session = await fs.readFile(join(dir, 'builtin', workerId, 'session.jsonl'), 'utf8')
    expect(session).toContain('reason: external_input')
    expect(session).toContain('continue from retained results')
    expect(session).toContain('continued')
    await harness.sweepLiveness()
    expect(stalls(events)).toHaveLength(0)
  })
})

describe('builtin wait ownership and parallel tools', () => {
  let dir: string
  let adapter: BuiltinWorkerAdapter
  let clock: number
  let release: Array<() => void>
  let log: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'parallel-output-liveness-'))
    clock = Date.parse('2026-10-01T00:00:00Z')
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    release = []
    sleepControl.wait = (_ms, signal) => new Promise(resolve => {
      const done = () => { signal?.removeEventListener('abort', done); resolve() }
      release.push(done)
      signal?.addEventListener('abort', done, { once: true })
      if (signal?.aborted) done()
    })
    log = join(dir, 'output'); await fs.writeFile(log, '')
    adapter = new BuiltinWorkerAdapter({ dataDir: dir })
  })

  afterEach(async () => {
    await adapter.dispose()
    sleepControl.wait = undefined
    vi.restoreAllMocks()
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function spawn(targets: string[], workerId = 'owner') {
    let calls = 0
    const llm: LLMAdapter = {
      async *stream() {
        if (calls++ === 0) yield* chunksFromContent(targets.map((id, i) => ({ type: 'tool_use',
          id: `call-${i}`, name: id === 'other' ? 'Other' : 'Output', input: { entity_id: id },
        })), 'tool_use')
        else yield* chunksFromContent([{ type: 'text', text: 'done' }], 'end_turn')
      }, updateConfig() {},
    }
    return adapter.spawn({ worker_id: workerId, prompt: 'read results', workspace: { root: dir },
      builtin: { adapter: llm, model: 'test', systemPrompt: '', tools: [createOutputTool({
        ownerWorkerId: workerId, taskId: workerId, cursorMap: new Map(),
        registry: { get: async (id: string) => ({ entity_id: id, type: id.startsWith('agent') ? 'agent' : 'shell',
          status: 'running', owner: { worker_id: workerId }, log_file: log, output_file: log }),
          update: async () => {} } as unknown as BgEntityRegistry,
      }), { name: 'Other', description: 'Unrelated long read', isReadOnly: true,
        inputSchema: { type: 'object', properties: {} },
        call: async (_input, context) => {
          await sleepControl.wait!(2000, context.abortSignal)
          return { output: 'done', isError: false }
        },
      }] },
    })
  }

  it('uses the earliest deadline, then preserves the other call after one completes', async () => {
    const h = await spawn(['shell_a', 'agent_b'])
    await vi.waitFor(() => expect(release).toHaveLength(2))
    expect(await adapter.livenessWaitUntil(h)).toBe(clock + 2 * MINUTE)
    clock += 2 * MINUTE
    // Let both probes run: the shell times out, while the child enters its next probe.
    for (const wake of release.splice(0)) wake()
    await vi.waitFor(async () => expect(await adapter.livenessWaitUntil(h)).toBe(clock + 13 * MINUTE))
  })

  it('keeps concurrent reads of the same entity separate', async () => {
    const h = await spawn(['agent_a', 'agent_a'])
    await vi.waitFor(() => expect(release).toHaveLength(2))
    const deadline = clock + 15 * MINUTE
    clock += 1000
    await fs.writeFile(log, 'progress')
    release[0]()
    await vi.waitFor(async () => expect(await adapter.lastActivityAt(h)).toBe(clock))
    expect(await adapter.livenessWaitUntil(h)).toBe(deadline)
  })

  it('does not exempt a batch containing an unrelated long tool', async () => {
    const h = await spawn(['agent_a', 'other'])
    await vi.waitFor(() => expect(release).toHaveLength(2))
    expect(await adapter.livenessWaitUntil(h)).toBeUndefined()
  })

  it('has no wait exemption until the actual initial file read finishes', async () => {
    let releaseRead!: () => void
    const gate = new Promise<void>(resolve => { releaseRead = resolve })
    let reading = false
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (args[0] === log) { reading = true; await gate }
      return open(...args)
    })
    try {
      const h = await spawn(['agent_a'])
      await vi.waitFor(() => expect(reading).toBe(true))
      expect(await adapter.livenessWaitUntil(h)).toBeUndefined()
      releaseRead()
      await vi.waitFor(() => expect(release).toHaveLength(1))
      expect(await adapter.livenessWaitUntil(h)).toBe(clock + 15 * MINUTE)
    } finally { releaseRead() }
  })

  it('input to one waiting Worker does not affect another Worker', async () => {
    const first = await spawn(['agent_a'], 'first')
    const second = await spawn(['agent_b'], 'second')
    await vi.waitFor(() => expect(release).toHaveLength(2))
    await adapter.sendInput(first, 'correction')
    expect(await adapter.livenessWaitUntil(first)).toBeUndefined()
    expect(await adapter.livenessWaitUntil(second)).toBe(clock + 15 * MINUTE)
  })

  it('isolates Worker, incarnation and process ownership and clears on dispose', async () => {
    const h = await spawn(['agent_a'])
    await vi.waitFor(() => expect(release).toHaveLength(1))
    expect(await adapter.livenessWaitUntil(h)).toBe(clock + 15 * MINUTE)
    expect(await adapter.livenessWaitUntil({ ...h, worker_id: 'other' })).toBeUndefined()
    expect(await adapter.livenessWaitUntil({ ...h, seq: h.seq + 1 })).toBeUndefined()
    expect(await adapter.livenessWaitUntil({ ...h, incarnation_id: 'stale' })).toBeUndefined()
    const restarted = new BuiltinWorkerAdapter({ dataDir: dir })
    expect(await restarted.livenessWaitUntil(h)).toBeUndefined()
    await restarted.dispose()
    const disposing = adapter.dispose()
    expect(await adapter.livenessWaitUntil(h)).toBeUndefined()
    await disposing
    expect(await adapter.livenessWaitUntil(h)).toBeUndefined()
  })

  it.each([false, true])('pending input immediately ends eligibility (immediate=%s)', async immediate => {
    const h = await spawn(['agent_a'])
    await vi.waitFor(() => expect(release).toHaveLength(1))
    await adapter.sendInput(h, 'correction', { immediate_redirect: immediate })
    expect(await adapter.livenessWaitUntil(h)).toBeUndefined()
    release[0]()
    await vi.waitFor(async () => expect(await adapter.state(h)).toBe('idle'))
    expect(await adapter.livenessWaitUntil(h)).toBeUndefined()
  })

  it('clears on abort while retaining the existing interruption behavior', async () => {
    const h = await spawn(['agent_a'])
    await vi.waitFor(() => expect(release).toHaveLength(1))
    await adapter.interrupt(h)
    expect(await adapter.livenessWaitUntil(h)).toBeUndefined()
    await vi.waitFor(async () => expect(await adapter.state(h)).toBe('idle'))
  })
})
