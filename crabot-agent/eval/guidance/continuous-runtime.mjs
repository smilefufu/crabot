import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { FixtureContainer, docker } from './docker-fixtures.mjs'
import { withDockerProjectDocs, installDockerProjectDocs } from './docker-project-docs.mjs'

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

// Actual selected-revision Manager/Harness/Builtin loop. Channel and memory are local transports.
// File and process tools always execute in the isolated container, never on the host.
export async function runContinuous({ c, sourceRoot, image, root, delegate, record, maxRequests, timeoutMs = 600000 }) {
  const require = createRequire(path.join(sourceRoot, 'crabot-agent/package.json'))
  const { buildManagerStack } = require('./dist/manager/bootstrap.js')
  const { createCrabMemoryServer } = require('./dist/mcp/crab-memory.js')
  const { createUserMessage, StreamProcessor } = require('./dist/engine/index.js')
  const { CLI_DOMAINS } = require('./dist/types.js')
  const { assembleBuiltinWorkerPrompt } = require('./dist/prompts/builtin-worker.js')
  const { createGuidanceTool } = require('./dist/guidance/catalog.js')
  const { projectWorkerActivity } = require('./dist/workers/trace/activity-projection.js')
  const { TraceStore } = require('./dist/core/trace-store.js')
  const { recordEngineLlmResponse, recordEngineToolLifecycle, recordSubAgentTurn } = require('./dist/engine/sub-agent-trace.js')

  installDockerProjectDocs(sourceRoot)
  const started = Date.now()

  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const box = new FixtureContainer(image)
  const instructionsModule = require('./dist/workers/harness/workspace-instructions.js')
  const originalCapture = instructionsModule.captureWorkspaceInstructions
  instructionsModule.captureWorkspaceInstructions = async params => {
    const result = JSON.parse(await docker(['exec', '-i', box.name, 'node', '/app/tool.cjs'], JSON.stringify({ workspaceInstructions: params })))
    if (result.text !== undefined) {
      const target = path.join(params.workersDir, params.workerId, 'workspace-instructions', `${params.incarnationId}.md`)
      if (!target.startsWith(root + path.sep)) throw new Error('Instruction artifact escaped fixture root')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, result.text, { mode: 0o600 })
    }
    return result
  }
  const managerKey = 'fixture::synthetic'
  const now = () => new Date().toISOString()
  const friend = { id: 'fixture-human', display_name: '评测用户', permission: 'master', channel_identities: [], created_at: now(), updated_at: now() }
  const permissions = {
    tool_access: { memory: true, messaging: true, task: true, mcp_skill: true, file_io: true, shell: true, browser: false, remote_exec: false, desktop: false, ...c.toolAccess },
    cli_access: Object.fromEntries(CLI_DOMAINS.map(d => [d, 'none'])),
    storage: { workspace_path: '/fixture', access: 'readwrite' }, memory_scopes: ['fixture'],
  }
  const session = { channel_id: 'fixture', session_id: 'synthetic', type: 'private' }
  let stack, before, seedMode = c.role === 'manager' && Boolean(c.seed), routing = false, requests = 0, activeCalls = 0
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
      const actual = { ...params, maxTokens: 2400,
        signal: AbortSignal.any([abort.signal, ...(params.signal ? [params.signal] : []), AbortSignal.timeout(90000)]),
      }
      const processor = new StreamProcessor()
      const requestStarted = Date.now()
      let firstChunkMs
      activeCalls++
      emit({ type: 'request', request, role, workerId, systemPrompt: actual.systemPrompt,
        messages: publicMessages(actual.messages), tools: actual.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
      try {
        for await (const chunk of delegate.stream(actual, { role, request, workerId })) { firstChunkMs ??= Date.now() - requestStarted; processor.process(chunk); yield chunk }
        const response = processor.finalize()
        emit({ type: 'response', request, role, workerId, elapsedMs: Date.now() - requestStarted, firstChunkMs, text: response.text, tools: response.toolUseBlocks, usage: response.usage, stopReason: response.stopReason })
      } catch (error) {
        if (error.code === 'EVAL_BUDGET') {
          fatal ??= 'request-budget'; stopped = true
          emit({ type: 'request_rejected', request, role, reason: 'global-budget' })
        } else {
          fatal ??= 'model-error'; stopped = true; abort.abort()
          emit({ type: 'error', request, role, error: String(error) })
        }
        throw error
      } finally { activeCalls-- }
    },
  })
  let childRunner, childRegistry, restoreChildAdapter
  if (c.reviewer) {
    const adapterModule = require('./dist/engine/llm-adapter.js')
    const originalFactory = adapterModule.createAdapter
    // Test-process transport only: child calls use the same budgeted, recorded Provider.
    adapterModule.createAdapter = () => adapterFor('reviewer')
    restoreChildAdapter = () => { adapterModule.createAdapter = originalFactory }
    childRegistry = new (require('./dist/engine/bg-entities/registry.js').BgEntityRegistry)(path.join(root, 'bg-registry.json'))
    childRunner = new (require('./dist/workers/builtin/subagent-runner.js').BuiltinSubagentRunner)(traces, {}, async (workerId, entityId) => {
      const text = await childRunner.renderCompletion(workerId, entityId)
      emit({ type: 'child_completion', workerId, entityId, text })
      await stack.harness.sendToWorker(workerId, text)
      const value = await childRegistry.get(entityId)
      await childRegistry.update(entityId, { exit_notification: { ...value.exit_notification, status: 'delivered' } })
    }, childRegistry)
  }
  const runningChildren = async workerId => childRunner ? (await childRunner.list(workerId)).some(c => c.status === 'running') : false
  const toolsFor = workerId => {
    const definitions = ['Read', 'Edit', 'Write', 'Bash'].map(name =>
      require(`./dist/engine/tools/${name.toLowerCase()}-tool.js`)[`create${name}Tool`](() => '/fixture'))
    definitions.push(createGuidanceTool('worker'))
    const wrapped = definitions.map(t => ({ ...t, async call(input) {
      const receipt = t.name === 'load_guidance'
        ? { result: await t.call(input) } : await box.call(t.name, input)
      emit({ type: 'executed_tool', workerId, name: t.name, input, receipt })
      return receipt.result
    } }))
    if (childRunner) wrapped.push(require('./dist/agent/delegate-task-tool.js').createDelegateTaskTool({
      subAgents: [{ id: 'fixture-reviewer', name: 'reviewer', description: '只读独立审查',
        when_to_use: '集成验证完成后，独立审查本次修改和验收证据。', role: '只读审查者，核对修改与任务要求，不修改文件。',
        workflow: '读取任务相关代码，核对行为与验证结果；必要时运行只读检查。', deliverables: '返回具体问题及依据；没有问题则说明已检查范围。',
        model: { model_id: 'qwen3.8-max', endpoint: 'eval://recorded-adapter', apikey: 'not-a-credential', format: 'openai' },
        builtin_capabilities: { file_system: true, shell: true, task_intel: false }, allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 8,
      }],
      runSubAgent: (config, input, ctx) => childRunner.run(config, input, ctx,
        wrapped.filter(t => ['Read', 'Bash'].includes(t.name)), {
          permissionConfig: { mode: 'bypass' }, resolvedPermissions: permissions, availableSkills: [], getCwd: () => '/fixture',
        }),
    }))
    return wrapped
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
    if (method === 'get_history') return { items: c.channelHistory ?? [{ platform_message_id: 'historical-human', sender: { friend_id: friend.id, platform_user_id: 'fixture-human', platform_display_name: friend.display_name }, content: { type: 'text', text: c.history }, features: { is_mention_crab: false }, platform_timestamp: now() }], pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 } }
    if (method === 'list_entries') return { entries: memory, pagination: { page: 1, page_size: 20, total_items: memory.length, total_pages: memory.length ? 1 : 0 } }
    if (method === 'search_short_term') return { results: [] }
    if (method === 'search_memory' || method === 'search_long_term') return { results: memory.filter(m => m.status === (params.status ?? 'confirmed')) }
    if (method === 'quick_capture') {
      const entry = { ...params, id: `local-memory-${memory.length + 1}`, body: params.content, status: 'inbox', inbox_entered_at: now() }
      memory.push(entry)
      fs.writeFileSync(path.join(root, 'memory-inbox.json'), JSON.stringify(memory, null, 2), { mode: 0o600 })
      return { id: entry.id, status: 'ok' }
    }
    if (method === 'get_scene_profile') return { profile: null }
    emit({ type: 'coverage_gap', boundary: 'memory-or-channel', method })
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
    before = await box.start({ ...c, files: c.files ?? {} })
    emit({ type: 'start', container: box.name, before })
    stack = buildManagerStack({
      dataRoot: root, now, timezone: () => 'Asia/Shanghai',
      managerAdapter: () => adapterFor('manager'), managerModel: () => 'qwen3.8-max',
      isClosing: () => !routing || stopped,
      messagingDeps: { rpcClient: localRpc, moduleId: 'fixture', getAdminPort: async () => 19001, resolveChannelPort: async () => 19009 },
      memoryServerFor: ctx => createCrabMemoryServer({ rpcClient: localRpc, moduleId: 'fixture', getMemoryPort: async () => 19100 }, ctx),
      callAdmin: async method => { emit({ type: 'coverage_gap', boundary: 'admin', method }); throw new Error(`Unsupported local admin call: ${method}`) },
      principalResolver: { resolvePermissions: async () => permissions, sessionMemoryScopes: async () => ['fixture'], sceneProfile: async () => null, crabSelfHandle: () => undefined, getFriend: async id => id === friend.id ? friend : null },
      capabilityBundle: async () => ({ skills: [], mcp_servers: [] }),
      hasRunningBg: runningChildren,
      builtinTraceHooks: {
        hasRunningBgEntities: runningChildren,
        stopWorkerSubagents: workerId => childRunner?.stopWorker(workerId),
        startIncarnationTrace: ({ summary }) => traces.startTrace({ module_id: 'fixture', trigger: { type: 'task', summary } }).trace_id,
        appendLlmResponse: (id, event) => recordEngineLlmResponse(traces, id, event, x => x),
        appendTurn: (id, event) => recordSubAgentTurn(traces, id, event, x => x),
        appendToolLifecycle: (id, event) => recordEngineToolLifecycle(traces, id, event, x => x),
        finishIncarnationTrace: (id, patch) => traces.endTrace(id, patch.status, { summary: patch.summary }),
      },
      builtinTraceReader: { readTrace: id => traces.getFullTrace(id), listSubagents: id => childRunner?.list(id) ?? [], getSubagent: (id, child) => childRunner?.get(id, child), readSubagentTrace: (id, child, cursor) => childRunner?.readTrace(id, child, cursor) },
      mintActivityCursor: async position => mintCursor(position),
      builtinSpawnDefaults: ctx => ({
        adapter: adapterFor('worker', ctx.worker_id), model: 'qwen3.8-max', maxTokens: 2400, maxTurnsPerBurst: 12,
        systemPrompt: assembleBuiltinWorkerPrompt({ workspaceRoot: '/fixture', imageAvailable: false }),
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
    // Move only filesystem transport across namespaces. Validation and Git parsing
    // run their production implementations in Docker; Harness permissions stay in place.
    stack.workspaces.resolve = async (taskId, requested) => {
      if (requested !== undefined && requested !== '/fixture') throw new Error(`Fixture workspace unavailable: ${requested}`)
      return JSON.parse(await docker(['exec', '-i', box.name, 'node', '/app/tool.cjs'], JSON.stringify({ workspaceResolve: { taskId } })))
    }
    stack.harness.gitInspector.inspect = async (_workspace, baseline) =>
      JSON.parse(await docker(['exec', '-i', box.name, 'node', '/app/tool.cjs'], JSON.stringify({ workspaceGit: { baseline } })))
    await stack.ledger.init()
    await stack.principalBindings.init()
    await stack.principals.resolve(managerKey, { friend, sessionType: 'private' })
    await stack.store.save({ key: managerKey, recent: c.trigger === 'human' ? [] : [createUserMessage('[历史中已收到的人类指令]\n' + (c.seedHistory ?? c.history))], foldedCount: 0 })
    if (c.board) {
      const objective = await stack.workboard.createObjective(managerKey, c.board.objective)
      for (const item of c.board.items) await stack.workboard.createWorkItem(managerKey, objective.value.objective_id, item)
    }
    const boardBefore = await stack.workboard.load(managerKey)
    emit({ type: 'board_before', board: boardBefore })
    const worker = c.role === 'worker' || c.seed ? await stack.harness.spawnWorker({ managerKey, title: c.id, prompt: c.seedHistory ?? c.history,
      origin: { manager_key: managerKey, creator_friend_id: friend.id, trigger_type: 'message' },
      report_to: session, target_session: session, principal_permissions: permissions, impl: 'builtin',
    }) : undefined
    const workerIdle = async () => (await stack.harness.listWorkers(managerKey)).every(w => w.incarnations.every(i => i.state !== 'running'))
    await waitUntil(async () => await workerIdle() && activeCalls === 0 && Date.now() - lastActivity > 300)
    if (c.role === 'manager') {
      seedMode = false; routing = true
      await withDockerProjectDocs(box, emit, async () => {
        if (c.trigger === 'idle') {
          // Invoke the scheduler's production wake boundary after fixture setup. The one-hour timer itself is not under test.
          const envelope = stack.registry.makeEnvelope(stack.registry.captureIngress(), { kind: 'workboard_idle_review' })
          emit({ type: 'wake', kind: envelope.wake.kind })
          await stack.registry.runWake(managerKey, envelope)
        } else if (c.trigger === 'human' || c.trigger === 'human_after_seed') {
          await stack.registry.routeHumanMessages(session.channel_id, session.session_id, [{
            id: 'fixture-current-message', session, sender: { friend_id: friend.id, platform_user_id: 'fixture-human', platform_display_name: friend.display_name },
            content: { type: 'text', text: c.history }, features: { is_mention_crab: false }, platform_timestamp: now(),
          }], friend)
        } else {
          const turn = await stack.harness.getWorkerTurn(worker.worker_id)
          emit({ type: 'historical_seed', workerId: worker.worker_id, turn })
          await stack.registry.routeWorkerEvent({ ts: now(), kind: 'state_changed', worker_id: worker.worker_id, seq: 1,
            detail: { to: 'idle', text: c.seed, turn_pending: true } })
        }
      })
      await waitUntil(async () => await workerIdle() && activeCalls === 0 && !stack.registry.isEpisodeActive(managerKey)
        && (fatal || (!stack.registry.getOrCreate(managerKey).hasPendingMailbox && Date.now() - lastActivity > 600)))
    }
  } catch (error) { fatal ??= 'runtime-error'; emit({ type: 'runtime_error', error: String(error) }) }
  finally {
    stopped = true; routing = false; abort.abort()
    if (stack) {
      emit({ type: 'board_after', board: await stack.workboard.load(managerKey) })
      emit({ type: 'workers_after', workers: await stack.harness.listWorkers(managerKey) })
    }
    if (stack) await stack.dispose()
    restoreChildAdapter?.()
    instructionsModule.captureWorkspaceInstructions = originalCapture
    try {
      if (before) {
        const after = await box.snapshot(), oracle = await box.verify(c)
        const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => JSON.stringify(before[name]) !== JSON.stringify(after[name]))
        emit({ type: 'end', fatal, requests, elapsedMs: Date.now() - started, outbox, memory, before, after, changed, oracle })
      }
    } finally { await box.close(); emit({ type: 'cleanup', container: box.name }) }
  }
  return events
}
