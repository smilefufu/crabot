import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { boundaryCases } from './boundary-cases.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(root, 'crabot-agent/package.json'))
const never = async () => { throw new Error('Business tools are never executed in this decision probe') }
const sha = value => createHash('sha256').update(value).digest('hex')

export function assembly(sourceRoot, c) {
  const req = createRequire(path.join(sourceRoot, 'crabot-agent/package.json'))
  const { createGuidanceTool, renderGuidance } = req('./dist/guidance/catalog.js')
  let tools, prompt, guide
  if (c.role === 'manager') {
    const { buildManagerToolFace } = req('./dist/manager/tools/tool-face.js')
    const { createCrabMemoryServer } = req('./dist/mcp/crab-memory.js')
    const transport = { rpcClient: { call: never }, moduleId: 'fixture', getMemoryPort: never }
    const face = buildManagerToolFace({ harness: {}, workerContext: () => ({ managerKey: 'fixture::synthetic' }),
      messagingDeps: { ...transport, getAdminPort: never, resolveChannelPort: never },
      memoryServer: createCrabMemoryServer(transport, { visibility: 'private', scopes: [], isMasterPrivate: false }),
      callAdmin: never, isSystemThread: false, managerTarget: { channel_id: 'fixture', session_id: 'synthetic' },
      workboard: { store: {}, managerKey: 'fixture::synthetic' }, projectDocs: {},
    })
    const names = new Set(['load_guidance', 'get_execution_capabilities', 'send_message', 'get_history',
      'inspect_workboard', 'change_workboard', 'spawn_worker', 'send_to_worker', 'query_worker', 'get_worker_state',
      'get_worker_turn', 'get_worker_activity', 'resolve_worker_turn', 'request_worker_stop', 'list_workers', 'inspect_project_docs'])
    tools = face.filter(t => names.has(t.name))
    prompt = req('./dist/manager/prompt.js').assembleManagerSystemPrompt({ managerKey: 'fixture::synthetic', isSystemThread: false })
    const name = c.wake && req('./dist/manager/loop.js').automaticGuidanceForWake(c.wake)
    guide = name ? renderGuidance('manager', name) : undefined
  } else {
    prompt = req('./dist/prompts/builtin-worker.js').assembleBuiltinWorkerPrompt({ workspaceRoot: '/fixture', imageAvailable: false })
    tools = [...['Read', 'Edit', 'Write', 'Bash'].map(name => req(`./dist/engine/tools/${name.toLowerCase()}-tool.js`)[`create${name}Tool`](() => '/fixture')), createGuidanceTool('worker')]
  }
  return { prompt, guide, tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    guides: Object.fromEntries(req('./dist/guidance/catalog.js').guidanceNames(c.role).map(name => [name, renderGuidance(c.role, name)])) }
}

export async function runProbe({ c, condition, adapter, model, maxRounds = 4, record }) {
  const { StreamProcessor, createUserMessage, createAssistantMessage, createToolResultMessage } = require('./dist/engine/index.js')
  const messages = [...(condition.guide ? [createUserMessage(condition.guide)] : []), createUserMessage(c.user)]
  const tools = condition.tools.map(t => ({ ...t, call: never }))
  for (let round = 1; round <= maxRounds; round++) {
    record({ type: 'request', round, systemHash: sha(condition.prompt), messages: messages.map(m => ({ ...m,
      content: Array.isArray(m.content) ? m.content.filter(b => b.type !== 'raw_reasoning') : m.content,
    })) })
    const processor = new StreamProcessor()
    try {
      for await (const chunk of adapter.stream({ systemPrompt: condition.prompt, messages, tools, model,
        maxTokens: 2200, signal: AbortSignal.timeout(90000) })) processor.process(chunk)
    } catch (error) { record({ type: 'error', round, error: String(error) }); return { status: 'request_error', rounds: round } }
    const response = processor.finalize()
    const calls = response.toolUseBlocks
    record({ type: 'response', round, text: response.text, tools: calls, usage: response.usage, stopReason: response.stopReason })
    if (response.stopReason === 'max_tokens') return { status: 'truncated', rounds: round }
    if (!calls.length) return { status: response.text.trim() ? 'internal_end' : 'empty_end', rounds: round }
    if (calls.some(t => !tools.some(d => d.name === t.name))) return { status: 'invalid_tool', rounds: round }
    // Observe the entire first business decision; do not fake successful actions or continue from them.
    if (calls.some(t => t.name !== 'load_guidance')) return { status: 'action_observed', rounds: round }
    messages.push(createAssistantMessage([
      ...response.reasoningBlocks, ...(response.text ? [{ type: 'text', text: response.text }] : []), ...calls,
    ], response.stopReason, response.usage))
    for (const call of calls) {
      const output = condition.guides[call.input?.name]
      if (!output || Object.keys(call.input).length !== 1) return { status: 'invalid_guidance', rounds: round }
      record({ type: 'guidance_read', round, name: call.input.name })
      messages.push(createToolResultMessage(call.id, output, false))
    }
  }
  return { status: 'round_limit', rounds: maxRounds }
}

async function main() {
  const out = process.env.GUIDANCE_OUTPUT, baselineRoot = process.env.GUIDANCE_BASELINE_ROOT
  if (!out || !baselineRoot) throw new Error('GUIDANCE_OUTPUT and GUIDANCE_BASELINE_ROOT required')
  const plan = { version: 1, endpoint: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max',
    maxRounds: 4, maxRequests: boundaryCases.length * 2 * 4, stopNewRequestsAtReportedTokens: 500000,
    scope: 'Artificial decision probes only; no private history, business files, real Worker, tool side effects, channel delivery or extra model judge. No retries or replacement samples.',
    scripts: Object.fromEntries(['boundary-cases.mjs', 'boundary-probe.mjs'].map(f => [f, sha(fs.readFileSync(path.join(import.meta.dirname, f)))])),
    conditions: boundaryCases.flatMap((c, i) => (i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']).map(variant =>
      ({ id: `${c.id}/${variant}`, variant, c, ...assembly(variant === 'baseline' ? baselineRoot : root, c) }))),
  }
  const frozen = JSON.stringify({ ...plan, sha256: sha(JSON.stringify(plan)) }, null, 2)
  fs.mkdirSync(out, { recursive: true, mode: 0o700 })
  const inputPath = path.join(out, 'inputs.json')
  if (fs.existsSync(inputPath)) {
    if (fs.readFileSync(inputPath, 'utf8') !== frozen) throw new Error('Frozen inputs changed')
  } else fs.writeFileSync(inputPath, frozen, { flag: 'wx', mode: 0o600 })
  if (process.argv.includes('--prepare')) { console.log(JSON.stringify({ out, trajectories: plan.conditions.length, maxRequests: plan.maxRequests, sha256: sha(JSON.stringify(plan)) })); return }
  if (fs.existsSync(path.join(out, 'events.jsonl'))) throw new Error('Refusing to overwrite existing run')
  const admin = createRequire(path.join(process.env.REPLAY_RUNTIME_ROOT, 'crabot-admin/package.json'))
  const resolver = new (admin('./dist/model-provider-manager.js').ModelProviderManager)(path.join(process.env.REPLAY_DATA_DIR, 'admin'))
  await resolver.initialize()
  const providers = resolver.listProviders().filter(p => p.endpoint === plan.endpoint && p.format === 'openai' && p.models.some(m => m.model_id === plan.model))
  if (providers.length !== 1) throw new Error('Frozen destination unavailable or ambiguous')
  const conn = await resolver.buildConnectionInfo(providers[0].id, plan.model)
  if (conn.endpoint !== plan.endpoint || conn.model_id !== plan.model || conn.format !== 'openai') throw new Error('Destination changed')
  const live = require('./dist/engine/llm-adapter.js').createAdapter({ endpoint: conn.endpoint, apikey: conn.apikey, format: conn.format })
  let requests = 0, totalTokens = 0
  const results = []
  const record = row => fs.appendFileSync(path.join(out, 'events.jsonl'), JSON.stringify(row).replaceAll(conn.apikey, '[REDACTED]') + '\n', { mode: 0o600 })
  for (const condition of plan.conditions) {
    if (requests >= plan.maxRequests || totalTokens >= plan.stopNewRequestsAtReportedTokens) { results.push({ id: condition.id, status: 'budget_not_started' }); continue }
    const rows = []
    const result = await runProbe({ c: condition.c, condition, model: plan.model,
      adapter: { stream(params) {
        if (requests >= plan.maxRequests || totalTokens >= plan.stopNewRequestsAtReportedTokens) throw new Error('EVAL_BUDGET')
        requests++; return live.stream(params)
      } },
      record(row) {
        if (row.type === 'response') totalTokens += (row.usage?.inputTokens ?? 0) + (row.usage?.cacheReadTokens ?? 0) + (row.usage?.outputTokens ?? 0)
        rows.push(row); record({ id: condition.id, ...row })
      },
    })
    const value = { id: condition.id, ...result, responses: rows.filter(r => r.type === 'response'), reads: rows.filter(r => r.type === 'guidance_read') }
    results.push(value); record({ type: 'end', ...value })
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ requests, totalTokens, results }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ id: condition.id, ...result, requests, totalTokens }))
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ requests, totalTokens, results }, null, 2), { mode: 0o600 })
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await main()
