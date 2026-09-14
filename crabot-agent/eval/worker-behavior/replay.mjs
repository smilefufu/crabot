import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { buildCases, sanitize } from './cases.mjs'

const repo = path.resolve(import.meta.dirname, '../../..')
const runtime = process.env.REPLAY_RUNTIME_ROOT
const data = process.env.REPLAY_DATA_DIR
const output = process.env.REPLAY_OUTPUT_DIR
assert(runtime && data && output, 'REPLAY_RUNTIME_ROOT, REPLAY_DATA_DIR and REPLAY_OUTPUT_DIR required')
const runtimeRequire = createRequire(path.join(runtime, 'crabot-agent/package.json'))
const ts = runtimeRequire('typescript')
const { OpenAIAdapter } = runtimeRequire('./dist/engine/openai-adapter.js')
const { StreamProcessor } = runtimeRequire('./dist/engine/stream-processor.js')
const { thinkingParam } = runtimeRequire('./dist/engine/llm-adapter-types.js')
const adminRequire = createRequire(path.join(runtime, 'crabot-admin/package.json'))
const { ModelProviderManager } = adminRequire('./dist/model-provider-manager.js')
const hash = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex')
const file = name => path.join(output, name)
const save = (name, x) => fs.writeFileSync(file(name), JSON.stringify(x, null, 2) + '\n', { flag: 'wx', mode: 0o600 })

function loadPrompt(relative, variant, cache = new Map()) {
  if (cache.has(relative)) return cache.get(relative)
  const source = variant === 'baseline'
    ? execFileSync('git', ['show', `HEAD:${relative}`], { cwd: repo, encoding: 'utf8' })
    : fs.readFileSync(path.join(repo, relative), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  cache.set(relative, module.exports)
  const require = request => request.startsWith('.')
    ? loadPrompt(path.posix.join(path.posix.dirname(relative), request.replace(/\.js$/, '.ts')), variant, cache)
    : runtimeRequire(request)
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {})(require, module, module.exports)
  return module.exports
}

const agents = [
  { name: 'research_collector', description: '调查并返回证据', when_to_use: '需要独立资料调查时' },
  { name: 'code_planner', description: '规划实现', when_to_use: '存在实质设计取舍时' },
  { name: 'code_writer', description: '实现已明确的子任务', when_to_use: '需要委派实现时' },
  { name: 'task_reviewer', description: '独立审查结果', when_to_use: '需要独立审查时' },
]
const never = async () => { throw new Error('Replay must not execute real tools') }
function workerTools(cwd) {
  const definitions = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'].map(name => {
    const factory = runtimeRequire(`./dist/engine/tools/${name.toLowerCase()}-tool.js`)[`create${name}Tool`]
    return factory(() => cwd)
  })
  for (const name of ['Output', 'ListEntities', 'Kill']) {
    const stem = name === 'ListEntities' ? 'list-entities' : name.toLowerCase()
    definitions.push(runtimeRequire(`./dist/engine/tools/${stem}-tool.js`)[`create${name}Tool`]({}))
  }
  definitions.push(runtimeRequire('./dist/agent/delegate-task-tool.js').createDelegateTaskTool({ subAgents: agents, runSubAgent: never }))
  definitions.push({ name: 'finish_task', description: '完成或确认失败时结束任务；有后台工作时先等待其收口。',
    inputSchema: { type: 'object', properties: { outcome: { type: 'string', enum: ['completed', 'failed'] }, summary: { type: 'string' } }, required: ['outcome', 'summary'] } })
  return definitions.map(t => ({ ...t, call: never }))
}
function managerTools(variant) {
  const managerKey = 'bot-2::2eais6e9'
  const deps = { rpcClient: { call: never }, moduleId: 'replay', getMemoryPort: never }
  const memoryServer = runtimeRequire('./dist/mcp/crab-memory.js').createCrabMemoryServer(deps,
    { visibility: 'private', scopes: [], isMasterPrivate: false })
  const defs = runtimeRequire('./dist/manager/tools/tool-face.js').buildManagerToolFace({
    harness: {}, workerContext: () => ({ managerKey }),
    messagingDeps: { ...deps, getAdminPort: never, resolveChannelPort: never },
    memoryServer, callAdmin: never, isSystemThread: false,
    managerTarget: { channel_id: 'bot-2', session_id: '2eais6e9' },
    workboard: { store: {}, managerKey }, projectDocs: {},
  })
  const relative = 'crabot-agent/src/manager/tools/worker-tools.ts'
  const source = variant === 'baseline'
    ? execFileSync('git', ['show', `HEAD:${relative}`], { cwd: repo, encoding: 'utf8' })
    : fs.readFileSync(path.join(repo, relative), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  const require = createRequire(path.join(runtime, 'crabot-agent/dist/manager/tools/worker-tools.js'))
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {})(require, module, module.exports)
  const workerDefs = module.exports.buildWorkerTools({ context: () => ({ managerKey }), harness: {} })
  return defs.map(t => ({ ...(workerDefs.find(w => w.name === t.name) ?? t), call: never }))
}

async function connection() {
  const config = JSON.parse(fs.readFileSync(path.join(data, 'admin/agent-configs/crabot-agent.json'), 'utf8'))
  const ref = config.model_config.powerful
  const manager = new ModelProviderManager(path.join(data, 'admin'))
  await manager.initialize()
  const conn = await manager.buildConnectionInfo(ref.provider_id, ref.model_id)
  assert.equal(conn.format, 'openai')
  const cfg = config.thinking?.powerful ?? {}
  const thinking = thinkingParam(cfg.thinking_level, cfg.thinking_custom)
  return { ...conn, thinking }
}

function prepare(managerOnly = false, variants = ['baseline', 'candidate'], ids) {
  fs.mkdirSync(output, { recursive: true })
  const allCases = buildCases(data)
  assert.equal(allCases.filter(c => c.role === 'worker').length, 12)
  const cases = allCases.filter(c => (!managerOnly || c.role === 'manager') && (!ids || ids.includes(c.id)))
  assert(cases.length > 0, 'Select at least one case')
  if (ids) assert.equal(cases.length, ids.length, 'Unknown or duplicate selected case')
  const conditions = []
  for (const c of cases) for (const variant of variants) {
    const prompt = c.role === 'worker'
      ? loadPrompt('crabot-agent/src/prompts/builtin-worker.ts', variant).assembleBuiltinWorkerPrompt({ workspaceRoot: c.workspace, imageAvailable: false,
        availableSubAgents: agents.map(a => ({ toolName: a.name, workerHint: a.when_to_use })) })
      : loadPrompt('crabot-agent/src/manager/prompt.ts', variant).assembleManagerSystemPrompt({ managerKey: 'bot-2::2eais6e9', isSystemThread: false })
    const tools = (c.role === 'worker' ? workerTools(c.workspace) : managerTools(variant)).map(({ name, description, inputSchema, isReadOnly }) => ({ name, description, inputSchema, isReadOnly }))
    conditions.push({ case_id: c.id, variant, prompt, messages: c.messages, tools })
  }
  save('cases.json', cases)
  save('conditions.json', conditions)
  const order = cases.flatMap((c, i) => [1, 2].flatMap(repetition => ((i + repetition) % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']).filter(v => variants.includes(v))
    .map(variant => ({ id: `${c.id}-${variant}-${repetition}`, case_id: c.id, variant, repetition }))))
  save('plan.json', { baseline_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    period: ['2026-09-09T16:00:00Z', '2026-09-12T15:45:58Z'], mode: 'single_decision_historical_fragments_and_counterfactuals',
    conditions_hash: hash(conditions), order, max_attempts: 1, real_tool_executions: 0,
    manager_tool_face: 'production full builtin definitions; every call replaced by never',
    scoring: 'Semantic manual review against held-out case criteria. No forced tool, refusal-rate, word-count or test-count pass metric. Missing samples remain missing.' })
  console.log(JSON.stringify({ prepared: cases.length, samples: order.length, conditions_hash: hash(conditions) }))
}

function prepareContinuations() {
  fs.mkdirSync(output, { recursive: true })
  const spec = JSON.parse(fs.readFileSync(file('continuations.json'), 'utf8'))
  const conditions = []
  const order = []
  for (const job of spec.jobs) {
    const previous = path.resolve(output, job.previous_output)
    const results = fs.readFileSync(path.join(previous, 'results.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    const result = results.find(r => r.kind === 'result' && r.id === job.previous_id)
    assert.equal(result?.status, 'response', `Missing previous response: ${job.previous_id}`)
    assert(['tool_use', 'end_turn'].includes(result.response.stopReason), `Incomplete previous response: ${job.previous_id}`)
    const oldConditions = JSON.parse(fs.readFileSync(path.join(previous, 'conditions.json'), 'utf8'))
    const old = oldConditions.find(c => c.case_id === result.case_id && c.variant === result.variant)
    const calls = result.response.toolUseBlocks
    assert.deepEqual((job.receipts ?? []).map(r => r.tool_use_id).sort(), calls.map(c => c.id).sort(), 'Every emitted tool needs its own reviewed receipt')
    assert(calls.length || job.events?.length, 'An ended turn requires an explicit simulated external event')
    assert(job.rationale && spec.mode === 'synthetic_tool_receipts', 'Do not present simulated receipts as historical evidence')
    const tools = spec.refresh_candidate_manager_tools && result.variant === 'candidate'
      ? managerTools('candidate').map(({ name, description, inputSchema, isReadOnly }) => ({ name, description, inputSchema, isReadOnly }))
      : old.tools
    const prompt = spec.refresh_candidate_worker_prompt && result.variant === 'candidate'
      ? loadPrompt('crabot-agent/src/prompts/builtin-worker.ts', 'candidate').assembleBuiltinWorkerPrompt({
        workspaceRoot: spec.workspace, imageAvailable: false, availableSubAgents: agents.map(a => ({ toolName: a.name, workerHint: a.when_to_use })) })
      : spec.refresh_candidate_manager_tools && result.variant === 'candidate'
      ? loadPrompt('crabot-agent/src/manager/prompt.ts', 'candidate').assembleManagerSystemPrompt({ managerKey: 'bot-2::2eais6e9', isSystemThread: false })
      : old.prompt
    conditions.push({ ...old, tools, prompt, case_id: job.id, messages: [...old.messages,
      { role: 'assistant', content: [...(result.response.text ? [{ type: 'text', text: result.response.text }] : []), ...calls] },
      ...(calls.length ? [{ role: 'user', toolResults: job.receipts }] : []),
      ...(job.events ?? []),
    ] })
    order.push({ id: job.id, case_id: job.id, variant: result.variant, repetition: result.repetition })
  }
  save('conditions.json', conditions)
  save('plan.json', { mode: spec.mode, conditions_hash: hash(conditions), order, max_attempts: 1, real_tool_executions: 0,
    scoring: 'Review emitted operations and subsequent claims against explicitly simulated state. Unsupported branches stop; no production-completion claim.' })
  console.log(JSON.stringify({ prepared_continuations: order.length, conditions_hash: hash(conditions) }))
}

function audit() {
  const plan = JSON.parse(fs.readFileSync(file('plan.json'), 'utf8'))
  const conditions = JSON.parse(fs.readFileSync(file('conditions.json'), 'utf8'))
  assert.equal(hash(conditions), plan.conditions_hash)
  const rows = fs.readFileSync(file('results.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  const slots = plan.order.map(slot => {
    const starts = rows.filter(r => r.id === slot.id && r.kind === 'started')
    const results = rows.filter(r => r.id === slot.id && r.kind === 'result')
    assert(starts.length <= 1 && results.length <= 1, `Unexpected retry/duplicate: ${slot.id}`)
    const r = results[0]
    const complete = r?.status === 'response' && ['tool_use', 'end_turn'].includes(r.response?.stopReason)
    return { ...slot, observation: complete ? 'response_requires_semantic_review' : r?.status === 'response' ? 'incomplete_response' : 'missing',
      ...(r?.error ? { error: r.error } : {}), ...(r?.response ? { stop_reason: r.response.stopReason } : {}),
      ...(!r ? { error: starts.length ? 'process_ended_before_result_was_persisted' : 'not_started' } : {}) }
  })
  assert(rows.every(r => plan.order.some(s => s.id === r.id)), 'Unexpected sample outside plan')
  save('audit.json', { planned: slots.length, observed: slots.filter(s => s.observation === 'response_requires_semantic_review').length,
    missing: slots.filter(s => s.observation === 'missing').length, incomplete: slots.filter(s => s.observation === 'incomplete_response').length,
    real_tool_executions: 0, quality_passes: null, note: 'Completed responses are observations, not passes. Semantic review and malformed tool arguments remain separate.', slots })
  console.log(JSON.stringify({ audited: slots.length, missing: slots.filter(s => s.observation === 'missing').map(s => s.id) }))
}

async function generate(condition, conn) {
  const processor = new StreamProcessor()
  const adapter = new OpenAIAdapter({ endpoint: conn.endpoint, apikey: conn.apikey })
  const started = Date.now()
  let chunks = 0
  try {
    for await (const chunk of adapter.stream({ model: conn.model_id, systemPrompt: condition.prompt,
      messages: condition.messages, tools: condition.tools.map(t => ({ ...t, call: never })),
      thinking: conn.thinking, maxTokens: 6000, signal: AbortSignal.timeout(180000) })) {
      chunks++
      processor.process(chunk)
      if (chunk.type === 'error') throw new Error(chunk.error)
    }
    return { status: 'response', elapsed_ms: Date.now() - started, chunks, response: sanitize(processor.finalize()) }
  } catch (err) {
    return { status: 'missing', elapsed_ms: Date.now() - started, chunks, error: String(err.message).replaceAll(conn.apikey, '[REDACTED]') }
  }
}

async function run() {
  const plan = JSON.parse(fs.readFileSync(file('plan.json'), 'utf8'))
  const conditions = JSON.parse(fs.readFileSync(file('conditions.json'), 'utf8'))
  assert.equal(hash(conditions), plan.conditions_hash)
  const conn = await connection()
  const { apikey, ...publicConnection } = conn
  if (!fs.existsSync(file('connection.json'))) save('connection.json', publicConnection)
  const rows = fs.existsSync(file('results.jsonl')) ? fs.readFileSync(file('results.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  const startedIds = new Set(rows.map(r => r.id))
  const pending = plan.order.filter(s => !startedIds.has(s.id))
  let index = 0
  async function worker() {
    while (index < pending.length) {
      const sample = pending[index++]
      const condition = conditions.find(c => c.case_id === sample.case_id && c.variant === sample.variant)
      const log = x => fs.appendFileSync(file('results.jsonl'), JSON.stringify(x) + '\n', { mode: 0o600 })
      log({ kind: 'started', ...sample, at: new Date().toISOString() })
      console.log(JSON.stringify({ started: sample.id }))
      const result = await generate(condition, conn)
      log({ kind: 'result', ...sample, ...result })
      console.log(JSON.stringify({ finished: sample.id, status: result.status, ms: result.elapsed_ms }))
    }
  }
  await Promise.all([worker(), worker()])
}

if (process.argv[2] === 'prepare') prepare()
else if (process.argv[2] === 'prepare-candidate') prepare(false, ['candidate'])
else if (process.argv[2] === 'prepare-selected') prepare(false, ['candidate'], process.argv.slice(3))
else if (process.argv[2] === 'prepare-manager') prepare(true)
else if (process.argv[2] === 'prepare-continuations') prepareContinuations()
else if (process.argv[2] === 'audit') audit()
else if (process.argv[2] === 'run') await run()
else throw new Error('Use prepare, prepare-candidate, prepare-manager, prepare-selected, prepare-continuations, run or audit')
