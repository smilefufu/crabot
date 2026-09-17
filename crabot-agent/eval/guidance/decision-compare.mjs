import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { decisionCases } from './decision-cases.mjs'
import { decisionCondition, runDecision } from './decision-runtime.mjs'

const out = process.env.GUIDANCE_OUTPUT
if (!out || !process.env.GUIDANCE_FROZEN) throw new Error('GUIDANCE_OUTPUT and GUIDANCE_FROZEN are required')
const baseline = JSON.parse(fs.readFileSync(process.env.GUIDANCE_FROZEN, 'utf8')).baseline
const sha = text => createHash('sha256').update(text).digest('hex')
const root = path.resolve(import.meta.dirname, '../../..')
const plan = {
  version: 1, sourceTree: execFileSync('git', ['rev-parse', 'HEAD:crabot-agent/src'], { cwd: root, encoding: 'utf8' }).trim(),
  baselineSource: '739b50e0',
  endpoint: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max',
  maxRounds: 3, repeats: 2, maxRequests: decisionCases.length * 2 * 2 * 3, maxTokens: 2400,
  stopNewRequestsAtReportedTokens: 500000,
  requestTimeoutMs: 90000, retries: 0,
  scope: 'Stage 1 decision probes only. Actual compiled prompt/tool descriptions and artificial inputs. Only static guidance and local permission/Worker observations can return results. All business tool choices are recorded and never executed. No Docker tasks, private histories, project files, production actions, external messages, deployment or extra model judge. Does not prove end-to-end non-inferiority.',
  assessment: 'Freeze rubrics before outputs. Review meaning, not keywords, guide counts or text length. Hide variant labels and randomize A/B; wording may still reveal the variant. Unsupported reads, truncation, empty outputs and request failures remain separate; no successful completion rate is computed from a decision. No 5-point non-inferiority claim from 10 selected cases or repeated draws.',
  scripts: Object.fromEntries(['decision-cases.mjs', 'decision-runtime.mjs', 'decision-compare.mjs']
    .map(name => [name, sha(fs.readFileSync(path.join(import.meta.dirname, name)))])),
  conditions: decisionCases.flatMap(c => [1, 2].flatMap(repeat =>
    (repeat === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline']).map(variant => ({
      id: `${c.id}/${variant}/${repeat}`, c, repeat, variant, ...decisionCondition(c, variant, baseline),
    })))),
}
const frozen = { ...plan, sha256: sha(JSON.stringify(plan)) }
const inputs = JSON.stringify(frozen, null, 2)
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const inputPath = path.join(out, 'inputs.json')
if (fs.existsSync(inputPath)) {
  if (fs.readFileSync(inputPath, 'utf8') !== inputs) throw new Error('Prepared plan changed; use a new output directory')
} else fs.writeFileSync(inputPath, inputs, { flag: 'wx', mode: 0o600 })
if (process.argv.includes('--prepare')) {
  console.log(JSON.stringify({ out, hash: frozen.sha256, trajectories: plan.conditions.length, maxRequests: plan.maxRequests }))
  process.exit()
}
if (fs.existsSync(path.join(out, 'events.jsonl'))) throw new Error('Refusing to overwrite or resume existing results')

const require = createRequire(path.join(root, 'crabot-agent/package.json'))
const adminRequire = createRequire(path.join(process.env.REPLAY_RUNTIME_ROOT, 'crabot-admin/package.json'))
const { ModelProviderManager } = adminRequire('./dist/model-provider-manager.js')
const resolver = new ModelProviderManager(path.join(process.env.REPLAY_DATA_DIR, 'admin'))
await resolver.initialize()
const providers = resolver.listProviders().filter(p => p.endpoint === plan.endpoint && p.format === 'openai'
  && p.models.some(m => m.model_id === plan.model))
if (providers.length !== 1) throw new Error('Frozen provider/model is not uniquely configured')
const conn = await resolver.buildConnectionInfo(providers[0].id, plan.model)
if (conn.endpoint !== plan.endpoint || conn.model_id !== plan.model || conn.format !== 'openai') throw new Error('Provider changed')
const live = require('./dist/engine/llm-adapter.js').createAdapter({ endpoint: conn.endpoint, apikey: conn.apikey, format: conn.format })
const journal = fs.openSync(path.join(out, 'events.jsonl'), 'ax', 0o600)
const results = [], reviews = [], mapping = []
let requests = 0, reportedTokens = 0, stopReason
const record = row => {
  fs.writeSync(journal, JSON.stringify(row).replaceAll(conn.apikey, '[REDACTED]') + '\n')
  fs.fsyncSync(journal)
}
try {
  record({ type: 'plan', hash: frozen.sha256, maxRequests: plan.maxRequests })
  for (const condition of plan.conditions) {
    if (stopReason) { results.push({ id: condition.id, status: `not_started_after_${stopReason}` }); continue }
    const rows = []
    const result = await runDecision({ c: condition.c, condition, model: plan.model,
      maxRounds: plan.maxRounds, maxTokens: plan.maxTokens,
      record(row) {
        if (row.type === 'response') reportedTokens += (row.usage?.inputTokens ?? 0)
          + (row.usage?.cacheReadTokens ?? 0) + (row.usage?.outputTokens ?? 0)
        rows.push(row); record({ id: condition.id, ...row })
      },
      delegate: { stream(params) {
        if (requests >= plan.maxRequests || reportedTokens >= plan.stopNewRequestsAtReportedTokens) {
          throw Object.assign(new Error('Frozen request/token allowance exhausted'), { code: 'EVAL_BUDGET' })
        }
        record({ id: condition.id, type: 'provider_request', number: ++requests })
        return live.stream(params)
      } },
    })
    const responses = rows.filter(r => r.type === 'response')
    const usage = responses.reduce((sum, r) => ({
      input: sum.input + (r.usage?.inputTokens ?? 0) + (r.usage?.cacheReadTokens ?? 0),
      cached: sum.cached + (r.usage?.cacheReadTokens ?? 0),
      output: sum.output + (r.usage?.outputTokens ?? 0),
      missing: sum.missing + (r.usage ? 0 : 1),
    }), { input: 0, cached: 0, output: 0, missing: 0 })
    const row = { id: condition.id, ...result, usage, final: responses.at(-1) ?? null }
    results.push(row); record({ type: 'end', ...row })
    console.log(JSON.stringify({ id: row.id, status: row.status, rounds: row.rounds, totalTokens: usage.input + usage.output }))
    if (result.status === 'missing' || result.status === 'budget_stop') stopReason = result.status
  }
  for (const c of decisionCases) for (const repeat of [1, 2]) {
    const order = randomInt(2) ? ['baseline', 'candidate'] : ['candidate', 'baseline']
    const reviewId = randomUUID()
    const options = Object.fromEntries(order.map((variant, i) => {
      const found = results.find(r => r.id === `${c.id}/${variant}/${repeat}`)
      mapping.push({ reviewId, label: i ? 'B' : 'A', id: found.id })
      return [i ? 'B' : 'A', { status: found.status, text: found.final?.text ?? '',
        tools: found.final?.tools?.filter(t => t.name !== 'load_guidance') ?? [] }]
    }))
    reviews.push({ reviewId, caseId: c.id, input: c.user, rubric: c.rubric, options,
      rating: null, evidence: null,
      note: '逐项标记符合、明确违反或证据不足，再比较；仅读取证据不等于已续办或交付。状态缺失则不可比较。标签隐藏不保证文本完全不透露版本。' })
  }
  for (const [name, value] of Object.entries({ 'summary.json': { hash: frozen.sha256, requests, reportedTokens, results },
    'review-blinded.json': reviews, 'review-mapping.json': mapping })) {
    fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
  }
} finally { fs.closeSync(journal) }
