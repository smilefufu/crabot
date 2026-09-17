import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { FixtureContainer } from './docker-fixtures.mjs'

const require = createRequire(path.resolve(import.meta.dirname, '../../package.json'))
const { buildManagerStack } = require('./dist/manager/bootstrap.js')
const { createCrabMemoryServer } = require('./dist/mcp/crab-memory.js')
const { createUserMessage, StreamProcessor } = require('./dist/engine/index.js')
const { CLI_DOMAINS } = require('./dist/types.js')
const { assembleBuiltinWorkerPrompt } = require('./dist/prompts/builtin-worker.js')
const { createGuidanceTool, renderGuidance } = require('./dist/guidance/catalog.js')
const automaticGuidanceTexts = new Set(['manager.worker-events', 'manager.workboard'].map(name => renderGuidance('manager', name)))
const { projectWorkerActivity } = require('./dist/workers/trace/activity-projection.js')
const { TraceStore } = require('./dist/core/trace-store.js')
const { recordEngineLlmResponse, recordEngineToolLifecycle, recordSubAgentTurn } = require('./dist/engine/sub-agent-trace.js')

export async function* scriptedChunks(blocks) {
  yield { type: 'message_start', messageId: 'fixture-script' }
  for (const block of blocks) {
    if (block.type === 'text') yield { type: 'text_delta', text: block.text }
    else {
      yield { type: 'tool_use_start', id: block.id, name: block.name }
      yield { type: 'tool_use_delta', id: block.id, inputJson: JSON.stringify(block.input) }
      yield { type: 'tool_use_end', id: block.id }
    }
  }
  yield { type: 'message_end', stopReason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const publicMessages = messages => messages.map(message => ({ ...message,
  content: Array.isArray(message.content) ? message.content.filter(b => b.type !== 'raw_reasoning') : message.content,
}))

// Production Manager/Harness/Builtin loop. Only external channel/memory boundaries are local.
// File and process tools always execute in the isolated container, never on the host.
export async function runHistory({ c, variant, image, root, baseline, delegate, record, maxRequests, timeoutMs = 600000 }) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const box = new FixtureContainer(image)
  const managerKey = 'fixture::synthetic'
  const now = () => new Date().toISOString()
  const friend = { id: 'fixture-human', display_name: '评测用户', permission: 'master', channel_identities: [], created_at: now(), updated_at: now() }
  const permissions = {
    tool_access: { memory: true, messaging: true, task: true, mcp_skill: true, file_io: true, shell: true, browser: false, remote_exec: false, desktop: false },
    cli_access: Object.fromEntries(CLI_DOMAINS.map(d => [d, 'none'])),
    storage: { workspace_path: root, access: 'readwrite' }, memory_scopes: ['fixture'],
  }
  const session = { channel_id: 'fixture', session_id: 'synthetic', type: 'private' }
  let stack, before, seedMode = c.role === 'manager', routing = false, requests = 0, activeCalls = 0
  let stopped = false, fatal, lastActivity = Date.now()
  const abort = new AbortController()
  const events = [], outbox = []
  const traces = new TraceStore(100)
  const cursors = new Map()
  const mintCursor = position => { const token = randomUUID(); cursors.set(token, position); return token }
  const emit = row => { const event = { ts: now(), ...row }; events.push(event); record(event); lastActivity = Date.now() }
  const adapterFor = (role, workerId) => ({
    updateConfig() {},
    async *stream(params) {
      if (role === 'worker' && seedMode) {
        yield* scriptedChunks([{ type: 'text', text: c.seed }]); return
      }
      if (stopped || requests >= maxRequests) {
        fatal ??= 'request-budget'; stopped = true
        emit({ type: 'request_rejected', role, workerId, reason: 'request-budget' })
        throw new Error('Fixture request budget exhausted')
      }
      const request = ++requests
      const oldManager = role === 'manager' && variant === 'baseline'
      const actual = { ...params, maxTokens: 2400,
        signal: AbortSignal.any([abort.signal, ...(params.signal ? [params.signal] : []), AbortSignal.timeout(90000)]),
        ...(oldManager ? { systemPrompt: baseline.manager, tools: params.tools.filter(t => t.name !== 'load_guidance'),
          messages: params.messages.filter(m => !(m.role === 'user' && automaticGuidanceTexts.has(m.content))),
        } : {}),
      }
      const processor = new StreamProcessor()
      activeCalls++
      emit({ type: 'request', request, role, workerId, systemPrompt: actual.systemPrompt,
        messages: publicMessages(actual.messages), tools: actual.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
      try {
        for await (const chunk of delegate.stream(actual, { role, request, workerId })) { processor.process(chunk); yield chunk }
        const response = processor.finalize()
        emit({ type: 'response', request, role, workerId, text: response.text, tools: response.toolUseBlocks, usage: response.usage, stopReason: response.stopReason })
      } catch (error) {
        fatal ??= 'model-error'; stopped = true; abort.abort()
        emit({ type: 'error', request, role, error: String(error) })
        throw error
      } finally { activeCalls-- }
    },
  })
  const toolsFor = workerId => {
    const definitions = ['Read', 'Edit', 'Write', 'Bash'].map(name =>
      require(`./dist/engine/tools/${name.toLowerCase()}-tool.js`)[`create${name}Tool`](() => '/fixture'))
    // Manager comparisons hold the downstream Worker prompt/tools constant.
    if (c.role === 'manager' || variant === 'candidate') definitions.push(createGuidanceTool('worker'))
    return definitions.map(t => ({ ...t, async call(input) {
      const receipt = await box.call(t.name, input)
      emit({ type: 'executed_tool', workerId, name: t.name, input, receipt })
      return receipt.result
    } }))
  }
  const memory = []
  const localRpc = { async call(_port, method, params) {
    emit({ type: 'local_rpc', method, params })
    if (method === 'send_message') {
      const item = { ...params, sent_at: now(), platform_message_id: `local-${outbox.length + 1}` }
      outbox.push(item)
      fs.appendFileSync(path.join(root, 'outbox.jsonl'), JSON.stringify(item) + '\n', { mode: 0o600 })
      return { platform_message_id: item.platform_message_id, sent_at: item.sent_at }
    }
    if (method === 'get_history') return { items: [{ platform_message_id: 'historical-human', sender: { friend_id: friend.id, platform_user_id: 'fixture-human', platform_display_name: friend.display_name }, content: { type: 'text', text: c.history }, features: { is_mention_crab: false }, platform_timestamp: now() }], pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 } }
    if (method === 'list_entries') return { entries: memory, pagination: { page: 1, page_size: 20, total_items: memory.length, total_pages: memory.length ? 1 : 0 } }
    if (method === 'search_memory' || method === 'search_long_term') return { results: memory }
    if (method === 'add_memory') { memory.push(params); return { id: `local-memory-${memory.length}` } }
    if (method === 'get_scene_profile') return { profile: null }
    throw new Error(`Unsupported local boundary: ${method}`)
  } }
  const waitUntil = async predicate => {
    const start = Date.now()
    while (!(await predicate())) {
      if (Date.now() - start > timeoutMs) { fatal ??= 'wallclock-budget'; abort.abort(); throw new Error('Fixture wallclock budget exhausted') }
      await pause(100)
    }
  }
  try {
    before = await box.start(c)
    emit({ type: 'start', container: box.name, before })
    stack = buildManagerStack({
      dataRoot: root, now, timezone: () => 'Asia/Shanghai',
      managerAdapter: () => adapterFor('manager'), managerModel: () => 'qwen3.8-max',
      isClosing: () => !routing || stopped,
      messagingDeps: { rpcClient: localRpc, moduleId: 'fixture', getAdminPort: async () => 19001, resolveChannelPort: async () => 19009 },
      memoryServerFor: ctx => createCrabMemoryServer({ rpcClient: localRpc, moduleId: 'fixture', getMemoryPort: async () => 19100 }, ctx),
      callAdmin: async method => { throw new Error(`Unsupported local admin call: ${method}`) },
      principalResolver: { resolvePermissions: async () => permissions, sessionMemoryScopes: async () => ['fixture'], sceneProfile: async () => null, crabSelfHandle: () => undefined, getFriend: async id => id === friend.id ? friend : null },
      capabilityBundle: async () => ({ skills: [], mcp_servers: [] }),
      builtinTraceHooks: {
        startIncarnationTrace: ({ summary }) => traces.startTrace({ module_id: 'fixture', trigger: { type: 'task', summary } }).trace_id,
        appendLlmResponse: (id, event) => recordEngineLlmResponse(traces, id, event, x => x),
        appendTurn: (id, event) => recordSubAgentTurn(traces, id, event, x => x),
        appendToolLifecycle: (id, event) => recordEngineToolLifecycle(traces, id, event, x => x),
        finishIncarnationTrace: (id, patch) => traces.endTrace(id, patch.status, { summary: patch.summary }),
      },
      builtinTraceReader: { readTrace: id => traces.getFullTrace(id) },
      mintActivityCursor: async position => mintCursor(position),
      builtinSpawnDefaults: ctx => ({
        adapter: adapterFor('worker', ctx.worker_id), model: 'qwen3.8-max', maxTokens: 2400, maxTurnsPerBurst: 12,
        systemPrompt: c.role === 'worker' && variant === 'baseline' ? baseline.worker : assembleBuiltinWorkerPrompt({ workspaceRoot: '/fixture', imageAvailable: false }),
        tools: toolsFor(ctx.worker_id),
      }),
      describeExecutionTools: () => ({ observed_at: now(), tools: ['Read', 'Edit', 'Write', 'Bash', 'load_guidance'], source: 'current_builtin_assembly', mcp_servers: [], limitations: ['本次本地测试仅有 /fixture 人工文件；无网络。'] }),
      selectWorkerImpl: requested => { if (requested && requested !== 'builtin') throw new Error('Only builtin is available'); return 'builtin' },
      assertWorkerImplReady: impl => { if (impl !== 'builtin') throw new Error('Only builtin is available') },
      workerImplSnapshot: () => ({ revision: 1, default_impl: 'builtin', preference: {}, statuses: ['builtin', 'claude-code', 'codex'].map(impl => ({ impl, enabled: impl === 'builtin', installed: impl === 'builtin', ready: impl === 'builtin', verification: impl === 'builtin' ? 'passed' : 'never' })), observed_at: now() }),
      readWorkerActivity: async ({ worker_id, incarnation_id, after, view }) => {
        const found = await stack.ledger.findWorker(worker_id)
        const incarnation = incarnation_id ? found.worker.incarnations.find(i => i.incarnation_id === incarnation_id) : found.worker.incarnations.at(-1)
        const id = incarnation.incarnation_id
        const cursor = after === undefined ? { offset: 0 } : cursors.get(after)
        if (!cursor || (cursor.worker_id && (cursor.worker_id !== worker_id || cursor.incarnation_id !== id))) throw new Error('Invalid fixture activity cursor')
        const trace = await stack.adapters.get('builtin').readTrace({ ...incarnation, worker_id }, { offset: cursor.offset })
        if (trace.unavailableReason) throw new Error(trace.unavailableReason)
        return { incarnation_id: id, activities: projectWorkerActivity(trace.events, view, { worker_id, incarnation_id: id }), next_cursor: mintCursor({ worker_id, incarnation_id: id, offset: trace.nextCursor.offset }) }
      },
      reportEpisodeFailure: error => { emit({ type: 'episode_failure', error }); fatal ??= 'episode-failure' },
    })
    await stack.ledger.init()
    await stack.principals.resolve(managerKey, { friend, sessionType: 'private' })
    await stack.store.save({ key: managerKey, recent: [createUserMessage('[历史中已收到的人类指令]\n' + c.history)], foldedCount: 0 })
    const worker = await stack.harness.spawnWorker({ managerKey, title: c.id, prompt: c.history,
      origin: { manager_key: managerKey, creator_friend_id: friend.id, trigger_type: 'message' },
      report_to: session, target_session: session, principal_permissions: permissions, impl: 'builtin',
    })
    const workerIdle = async () => (await stack.harness.listWorkers(managerKey)).every(w => w.incarnations.filter(i => i.forked_from === undefined).at(-1)?.state !== 'running')
    await waitUntil(async () => await workerIdle() && activeCalls === 0 && Date.now() - lastActivity > 300)
    if (c.role === 'manager') {
      seedMode = false; routing = true
      const turn = await stack.harness.getWorkerTurn(worker.worker_id)
      emit({ type: 'historical_seed', workerId: worker.worker_id, turn })
      await stack.registry.routeWorkerEvent({ ts: now(), kind: 'state_changed', worker_id: worker.worker_id, seq: 1, detail: { to: 'idle', text: c.seed, turn_pending: true } })
      await waitUntil(async () => await workerIdle() && activeCalls === 0 && !stack.registry.isEpisodeActive(managerKey)
        && (fatal || (!stack.registry.getOrCreate(managerKey).hasPendingMailbox && Date.now() - lastActivity > 600)))
    }
  } catch (error) { fatal ??= 'runtime-error'; emit({ type: 'runtime_error', error: String(error) }) }
  finally {
    stopped = true; routing = false; abort.abort()
    if (stack) await stack.dispose()
    try {
      if (before) {
        const after = await box.snapshot(), oracle = await box.verify(c)
        const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => JSON.stringify(before[name]) !== JSON.stringify(after[name]))
        emit({ type: 'end', fatal, requests, outbox, before, after, changed, oracle })
      }
    } finally { await box.close(); emit({ type: 'cleanup', container: box.name }) }
  }
  return events
}
