import { createManagerCompactionProfile } from '../../src/engine/context-manager.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ManagerRegistry, type ManagerRegistryDeps } from '../../src/manager/registry.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import { TraceStore } from '../../src/core/trace-store.js'
import { createUserMessage, defineTool, type LLMAdapter, type LLMStreamParams } from '../../src/engine/index.js'
import type { ChannelMessage, Friend, ResolvedPermissions } from '../../src/types.js'
import type { ManagerResumeCheckpoint } from '../../src/manager/resume-checkpoint.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import { ManagerToolCatalog, NORMAL_MANAGER_CORE_NAMES, type ManagerToolFaceState } from '../../src/manager/tools/tool-catalog.js'
import { renderGuidance } from '../../src/guidance/catalog.js'
import { buildPromptCacheKey } from '../../src/engine/prompt-cache-key.js'
import { DailyReflectionEvidence } from '../../src/manager/daily-reflection-evidence.js'
import type { DailyReflectionState } from '../../src/manager/daily-reflection-types.js'
import { WorkerTurnStore } from '../../src/workers/harness/worker-turn-store.js'

const KEY = 'feishu::restart-test'
const message = (id: string, text: string): ChannelMessage => ({
  platform_message_id: id,
  session: { channel_id: 'feishu', session_id: 'restart-test', type: 'private' },
  sender: { platform_user_id: 'human', platform_display_name: 'Human' },
  content: { type: 'text', text },
  features: { is_mention_crab: false },
  platform_timestamp: '2026-09-06T14:05:00.000Z',
})

describe('Manager restart continuation', () => {
  let dir: string
  let store: ManagerSessionStore
  let trace: TraceStore

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'manager-resume-'))
    store = new ManagerSessionStore(join(dir, 'managers'))
    trace = new TraceStore(100, join(dir, 'traces'), 'running.jsonl', 'traces-v3-')
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    trace.stopFlushTimer()
    await fs.rm(dir, { recursive: true, force: true })
  })

  function registry(adapter: LLMAdapter, overrides: Partial<ManagerRegistryDeps> = {}) {
    return new ManagerRegistry({
      store, adapter: () => adapter, model: () => 'test-model',
      policy: { keepRecent: 20, hardCapTokens: 1000000 },
      managerKeyFor: (key) => key,
      promptInputs: () => ({}),
      toolFace: () => [],
      now: () => new Date('2026-09-06T14:05:00.000Z'),
      readCurrentWorkboard: async (key) => ({ manager_key: key, objectives: [], archive: [] }),
      timezone: () => 'Asia/Shanghai',
      harness: {} as ManagerRegistryDeps['harness'],
      ledger: {} as ManagerRegistryDeps['ledger'],
      traceWriter: trace.managerTraceWriter((text) => text),
      ...overrides,
    })
  }

  async function checkpointWhere(predicate: (checkpoint: ManagerResumeCheckpoint) => boolean) {
    let checkpoint: ManagerResumeCheckpoint | undefined
    await vi.waitFor(async () => {
      checkpoint = await store.loadCheckpoint(KEY)
      expect(checkpoint && predicate(checkpoint)).toBe(true)
    })
    return checkpoint!
  }

  it('restores a group with many image references as one image without rewriting durable history', async () => {
    const oldPath = join(dir, 'old.png')
    const latestPath = join(dir, 'latest.png')
    await fs.writeFile(oldPath, 'old-picture')
    await fs.writeFile(latestPath, 'latest-picture')
    const incoming: ChannelMessage = {
      ...message('group-images', '最后一张'),
      session: { channel_id: 'feishu', session_id: 'restart-test', type: 'group' },
      content: { type: 'image', text: '最后一张', media: [
        { media_url: oldPath, mime_type: 'image/png', filename: 'old.png' },
        { media_url: latestPath, mime_type: 'image/png', filename: 'latest.png' },
      ] },
    }
    const deps = { supportsVision: () => true, promptInputs: () => ({ isGroup: true }) }
    let called = false
    const old = registry({ async *stream() { called = true; await new Promise(() => {}) }, updateConfig() {} }, deps)
    void old.routeHumanMessages('feishu', 'restart-test', [incoming])
    const checkpoint = await checkpointWhere(() => called)
    expect(JSON.stringify(checkpoint)).not.toContain('"source"')
    expect(checkpoint.state.imageRefs?.[0].images).toHaveLength(2)
    const inputs: LLMStreamParams[] = []
    const restored = registry({
      async *stream(params) { inputs.push(params); yield* chunksFromContent([], 'end_turn') }, updateConfig() {},
    }, deps)
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()
    expect(inputs).toHaveLength(1)
    const blocks = inputs[0].messages.flatMap((m) => 'content' in m && Array.isArray(m.content) ? m.content : [])
    expect(blocks.filter((block) => block.type === 'image')).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('latest-picture').toString('base64') } },
    ])
    const state = await store.load(KEY)
    expect(JSON.stringify(state.recent)).toContain('[图片: old.png]')
    expect(JSON.stringify(state.recent)).not.toContain('图片内容未附带')
    expect(JSON.stringify(state.recent)).not.toContain('"source"')
    expect(await store.loadCheckpoint(KEY)).toBeUndefined()
  })

  it.each(['send_message', 'send_private_message'])('resumes the same episode after %s without a new human wake or repeated send', async (toolName) => {
    const sent = vi.fn(async () => {
      if (toolName === 'send_message') old.getOrCreate(KEY).recordSuccessfulSendMessage({ channel_id: 'feishu', session_id: 'restart-test' })
      old.getOrCreate(KEY).recordWorkerContinuation('continued-worker')
      old.getOrCreate(KEY).recordSpawnedWorker('spawned-worker')
      return { output: 'delivered', isError: false }
    })
    const send = defineTool({ name: toolName, description: 'send', inputSchema: {}, isReadOnly: false, call: sent })
    let calls = 0
    const old = registry({
      async *stream() {
        if (calls++ === 0) {
          yield* chunksFromContent([{ type: 'tool_use', id: 'sent-once', name: toolName, input: { text: 'reply' } }], 'tool_use')
        } else {
          await new Promise(() => {})
        }
      }, updateConfig() {},
    }, { toolFace: () => [send] })
    void old.routeHumanMessages('feishu', 'restart-test', [message('original', 'Continue the work')])
    const checkpoint = await checkpointWhere((value) => value.turns.length === 1 && calls === 2)
    expect(sent).toHaveBeenCalledTimes(1)

    const inputs: LLMStreamParams[] = []
    const restored = registry({
      async *stream(params) {
        inputs.push({ ...params, messages: [...params.messages] })
        expect(restored.getOrCreate(KEY).hasSuccessfulSendMessageTo({ channel_id: 'feishu', session_id: 'restart-test' })).toBe(toolName === 'send_message')
        expect(restored.getOrCreate(KEY).hasContinuedWorker('continued-worker')).toBe(true)
        yield* chunksFromContent([], 'end_turn')
      }, updateConfig() {},
    }, { toolFace: () => [send] })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()
    await restored.resumeInterruptedEpisodes()

    expect(inputs).toHaveLength(1)
    expect(JSON.stringify(inputs[0].messages)).toContain('delivered')
    expect(JSON.stringify(inputs[0].messages).match(/Continue the work/g)).toHaveLength(1)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.status).toBe('completed')
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.outcome?.summary).toContain('replied=yes')
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.spawned_worker_ids).toEqual(['spawned-worker'])
    expect(trace.listManagerEpisodes(KEY).items).toHaveLength(1)
    expect(await store.loadCheckpoint(KEY)).toBeUndefined()
  })

  it('restarts with only the fixed core while retaining completed calls to previously loaded tools', async () => {
    vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_MODE', 'progressive')
    vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_KEYS', KEY)
    const inspected = vi.fn(async () => ({ output: 'completed-inspection', isError: false }))
    const tools = NORMAL_MANAGER_CORE_NAMES.filter((name) => name !== 'search_tools').map((name) => defineTool({
      name, description: name, inputSchema: { type: 'object' }, call: async () => ({ output: '', isError: false }),
    }))
    tools.push(defineTool({ name: 'inspect_crabot', description: 'inspect deployment', inputSchema: { type: 'object' }, call: inspected }))
    const states = new Set<ManagerToolFaceState>()
    const toolFace: ManagerRegistryDeps['toolFace'] = (_key, _system, _identity, _principal, _permissions, _hooks, _wake, state) => {
      if (!state) throw new Error('episode tool state missing')
      states.add(state)
      state.catalog ??= new ManagerToolCatalog(tools, 'normal', undefined, undefined, undefined, { crabot: ['inspect_crabot'] })
      const catalog = state.catalog
      state.familyTool ??= defineTool({ name: 'load_tool_family', description: 'load family', inputSchema: { type: 'object' },
        call: async input => ({ output: JSON.stringify(catalog.loadFamily(state, input.family)), isError: false }) })
      state.searchTool ??= defineTool({
        name: 'search_tools', description: 'search', inputSchema: { type: 'object' }, isReadOnly: false,
        call: async (input) => ({ output: JSON.stringify(catalog.search(state, input.query, 1)), isError: false }),
      })
      return catalog.project(state, state.searchTool)
    }
    let calls = 0
    const old = registry({
      async *stream(params) {
        calls += 1
        if (calls === 1) {
          yield* chunksFromContent([{ type: 'tool_use', id: 'search', name: 'load_tool_family', input: { family: 'crabot' } }], 'tool_use')
        } else if (calls === 2) {
          expect(params.tools.at(-1)?.name).toBe('inspect_crabot')
          yield* chunksFromContent([{ type: 'tool_use', id: 'inspect', name: 'inspect_crabot', input: {} }], 'tool_use')
        } else {
          await new Promise(() => {})
        }
      }, updateConfig() {},
    }, { toolFace })
    void old.routeHumanMessages('feishu', 'restart-test', [message('original', 'Inspect deployment')])
    const checkpoint = await checkpointWhere((value) => value.turns.length === 2 && calls === 3)
    expect([...states][0].loadedNames.has('inspect_crabot')).toBe(true)

    const inputs: LLMStreamParams[] = []
    const restored = registry({
      async *stream(params) {
        inputs.push({ ...params, messages: [...params.messages] })
        yield* chunksFromContent([], 'end_turn')
      }, updateConfig() {},
    }, { toolFace })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()
    expect(inputs).toHaveLength(1)
    expect(inputs[0].tools.map((tool) => tool.name)).toEqual([...NORMAL_MANAGER_CORE_NAMES])
    expect(JSON.stringify(inputs[0].messages)).toContain('completed-inspection')
    expect(states.size).toBe(2)
    expect([...states][1].loadedNames.size).toBe(0)
    expect(inspected).toHaveBeenCalledOnce()
    expect(await store.loadCheckpoint(KEY)).toBeUndefined()
  })

  it('excludes a restarted daily Worker continuation from the next reflection window', async () => {
    const windowStart = new Date(Date.now() - 60_000).toISOString()
    let requested = false
    const old = registry({ async *stream() {
      requested = true
      await new Promise(() => {})
    }, updateConfig() {} })
    void old.getOrCreate(KEY).wakeUp({
      received_at: windowStart, timezone: 'Asia/Shanghai',
      wake: {
        kind: 'worker_event',
        event: { kind: 'turn_completed', worker_id: 'analysis-worker', ts: windowStart, seq: 1, detail: {} },
        dailyReflection: { runId: 'previous-run', scheduleId: 'daily-reflection',
          targetSession: { channel_id: 'feishu', session_id: 'restart-test', type: 'private' } },
      },
    })
    const checkpoint = await checkpointWhere(value => value.hasEngineMessages && requested)
    expect(checkpoint.toolProfile).toBe('daily_reflection')
    const restored = registry({ async *stream() { yield* chunksFromContent([], 'end_turn') }, updateConfig() {} })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.trigger.type).toBe('worker_event')
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.status).toBe('completed')

    const evidence = new DailyReflectionEvidence({
      managersDir: join(dir, 'managers'), store, traces: trace,
      ledger: { listAllWorkers: async () => [] } as unknown as ManagerRegistryDeps['ledger'],
      harness: {} as ManagerRegistryDeps['harness'], turns: new WorkerTurnStore(join(dir, 'workers')),
      captureWorkerTrace: vi.fn(), readWorkerTrace: vi.fn(), redact: text => text,
    })
    // The previous run has completed: its episode IDs are no longer available in daily state.
    const nextRun = { window_start: windowStart, window_end: new Date(Date.now() + 60_000).toISOString(),
      episode_ids: [], analysis_worker_ids: [] } as unknown as DailyReflectionState
    expect(await evidence.capture(nextRun)).toEqual({ records: [], gaps: [] })
  })

  it('preserves an interrupted tool call as unknown instead of executing it again during recovery', async () => {
    const calls = vi.fn(async () => new Promise<{ output: string; isError: boolean }>(() => {}))
    const tool = defineTool({ name: 'send_message', description: 'send', inputSchema: {}, isReadOnly: false, call: calls })
    const old = registry({
      async *stream() {
        yield* chunksFromContent([{ type: 'tool_use', id: 'in-flight', name: 'send_message', input: { text: 'reply' } }], 'tool_use')
      }, updateConfig() {},
    }, { toolFace: () => [tool] })
    void old.routeHumanMessages('feishu', 'restart-test', [message('original', 'Continue the work')])
    const checkpoint = await checkpointWhere((value) => value.tools.some((event) => event.type === 'tool_started'))
    let input = ''
    const restored = registry({
      async *stream(params) {
        input = JSON.stringify(params.messages)
        yield* chunksFromContent([], 'end_turn')
      }, updateConfig() {},
    }, { toolFace: () => [tool] })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()
    expect(input).toContain('[interrupted: agent restarted]')
    expect(input).toContain('in-flight')
    expect(calls).toHaveBeenCalledTimes(1)
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.status).toBe('completed')
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.spans.find((span) => span.type === 'tool_call')?.status).toBe('failed')
  })

  it('retains queued human input and waits for startup reconciliation before accepting a new episode', async () => {
    const old = registry({ async *stream() { await new Promise(() => {}) }, updateConfig() {} })
    void old.routeHumanMessages('feishu', 'restart-test', [message('original', 'Original instruction')])
    await checkpointWhere((value) => value.hasEngineMessages)
    await old.routeHumanMessages('feishu', 'restart-test', [message('queued', 'Queued correction')])
    const checkpoint = await checkpointWhere((value) => value.pending.length === 1)
    const inputs: string[] = []
    const restored = registry({
      async *stream(params) { inputs.push(JSON.stringify(params.messages)); yield* chunksFromContent([], 'end_turn') },
      updateConfig() {},
    })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    const newWake = restored.routeHumanMessages('feishu', 'restart-test', [message('new', 'New instruction')])
    await Promise.resolve()
    expect(inputs).toHaveLength(0)
    await restored.resumeInterruptedEpisodes()
    await newWake
    expect(inputs[0]).toContain('Original instruction')
    expect(inputs.slice(0, -1).join('\n')).toContain('Queued correction')
    expect(inputs[0]).not.toContain('New instruction')
    expect(inputs.at(-1)).toContain('New instruction')
    expect((await store.load(KEY)).committedHumanMessageIds).toEqual(expect.arrayContaining(['original', 'queued', 'new']))
  })

  it('preserves committed quotes and prepares pending quotes after restart without extending checkpoints', async () => {
    const call = vi.fn(async (_port: number, _method: string, params: { platform_message_id: string }) =>
      message(params.platform_message_id, `Body of ${params.platform_message_id}`))
    const quotedPrefetch = {
      rpcClient: { call } as never, moduleId: 'agent-test', resolveChannelPort: async () => 19009,
    }
    const original = message('original', 'Original instruction')
    original.features.reply_to_message_id = 'quote-original'
    const queued = message('queued', 'Queued correction')
    queued.features.quote_message_id = 'quote-queued'
    const old = registry({ async *stream() { await new Promise(() => {}) }, updateConfig() {} }, { quotedPrefetch })
    void old.routeHumanMessages('feishu', 'restart-test', [original])
    await checkpointWhere((value) => value.hasEngineMessages)
    await old.routeHumanMessages('feishu', 'restart-test', [queued])
    const checkpoint = await checkpointWhere((value) => value.pending.length === 1)
    const pendingSnapshot = JSON.stringify(checkpoint.pending)
    expect(pendingSnapshot).not.toContain('Body of')
    expect(JSON.stringify(checkpoint.state.recent)).toContain('Body of quote-original')
    call.mockClear()

    const inputs: string[] = []
    const restored = registry({
      async *stream(params) { inputs.push(JSON.stringify(params.messages)); yield* chunksFromContent([], 'end_turn') },
      updateConfig() {},
    }, { quotedPrefetch })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()

    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith(19009, 'get_message', {
      session_id: 'restart-test', platform_message_id: 'quote-queued',
    }, 'agent-test')
    expect(inputs[0]).toContain('Body of quote-original')
    expect(inputs.join('\n')).toContain('Body of quote-queued')
    expect(inputs.join('\n')).toContain('<quoted_message')
    expect(JSON.stringify(checkpoint.pending)).toBe(pendingSnapshot)
    expect((await store.load(KEY)).committedHumanMessageIds).toEqual(expect.arrayContaining(['original', 'queued']))
  })

  it('restores an interrupted episode before admitting a schedule for the same Manager', async () => {
    const old = registry({ async *stream() { await new Promise(() => {}) }, updateConfig() {} })
    void old.routeHumanMessages('feishu', 'restart-test', [message('original', 'Original instruction')])
    const checkpoint = await checkpointWhere((value) => value.hasEngineMessages)
    const inputs: string[] = []
    const restored = registry({
      async *stream(params) { inputs.push(JSON.stringify(params.messages)); yield* chunksFromContent([], 'end_turn') },
      updateConfig() {},
    })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    const scheduled = restored.routeSchedule({
      scheduleId: 'follow-up', triggerId: 'follow-up-trigger', scheduleName: 'Follow up',
      title: 'Follow up', description: 'Scheduled follow-up',
      targetSession: { channel_id: 'feishu', session_id: 'restart-test', type: 'private' },
    })
    await Promise.resolve()
    expect(inputs).toHaveLength(0)

    await restored.resumeInterruptedEpisodes()
    await scheduled
    expect(inputs).toHaveLength(2)
    expect(inputs[0]).toContain('Original instruction')
    expect(inputs[0]).not.toContain('Scheduled follow-up')
    expect(inputs[1]).toContain('Original instruction')
    expect(inputs[1]).toContain('Scheduled follow-up')
    const history = JSON.stringify((await store.load(KEY)).recent)
    expect(history).toContain('Original instruction')
    expect(history).toContain('Scheduled follow-up')
  })

  it('resumes an initial checkpoint with the original human identity and freshly resolved permissions', async () => {
    const friend: Friend = {
      id: 'original-friend', display_name: 'Original friend', permission: 'normal',
      channel_identities: [], created_at: '', updated_at: '',
    }
    let initial: ManagerResumeCheckpoint | undefined
    const save = store.saveCheckpoint.bind(store)
    vi.spyOn(store, 'saveCheckpoint').mockImplementation((checkpoint) => {
      if (!initial) initial = JSON.parse(JSON.stringify(checkpoint))
      save(checkpoint)
    })
    const old = registry({ async *stream() { await new Promise(() => {}) }, updateConfig() {} })
    void old.routeHumanMessages('feishu', 'restart-test', [message('original', 'Original instruction')], friend)
    await checkpointWhere((value) => value.hasEngineMessages)
    expect(initial?.hasEngineMessages).toBe(false)

    const permissions = { memory_scopes: ['current-scope'] } as ResolvedPermissions
    const resolve = vi.fn(async () => permissions)
    const tools = vi.fn(() => [])
    const restored = registry({ async *stream(params) {
      expect(JSON.stringify(params.messages).match(/Original instruction/g)).toHaveLength(1)
      yield* chunksFromContent([], 'end_turn')
    }, updateConfig() {} }, { onHumanWake: resolve, toolFace: tools })
    restored.registerResumeCheckpoints([initial!])
    trace.reconcileInterruptedManagerEpisodes(new Set([initial!.episodeId]))
    await restored.resumeInterruptedEpisodes()
    expect(resolve).toHaveBeenCalledWith(KEY, { friend, sessionType: 'private' })
    expect(tools).toHaveBeenCalledWith(
      KEY,
      false,
      undefined,
      { friend, sessionType: 'private' },
      permissions,
      expect.any(Object),
      expect.objectContaining({ kind: 'human_messages', friend }),
      expect.objectContaining({ mode: 'full', loadedNames: expect.any(Set) }),
    )
    expect(trace.getManagerEpisode(initial!.episodeId)?.trigger.type).toBe('human_message')
    expect(trace.getManagerEpisode(initial!.episodeId)?.status).toBe('completed')
  })

  it('retains completed calls across repeated restarts during an unfinished tool turn', async () => {
    const sent = vi.fn(async () => ({ output: 'delivered once', isError: false }))
    const send = defineTool({ name: 'send_message', description: '', inputSchema: {}, isReadOnly: false, call: sent })
    const wait = defineTool({ name: 'wait', description: '', inputSchema: {}, isReadOnly: true,
      call: async () => new Promise<{ output: string; isError: boolean }>(() => {}) })
    const old = registry({ async *stream() {
      yield* chunksFromContent([
        { type: 'tool_use', id: 'sent', name: 'send_message', input: {} },
        { type: 'tool_use', id: 'waiting', name: 'wait', input: {} },
      ], 'tool_use')
    }, updateConfig() {} }, { toolFace: () => [send, wait] })
    void old.routeHumanMessages('feishu', 'restart-test', [message('original', 'Continue')])
    const checkpoint = await checkpointWhere((value) => value.tools.some((event) => event.name === 'wait'))
    const firstRestart = registry({ async *stream() { await new Promise(() => {}) }, updateConfig() {} })
    firstRestart.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    void firstRestart.resumeInterruptedEpisodes()
    const continued = await checkpointWhere((value) => JSON.stringify(value.state.recent).includes('[interrupted: agent restarted]'))
    const secondRestart = registry({ async *stream(params) {
      const text = JSON.stringify(params.messages)
      expect(text.match(/delivered once/g)).toHaveLength(1)
      expect(text.match(/\[interrupted: agent restarted\]/g)).toHaveLength(1)
      yield* chunksFromContent([], 'end_turn')
    }, updateConfig() {} })
    secondRestart.registerResumeCheckpoints([continued])
    trace.reconcileInterruptedManagerEpisodes(new Set([continued.episodeId]))
    await secondRestart.resumeInterruptedEpisodes()
    expect(trace.getManagerEpisode(continued.episodeId)?.status).toBe('completed')
    expect(sent).toHaveBeenCalledTimes(1)
    const spans = trace.getManagerEpisode(continued.episodeId)!.spans
    expect(spans.filter((span) => span.type === 'tool_call')).toHaveLength(2)
    expect(spans.filter((span) => span.type === 'tool_call' && span.status === 'failed')).toHaveLength(1)
    for (const span of spans.filter((span) => span.type === 'tool_call')) {
      expect(spans.some((parent) => parent.span_id === span.parent_span_id)).toBe(true)
    }
  })

  it('preserves completed calls through compaction and restart without replay', async () => {
    await store.save({ key: KEY, foldedCount: 0, recent: [
      createUserMessage('old history: ' + 'x'.repeat(3000)),
      createUserMessage('more old history: ' + 'x'.repeat(3000)),
    ] })
    const sent = vi.fn(async () => ({ output: 'already delivered', isError: false }))
    const send = defineTool({ name: 'send_message', description: '', inputSchema: {}, isReadOnly: false, call: sent })
    let calls = 0
    const old = registry({ async *stream(params) {
      if (params.systemPrompt.includes(createManagerCompactionProfile().summarySystemPrompt)) {
        yield* chunksFromContent([{ type: 'text', text: 'Old history summary' }], 'end_turn')
      } else if (calls++ === 0) {
        yield* chunksFromContent([{ type: 'tool_use', id: 'discarded-call', name: 'send_message', input: {} }], 'tool_use')
      } else if (calls === 2) {
        yield* chunksFromContent([], 'max_tokens')
      } else await new Promise(() => {})
    }, updateConfig() {} }, { toolFace: () => [send], policy: { keepRecent: 0, hardCapTokens: 1000000 } })
    void old.routeHumanMessages('feishu', 'restart-test', [message('original', 'Continue after overflow')])
    const checkpoint = await checkpointWhere((value) => value.state.foldedCount > 0 && calls === 3)
    expect(checkpoint.tools).toHaveLength(1)
    expect(JSON.stringify(checkpoint.state.recent)).toContain('discarded-call')
    const inputs: string[] = []
    const restored = registry({ async *stream(params) {
      inputs.push(JSON.stringify(params.messages))
      yield* chunksFromContent([], 'end_turn')
    }, updateConfig() {} })
    restored.registerResumeCheckpoints([checkpoint])
    await restored.resumeInterruptedEpisodes()
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toContain('discarded-call')
    expect(JSON.stringify(await store.load(KEY))).toContain('discarded-call')
    expect(sent).toHaveBeenCalledTimes(1)
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.spans.filter((span) => span.type === 'tool_call')).toHaveLength(1)
  })

  it.each(['human', 'schedule'] as const)('continues a compacted long %s episode from its saved progress across restart', async (source) => {
    let inference = 0
    let paused = false
    const read = vi.fn(async () => ({ output: 'DIRECTORY_PAGE:' + 'x'.repeat(4000), isError: false }))
    const page = defineTool({ name: 'page', description: 'read page', inputSchema: {}, call: read })
    const old = registry({ async *stream(params) {
      if (params.systemPrompt === createManagerCompactionProfile().summarySystemPrompt) {
        yield* chunksFromContent([{ type: 'text', text: 'directory progress saved' }], 'end_turn')
      } else if (inference++ < 24) {
        yield* chunksFromContent([{ type: 'tool_use', id: `page-${inference}`, name: 'page', input: {} }], 'tool_use', {
          inputTokens: inference === 24 ? 90000 : 100, outputTokens: 5,
        })
      } else {
        paused = true
        await new Promise(() => {})
      }
    }, updateConfig() {} }, { contextWindowTokens: () => 100000, toolFace: () => [page] })
    if (source === 'human') void old.routeHumanMessages('feishu', 'restart-test', [message('original', 'Original long request')])
    else void old.getOrCreate(KEY).wakeUp({ received_at: '2026-09-06T14:05:00Z', timezone: 'Asia/Shanghai',
      wake: { kind: 'schedule', scheduleId: 'long-review', title: 'Original long request', description: 'read all pages' } })
    const checkpoint = await checkpointWhere(value => paused && value.state.foldedCount > 0)
    expect(checkpoint.state.rollingSummary).toBeUndefined()
    expect(checkpoint.state.recent.some(item => item.id.startsWith('compaction:'))).toBe(true)
    const original = checkpoint.state.recent.find(item => item.id === checkpoint.protectedTailMessageId)!
    expect(JSON.stringify(original)).toContain('Original long request')
    const inputs: LLMStreamParams[] = []
    const summaries: string[] = []
    const restored = registry({ async *stream(params) {
      if (params.systemPrompt === createManagerCompactionProfile().summarySystemPrompt) {
        summaries.push(JSON.stringify(params.messages))
        yield* chunksFromContent([{ type: 'text', text: 'directory progress retained after restart' }], 'end_turn')
      } else {
        inputs.push({ ...params, messages: [...params.messages] })
        yield* chunksFromContent([], 'end_turn')
      }
    }, updateConfig() {} }, { contextWindowTokens: () => 10000, toolFace: () => [page] })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()
    expect(summaries.length).toBeGreaterThan(0)
    expect(summaries.some(text => text.includes('Original long request'))).toBe(false)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].messages).toContainEqual(original)
    expect(JSON.stringify(inputs[0].messages)).toContain('directory progress retained after restart')
    expect(read).toHaveBeenCalledTimes(24)
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.status).toBe('completed')
    expect(await store.loadCheckpoint(KEY)).toBeUndefined()
  })

  it('does not reconstruct settled interrupted calls after compaction and another restart', async () => {
    const read = defineTool({ name: 'read', description: '', inputSchema: {}, isReadOnly: true,
      call: async () => ({ output: 'old-tool-result:' + 'x'.repeat(160000), isError: false }) })
    const wait = defineTool({ name: 'wait', description: '', inputSchema: {}, isReadOnly: false,
      call: async () => new Promise<{ output: string; isError: boolean }>(() => {}) })
    const old = registry({ async *stream() {
      yield* chunksFromContent([
        { type: 'tool_use', id: 'old-read', name: 'read', input: {} },
        { type: 'tool_use', id: 'old-wait', name: 'wait', input: {} },
      ], 'tool_use')
    }, updateConfig() {} }, { toolFace: () => [read, wait] })
    void old.routeWorkboardAdminUpdate({ key: KEY, noticeRevision: 1 })
    const checkpoint = await checkpointWhere((value) => value.tools.some((event) => event.name === 'wait'))
    const next = defineTool({ name: 'next', description: '', inputSchema: {}, isReadOnly: true,
      call: async () => ({ output: 'new result', isError: false }) })
    let resumedCalls = 0
    const firstRestart = registry({ async *stream() {
      if (resumedCalls++ === 0) {
        yield* chunksFromContent([{ type: 'tool_use', id: 'new-call', name: 'next', input: {} }], 'tool_use')
      } else await new Promise(() => {})
    }, updateConfig() {} }, { toolFace: () => [next] })
    firstRestart.registerResumeCheckpoints([checkpoint])
    void firstRestart.resumeInterruptedEpisodes()
    const materialized = await checkpointWhere((value) => value.turns.length === 1 && resumedCalls === 2)
    const secondRestart = registry({ async *stream(params) {
      if (params.systemPrompt.includes(createManagerCompactionProfile().summarySystemPrompt)) {
        yield* chunksFromContent([{ type: 'text', text: 'Prior tools were settled after interruption' }], 'end_turn')
      } else await new Promise(() => {})
    }, updateConfig() {} }, { policy: { keepRecent: 0, hardCapTokens: 12000 } })
    secondRestart.registerResumeCheckpoints([materialized])
    void secondRestart.resumeInterruptedEpisodes()
    const continued = await checkpointWhere((value) => value.state.foldedCount > 0)
    expect(JSON.stringify(continued.state.recent)).not.toContain('old-tool-result:')
    const inputs: string[] = []
    const thirdRestart = registry({ async *stream(params) {
      inputs.push(JSON.stringify(params.messages))
      yield* chunksFromContent([], 'end_turn')
    }, updateConfig() {} })
    thirdRestart.registerResumeCheckpoints([continued])
    await thirdRestart.resumeInterruptedEpisodes()
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).not.toContain('old-tool-result:')
    expect(inputs[0]).not.toContain('old-wait')
    expect(JSON.stringify(await store.load(KEY))).not.toContain('old-read')
    const spans = trace.getManagerEpisode(continued.episodeId)!.spans
    expect(spans.filter((span) => span.type === 'tool_call')).toHaveLength(3)
    expect(spans.filter((span) => span.type === 'tool_call' && span.status === 'failed')).toHaveLength(1)
  })

  it('keeps the current human input protected when a resumed episode compacts history', async () => {
    await store.save({ key: KEY, foldedCount: 0, recent: [
      createUserMessage('old history: ' + 'x'.repeat(80000)),
      createUserMessage('last old history'),
    ] })
    const read = defineTool({ name: 'read', description: '', inputSchema: {}, isReadOnly: true,
      call: async () => ({ output: 'current result', isError: false }) })
    let calls = 0
    const old = registry({ async *stream() {
      if (calls++ === 0) {
        yield* chunksFromContent([{ type: 'tool_use', id: 'current-call', name: 'read', input: {} }], 'tool_use')
      } else await new Promise(() => {})
    }, updateConfig() {} }, { toolFace: () => [read] })
    void old.routeHumanMessages('feishu', 'restart-test', [message('original', 'Current request stays literal')])
    const checkpoint = await checkpointWhere((value) => value.turns.length === 1 && calls === 2)
    const folds: string[] = []
    const inputs: string[] = []
    const restored = registry({ async *stream(params) {
      if (params.systemPrompt.includes(createManagerCompactionProfile().summarySystemPrompt)) {
        folds.push(JSON.stringify(params.messages))
        yield* chunksFromContent([{ type: 'text', text: 'Old history summary' }], 'end_turn')
      } else {
        inputs.push(JSON.stringify(params.messages))
        yield* chunksFromContent([], 'end_turn')
      }
    }, updateConfig() {} }, { policy: { keepRecent: 0, hardCapTokens: 12000 } })
    restored.registerResumeCheckpoints([checkpoint])
    await restored.resumeInterruptedEpisodes()
    expect(folds).not.toHaveLength(0)
    expect(folds.join('\n')).not.toContain('Current request stays literal')
    expect(inputs[0].match(/Current request stays literal/g)).toHaveLength(1)
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.status).toBe('completed')
  })

  it('protects a human supplement whose Engine message ID changed during an overflow retry', async () => {
    const accepted = vi.fn(async () => {})
    await store.save({ key: KEY, foldedCount: 0, recent: [
      ...Array.from({ length: 3 }, (_, index) => createUserMessage(`old history ${index}: ` + 'x'.repeat(80000))),
      createUserMessage('last old history'),
    ] })
    const read = defineTool({ name: 'read', description: '', inputSchema: {}, isReadOnly: true,
      call: async () => {
        await old.routeHumanMessages('feishu', 'restart-test', [message('supplement', 'Keep this correction literal')], undefined, undefined, { onLlmResponse: accepted })
        return { output: 'current result', isError: false }
      } })
    const next = defineTool({ name: 'next', description: '', inputSchema: {}, isReadOnly: true,
      call: async () => ({ output: 'retry result', isError: false }) })
    let calls = 0
    const folds: string[] = []
    const old = registry({ async *stream(params) {
      if (params.systemPrompt.includes(createManagerCompactionProfile().summarySystemPrompt)) {
        folds.push(JSON.stringify(params.messages))
        yield* chunksFromContent([{ type: 'text', text: 'Old history summary' }], 'end_turn')
      } else if (calls++ === 0) {
        yield* chunksFromContent([{ type: 'tool_use', id: 'read-call', name: 'read', input: {} }], 'tool_use')
      } else if (calls === 2) {
        expect(accepted).not.toHaveBeenCalled()
        yield* chunksFromContent([], 'max_tokens')
      } else if (calls === 3) {
        yield* chunksFromContent([{ type: 'tool_use', id: 'retry-call', name: 'next', input: {} }], 'tool_use')
      } else await new Promise(() => {})
    }, updateConfig() {} }, { toolFace: () => [read, next], policy: { keepRecent: 2, hardCapTokens: 1000000 } })
    void old.routeWorkboardAdminUpdate({ key: KEY, noticeRevision: 1 })
    const checkpoint = await checkpointWhere((value) => value.state.foldedCount > 0 && calls === 4)
    expect(accepted).toHaveBeenCalledTimes(1)
    const inputs: string[] = []
    const restored = registry({ async *stream(params) {
      if (params.systemPrompt.includes(createManagerCompactionProfile().summarySystemPrompt)) {
        folds.push(JSON.stringify(params.messages))
        yield* chunksFromContent([{ type: 'text', text: 'Old history summary' }], 'end_turn')
      } else {
        inputs.push(JSON.stringify(params.messages))
        yield* chunksFromContent([], 'end_turn')
      }
    }, updateConfig() {} }, { policy: { keepRecent: 0, hardCapTokens: 12000 } })
    restored.registerResumeCheckpoints([checkpoint])
    await restored.resumeInterruptedEpisodes()
    expect(folds).not.toHaveLength(0)
    expect(folds.join('\n')).not.toContain('Keep this correction literal')
    expect(inputs[0].match(/Keep this correction literal/g)).toHaveLength(1)
    expect((await store.load(KEY)).committedHumanMessageIds).toContain('supplement')
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.status).toBe('completed')
    expect(accepted).toHaveBeenCalledTimes(1)
  })

  it('restores a consumed image supplement from its reference without persisting inbound base64', async () => {
    const accepted = vi.fn(async () => {})
    const path = join(dir, 'supplement.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await fs.writeFile(path, bytes)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const old = registry({ async *stream() {
      if (calls++ === 0) { await gate; yield* chunksFromContent([], 'end_turn') }
      else await new Promise(() => {})
    }, updateConfig() {} }, { supportsVision: () => true })
    void old.routeHumanMessages('feishu', 'restart-test', [message('original', 'Original instruction')])
    await checkpointWhere((value) => value.hasEngineMessages)
    const imageMessage = { ...message('image-supplement', 'See image'), content: {
      type: 'image' as const, file_path: path, filename: 'supplement.png', mime_type: 'image/png',
    } }
    await old.routeHumanMessages('feishu', 'restart-test', [imageMessage], undefined, undefined, { onLlmResponse: accepted })
    expect(accepted).not.toHaveBeenCalled()
    release()
    const checkpoint = await checkpointWhere((value) => value.state.committedHumanMessageIds?.includes('image-supplement') === true)
    expect(JSON.stringify(checkpoint)).not.toContain(bytes.toString('base64'))
    expect(checkpoint.state.imageRefs).toHaveLength(1)
    expect(accepted).not.toHaveBeenCalled()
    const restored = registry({ async *stream(params) {
      expect(JSON.stringify(params.messages)).toContain(bytes.toString('base64'))
      yield* chunksFromContent([], 'end_turn')
    }, updateConfig() {} }, { supportsVision: () => true })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()
    expect(JSON.stringify(await store.load(KEY))).not.toContain(bytes.toString('base64'))
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.status).toBe('completed')
    expect(accepted).not.toHaveBeenCalled()
  })

  it('恢复运行中注入的 guidance，不丢失、不重复，且不修改普通 system 或持久历史', async () => {
    const requests: LLMStreamParams[] = []
    const inject = defineTool({ name: 'inject', description: 'fixture', inputSchema: {}, call: async () => {
      const loop = old.getOrCreate(KEY)
      const clock = { received_at: '2026-09-06T22:05:00+08:00', timezone: 'Asia/Shanghai' }
      loop.enqueueDuringEpisode({ ...clock, wake: { kind: 'worker_event', event: {
        kind: 'turn_completed', worker_id: 'resume-worker', ts: clock.received_at, seq: 1, detail: {},
      } } })
      loop.enqueueWorkboardAdminUpdate({ ...clock, wake: { kind: 'workboard_admin_update', noticeRevision: 8 } })
      loop.enqueueDuringEpisode({ ...clock, wake: { kind: 'workboard_idle_review' } })
      return { output: 'injected', isError: false }
    } })
    const old = registry({ async *stream(params) {
      requests.push({ ...params, messages: [...params.messages] })
      if (requests.length === 1) yield* chunksFromContent([{ type: 'tool_use', id: 'inject-once', name: 'inject', input: {} }], 'tool_use')
      else await new Promise(() => {})
    }, updateConfig() {} }, { toolFace: () => [inject] })
    void old.routeHumanMessages('feishu', 'restart-test', [message('original', 'Continue')])
    const checkpoint = await checkpointWhere(value => value.turns.length === 1 && requests.length === 2)
    expect(checkpoint.transientMessageIds).toHaveLength(4)
    const restored = registry({ async *stream(params) {
      expect(params.systemPrompt).toBe(requests[0].systemPrompt)
      expect(buildPromptCacheKey(params.model, params.systemPrompt)).toBe(buildPromptCacheKey(requests[0].model, requests[0].systemPrompt))
      for (const name of ['manager.workboard', 'manager.worker-events'] as const) {
        expect(params.messages.filter(m => 'content' in m && m.content === renderGuidance('manager', name))).toHaveLength(1)
      }
      yield* chunksFromContent([], 'end_turn')
    }, updateConfig() {} })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()
    expect(JSON.stringify(await store.load(KEY))).not.toContain('## Guidance:')
    expect(await store.loadCheckpoint(KEY)).toBeUndefined()
  })

  it('keeps restored workboard notices transient and acknowledges the original revision', async () => {
    const old = registry({ async *stream() { await new Promise(() => {}) }, updateConfig() {} })
    void old.routeWorkboardAdminUpdate({ key: KEY, noticeRevision: 17 })
    const checkpoint = await checkpointWhere((value) => value.hasEngineMessages)
    expect(checkpoint.transientMessageIds).toHaveLength(1)
    const consumed = vi.fn(async () => {})
    const restored = registry({ async *stream(params) {
      expect(JSON.stringify(params.messages).match(/管理员已更新任务板/g)).toHaveLength(1)
      expect(JSON.stringify(params.messages)).not.toContain('## Guidance: manager.workboard')
      yield* chunksFromContent([], 'end_turn')
    }, updateConfig() {} }, { onWorkboardAdminUpdateConsumed: consumed })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()
    expect(JSON.stringify(await store.load(KEY))).not.toContain('管理员已更新任务板')
    expect(JSON.stringify(await store.load(KEY))).not.toContain('## Guidance:')
    expect(consumed).toHaveBeenCalledWith(KEY, [17])
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.status).toBe('completed')
  })

  it('续跑已准入的任务板空闲自省，且临时提示仍只出现一次、不落历史', async () => {
    const old = registry({ async *stream() { await new Promise(() => {}) }, updateConfig() {} })
    void old.getOrCreate(KEY).wakeUp({
      wake: { kind: 'workboard_idle_review' },
      received_at: '2026-09-06T22:05:00+08:00',
      timezone: 'Asia/Shanghai',
    })
    const checkpoint = await checkpointWhere((value) => value.hasEngineMessages)
    expect(checkpoint.transientMessageIds).toHaveLength(2)

    const restored = registry({
      async *stream(params) {
        expect(JSON.stringify(params.messages).match(/任务板中至少有一项尚未收口的工作已一小时没有更新/g)).toHaveLength(1)
        yield* chunksFromContent([], 'end_turn')
      },
      updateConfig() {},
    })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()

    expect(JSON.stringify(await store.load(KEY))).not.toContain('任务板中至少有一项尚未收口的工作已一小时没有更新')
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.status).toBe('completed')
  })

  it('isolates a corrupt checkpoint and fails its trace without blocking other Manager sessions', async () => {
    const old = registry({ async *stream() { await new Promise(() => {}) }, updateConfig() {} })
    void old.routeHumanMessages('feishu', 'restart-test', [message('original', 'Continue')])
    const checkpoint = await checkpointWhere((value) => value.hasEngineMessages)
    await fs.writeFile(join(dir, 'managers', encodeURIComponent(KEY), 'running.json'), '{')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await store.listCheckpoints()).toEqual([])
    trace.reconcileInterruptedManagerEpisodes()
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.status).toBe('failed')
    expect(error).toHaveBeenCalledWith(expect.stringContaining('resume checkpoint unavailable'), expect.any(Error))
    error.mockRestore()
  })

  it('settles a failed continuation without replaying the restored schedule as a new wake', async () => {
    const old = registry({ async *stream() { await new Promise(() => {}) }, updateConfig() {} })
    void old.routeSchedule({
      scheduleId: 'original-schedule', triggerId: 'original-trigger', scheduleName: 'Original schedule',
      title: 'Original schedule', description: 'Original scheduled instruction',
      creatorFriendId: 'creator',
      targetSession: { channel_id: 'feishu', session_id: 'restart-test', type: 'private' },
    })
    const checkpoint = await checkpointWhere((value) => value.hasEngineMessages)
    const resolve = vi.fn(async () => null)
    let shouldFail = true
    const restored = registry({ async *stream(params) {
      if (shouldFail) throw new Error('provider unavailable')
      expect(JSON.stringify(params.messages).match(/Original scheduled instruction/g)).toHaveLength(1)
      yield* chunksFromContent([], 'end_turn')
    }, updateConfig() {} }, { onScheduleWake: resolve })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()
    expect(resolve).toHaveBeenCalledWith({
      key: KEY,
      creatorFriendId: 'creator',
      isBuiltin: undefined,
      targetSession: { channel_id: 'feishu', session_id: 'restart-test', type: 'private' },
    })
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.status).toBe('failed')
    expect(await store.loadCheckpoint(KEY)).toBeUndefined()
    expect(restored.getOrCreate(KEY).hasPendingMailbox).toBe(false)
    shouldFail = false
    const result = await restored.routeHumanMessages('feishu', 'restart-test', [message('new', 'New instruction')])
    expect(result.outcome).toBe('completed')
    expect(trace.listManagerEpisodes(KEY).items).toHaveLength(2)
  })
})
