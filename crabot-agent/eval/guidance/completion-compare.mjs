import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { completionCases, completionFacts } from './completion-cases.mjs'
import { runHistory } from './history-runtime.mjs'
import { docker } from './docker-fixtures.mjs'

const out = process.env.GUIDANCE_OUTPUT
if (!out || !process.env.GUIDANCE_FROZEN) throw new Error('GUIDANCE_OUTPUT and GUIDANCE_FROZEN required')
const root = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(root, 'crabot-agent/package.json'))
const baseline = JSON.parse(fs.readFileSync(process.env.GUIDANCE_FROZEN, 'utf8')).baseline
const sha = value => createHash('sha256').update(value).digest('hex')
const image = (await docker(['image', 'inspect', 'crabot-guidance-tools:local', '--format', '{{.Id}}'])).trim()
const conditions = completionCases.flatMap(c => [1, 2].flatMap(repeat =>
  (repeat === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline']).map(variant => ({
    id: `${c.id}/${variant}/${repeat}`, caseId: c.id, repeat, variant, maxRequests: c.role === 'manager' ? 24 : 12,
  }))))
function hashes(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true }).filter(name => fs.statSync(path.join(directory, name)).isFile())
    .sort().map(name => [name, sha(fs.readFileSync(path.join(directory, name)))]))
}
const plan = {
  baselineSource: '739b50e0', sourceTree: execFileSync('git', ['rev-parse', 'HEAD:crabot-agent/src'], { cwd: root, encoding: 'utf8' }).trim(),
  baseline, cases: completionCases, conditions, image,
  candidate: {
    manager: require('./dist/manager/prompt.js').assembleManagerSystemPrompt({ managerKey: 'fixture::synthetic', isSystemThread: false }),
    worker: require('./dist/prompts/builtin-worker.js').assembleBuiltinWorkerPrompt({ workspaceRoot: '/fixture', imageAvailable: false }),
  },
  scripts: Object.fromEntries(['completion-cases.mjs', 'completion-compare.mjs', 'history-runtime.mjs', 'docker-project-docs.mjs', 'docker-fixtures.mjs', 'docker-tool-entry.mjs']
    .map(name => [name, sha(fs.readFileSync(path.join(import.meta.dirname, name)))])),
  compiled: hashes(path.resolve(import.meta.dirname, '../../dist')),
  endpoint: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max',
  maxTokens: 2400, maxRequests: conditions.reduce((sum, c) => sum + c.maxRequests, 0),
  stopNewRequestsAtReportedTokens: 2000000, requestTimeoutMs: 90000, waitTimeoutMs: 600000, retries: 0,
  scope: '32 full-task trajectories, 8 artificial cases, two repetitions per variant. Native Manager/Harness/Builtin loops and real Docker tools. In Manager cases downstream Worker prompt remains identical; Worker cases vary Worker prompt only. Same current product tools in both arms. Manager project-document tools use production implementation and persisted authorization data inside the container namespace. Channels are a local outbox; memory capture is a local inbox, not a real Memory service. No private conversations, business data, host mounts, container network, real channel sends, production changes, deployment, or extra model judge. Only existing endpoint/model credentials used for normal authentication.',
  assessment: 'Independent artifacts and unchanged source files plus hidden-label semantic self-review. Complete requires correct full output, prescribed checks, boundary compliance, and actual Manager outbox delivery / Worker result. Text-only cases need correct response; no-operation case forbids file/Shell calls. Runtime coverage gaps, response truncation, provider failures and budgets are separate, never resampled. Development-case evidence does not prove a population non-inferiority margin.',
}
const hash = sha(JSON.stringify(plan)), prepared = JSON.stringify({ ...plan, sha256: hash }, null, 2)
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const inputPath = path.join(out, 'inputs.json')
if (fs.existsSync(inputPath)) { if (fs.readFileSync(inputPath, 'utf8') !== prepared) throw new Error('Prepared plan changed') }
else fs.writeFileSync(inputPath, prepared, { flag: 'wx', mode: 0o600 })
if (process.argv.includes('--prepare')) { console.log(JSON.stringify({ out, hash, image, trajectories: conditions.length, maxRequests: plan.maxRequests })); process.exit() }
if (fs.existsSync(path.join(out, 'events.jsonl'))) throw new Error('Refusing to overwrite existing results')
const adminRequire = createRequire(path.join(process.env.REPLAY_RUNTIME_ROOT, 'crabot-admin/package.json'))
const { ModelProviderManager } = adminRequire('./dist/model-provider-manager.js')
const resolver = new ModelProviderManager(path.join(process.env.REPLAY_DATA_DIR, 'admin'))
await resolver.initialize()
const providers = resolver.listProviders().filter(p => p.endpoint === plan.endpoint && p.format === 'openai' && p.models.some(m => m.model_id === plan.model))
if (providers.length !== 1) throw new Error('Frozen provider/model is not uniquely configured')
const conn = await resolver.buildConnectionInfo(providers[0].id, plan.model)
if (conn.endpoint !== plan.endpoint || conn.model_id !== plan.model || conn.format !== 'openai') throw new Error('Provider changed')
const live = require('./dist/engine/llm-adapter.js').createAdapter({ endpoint: conn.endpoint, apikey: conn.apikey, format: conn.format })
const journal = fs.openSync(path.join(out, 'events.jsonl'), 'ax', 0o600)
const results = [], reviews = [], mapping = []
let requests = 0, reportedTokens = 0, stopReason
const record = row => { fs.writeSync(journal, JSON.stringify(row).replaceAll(conn.apikey, '[REDACTED]') + '\n'); fs.fsyncSync(journal) }
try {
  record({ type: 'plan', hash, maxRequests: plan.maxRequests, image })
  for (const condition of conditions) {
    if (stopReason) { results.push({ id: condition.id, status: `not_started_after_${stopReason}` }); continue }
    const c = completionCases.find(c => c.id === condition.caseId)
    const rows = await runHistory({ c, variant: condition.variant, image, root: path.join(out, 'runtime', condition.id),
      baseline, maxRequests: condition.maxRequests, timeoutMs: plan.waitTimeoutMs,
      delegate: { stream(params) {
        if (requests >= plan.maxRequests || reportedTokens >= plan.stopNewRequestsAtReportedTokens)
          throw Object.assign(new Error('Frozen total request/token budget exhausted'), { code: 'EVAL_BUDGET' })
        record({ type: 'provider_request', id: condition.id, number: ++requests })
        return live.stream(params)
      } },
      record(row) {
        if (row.type === 'response') {
          if (!row.usage) stopReason ??= 'missing_usage'
          reportedTokens += (row.usage?.inputTokens ?? 0) + (row.usage?.cacheReadTokens ?? 0) + (row.usage?.outputTokens ?? 0)
        }
        record({ id: condition.id, ...row })
      },
    })
    const end = rows.find(r => r.type === 'end')
    const responses = rows.filter(r => r.type === 'response')
    const result = { id: condition.id, facts: completionFacts(c, rows), end,
      responses: responses.map(r => ({ role: r.role, usage: r.usage, stopReason: r.stopReason, tools: r.tools.map(t => t.name) })),
    }
    results.push(result)
    const reviewId = randomUUID()
    mapping.push({ reviewId, id: condition.id })
    reviews.push({ reviewId, caseId: c.id, input: c.history, criterion: c.criterion, facts: result.facts,
      events: rows.filter(r => ['response', 'executed_tool', 'local_rpc', 'error', 'runtime_error', 'episode_failure'].includes(r.type))
        .map(r => r.type === 'response' ? { ...r, usage: undefined } : r),
      after: end?.after, changed: end?.changed, outbox: end?.outbox, memory: end?.memory,
      rating: null, evidence: null,
    })
    console.log(JSON.stringify({ id: condition.id, requests: end?.requests, facts: result.facts, batchReportedTokens: reportedTokens }))
    if (end?.fatal === 'model-error') stopReason ??= 'provider_error'
    if (reportedTokens >= plan.stopNewRequestsAtReportedTokens || requests >= plan.maxRequests) stopReason ??= 'budget'
  }
  for (let i = reviews.length - 1; i > 0; i--) { const j = randomInt(i + 1); [reviews[i], reviews[j]] = [reviews[j], reviews[i]] }
  for (const [name, value] of Object.entries({ 'summary.json': { hash, requests, reportedTokens, stopReason, results },
    'review-blinded.json': reviews, 'review-mapping.json': mapping }))
    fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
} finally { fs.closeSync(journal) }
