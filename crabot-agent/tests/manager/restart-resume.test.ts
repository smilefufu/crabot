import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ManagerRegistry, type ManagerRegistryDeps } from '../../src/manager/registry.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import { TraceStore } from '../../src/core/trace-store.js'
import { defineTool, type LLMAdapter, type LLMStreamParams } from '../../src/engine/index.js'
import type { ChannelMessage, Friend, ResolvedPermissions } from '../../src/types.js'
import type { ManagerResumeCheckpoint } from '../../src/manager/resume-checkpoint.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

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

  it('resumes the same episode after a successful send without a new human wake or repeated send', async () => {
    const sent = vi.fn(async () => {
      old.getOrCreate(KEY).recordSuccessfulSendMessage({ channel_id: 'feishu', session_id: 'restart-test' })
      old.getOrCreate(KEY).recordWorkerContinuation('continued-worker')
      old.getOrCreate(KEY).recordSpawnedWorker('spawned-worker')
      return { output: 'delivered', isError: false }
    })
    const send = defineTool({ name: 'send_message', description: 'send', inputSchema: {}, isReadOnly: false, call: sent })
    let calls = 0
    const old = registry({
      async *stream() {
        if (calls++ === 0) {
          yield* chunksFromContent([{ type: 'tool_use', id: 'sent-once', name: 'send_message', input: { text: 'reply' } }], 'tool_use')
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
        expect(restored.getOrCreate(KEY).hasSuccessfulSendMessageTo({ channel_id: 'feishu', session_id: 'restart-test' })).toBe(true)
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
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.spawned_worker_ids).toEqual(['spawned-worker'])
    expect(trace.listManagerEpisodes(KEY).items).toHaveLength(1)
    expect(await store.loadCheckpoint(KEY)).toBeUndefined()
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
    expect(tools).toHaveBeenCalledWith(KEY, false, undefined, { friend, sessionType: 'private' }, permissions, expect.any(Object), expect.objectContaining({ kind: 'human_messages', friend }))
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

  it('restores a consumed image supplement from its reference without persisting inbound base64', async () => {
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
    await old.routeHumanMessages('feishu', 'restart-test', [imageMessage])
    release()
    const checkpoint = await checkpointWhere((value) => value.state.committedHumanMessageIds?.includes('image-supplement') === true)
    expect(JSON.stringify(checkpoint)).not.toContain(bytes.toString('base64'))
    expect(checkpoint.state.imageRefs).toHaveLength(1)
    const restored = registry({ async *stream(params) {
      expect(JSON.stringify(params.messages)).toContain(bytes.toString('base64'))
      yield* chunksFromContent([], 'end_turn')
    }, updateConfig() {} }, { supportsVision: () => true })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()
    expect(JSON.stringify(await store.load(KEY))).not.toContain(bytes.toString('base64'))
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.status).toBe('completed')
  })

  it('keeps restored workboard notices transient and acknowledges the original revision', async () => {
    const old = registry({ async *stream() { await new Promise(() => {}) }, updateConfig() {} })
    void old.routeWorkboardAdminUpdate({ key: KEY, noticeRevision: 17 })
    const checkpoint = await checkpointWhere((value) => value.hasEngineMessages)
    expect(checkpoint.transientMessageIds).toHaveLength(1)
    const consumed = vi.fn(async () => {})
    const restored = registry({ async *stream(params) {
      expect(JSON.stringify(params.messages).match(/管理员已更新任务板/g)).toHaveLength(1)
      yield* chunksFromContent([], 'end_turn')
    }, updateConfig() {} }, { onWorkboardAdminUpdateConsumed: consumed })
    restored.registerResumeCheckpoints([checkpoint])
    trace.reconcileInterruptedManagerEpisodes(new Set([checkpoint.episodeId]))
    await restored.resumeInterruptedEpisodes()
    expect(JSON.stringify(await store.load(KEY))).not.toContain('管理员已更新任务板')
    expect(consumed).toHaveBeenCalledWith(KEY, [17])
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
    void old.routeSchedule({ scheduleId: 'original-schedule', title: 'Original schedule', description: 'Original scheduled instruction',
      creatorFriendId: 'creator', targetSession: { channel_id: 'feishu', session_id: 'restart-test' } })
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
    expect(resolve).toHaveBeenCalledWith({ key: KEY, creatorFriendId: 'creator', isBuiltin: undefined })
    expect(trace.getManagerEpisode(checkpoint.episodeId)?.status).toBe('failed')
    expect(await store.loadCheckpoint(KEY)).toBeUndefined()
    expect(restored.getOrCreate(KEY).hasPendingMailbox).toBe(false)
    shouldFail = false
    const result = await restored.routeHumanMessages('feishu', 'restart-test', [message('new', 'New instruction')])
    expect(result.outcome).toBe('completed')
    expect(trace.listManagerEpisodes(KEY).items).toHaveLength(2)
  })
})
