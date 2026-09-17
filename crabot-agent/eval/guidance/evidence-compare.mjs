import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { evidenceCases, evidenceReviewRules } from './evidence-cases.mjs'
import { completionFacts } from './completion-cases.mjs'
import { runHistory } from './history-runtime.mjs'
import { docker } from './docker-fixtures.mjs'

const out = process.env.GUIDANCE_OUTPUT, beforeFile = process.env.GUIDANCE_BEFORE
if (!out || !beforeFile) throw new Error('GUIDANCE_OUTPUT and GUIDANCE_BEFORE required')
const root = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(root, 'crabot-agent/package.json'))
const { GUIDANCE } = require('./dist/guidance/content.js')
const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8')), after = structuredClone(GUIDANCE)
const changedGuides = Object.keys(after).filter(name => JSON.stringify(before[name]) !== JSON.stringify(after[name]))
if (JSON.stringify(changedGuides.sort()) !== JSON.stringify(['manager.worker-events', 'worker.diagnosis'])) throw new Error('Unexpected guidance scope')
const sha = value => createHash('sha256').update(value).digest('hex')
const oldImage = (await docker(['image', 'inspect', 'crabot-guidance-evidence:before', '--format', '{{.Id}}'])).trim()
const newImage = (await docker(['image', 'inspect', 'crabot-guidance-tools:local', '--format', '{{.Id}}'])).trim()
const conditions = evidenceCases.flatMap((c, index) => (index % 2 ? ['after', 'before'] : ['before', 'after'])
  .map(variant => ({ id: `${c.id}/${variant}/1`, caseId: c.id, variant, maxRequests: c.role === 'manager' ? 24 : 12,
    image: c.role === 'manager' || variant === 'before' ? oldImage : newImage })))
const compiledRoot = path.resolve(import.meta.dirname, '../../dist')
const plan = {
  before, after, changedGuides, oldImage, newImage, cases: evidenceCases, conditions, reviewRules: evidenceReviewRules,
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDiffSha: sha(execFileSync('git', ['diff', '--', 'crabot-agent/src'], { cwd: root })),
  scripts: Object.fromEntries(['evidence-cases.mjs', 'evidence-compare.mjs', 'completion-cases.mjs', 'history-runtime.mjs', 'docker-project-docs.mjs', 'docker-fixtures.mjs', 'docker-tool-entry.mjs']
    .map(name => [name, sha(fs.readFileSync(path.join(import.meta.dirname, name)))])),
  compiled: Object.fromEntries(fs.readdirSync(compiledRoot, { recursive: true }).filter(name => fs.statSync(path.join(compiledRoot, name)).isFile()).sort()
    .map(name => [name, sha(fs.readFileSync(path.join(compiledRoot, name)))])),
  endpoint: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max',
  maxRequests: 144, stopNewRequestsAtReportedTokens: 1400000, maxTokens: 2400, retries: 0,
  scope: '8 trajectories: four artificial cases, current before/after guidance once each. Identical core/tool assembly; both arms retain guidance. Manager cases vary only manager.worker-events and fix downstream Worker to before guidance/image; Worker cases vary only worker.diagnosis. Real product loop and isolated Docker tools. Local outbox/inbox only. No private history, business files, real external messages, host mounts, container network, production deployment, additional model judge or resampling. This targeted development probe is not population evidence.',
}
const hash = sha(JSON.stringify(plan)), prepared = JSON.stringify({ ...plan, sha256: hash }, null, 2)
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const inputPath = path.join(out, 'inputs.json')
if (fs.existsSync(inputPath)) { if (fs.readFileSync(inputPath, 'utf8') !== prepared) throw new Error('Prepared plan changed') }
else fs.writeFileSync(inputPath, prepared, { flag: 'wx', mode: 0o600 })
if (process.argv.includes('--prepare')) { console.log(JSON.stringify({ hash, trajectories: conditions.length, newImage, maxRequests: plan.maxRequests })); process.exit() }
if (fs.existsSync(path.join(out, 'events.jsonl'))) throw new Error('Refusing to overwrite results')
const adminRequire = createRequire(path.join(process.env.REPLAY_RUNTIME_ROOT, 'crabot-admin/package.json'))
const { ModelProviderManager } = adminRequire('./dist/model-provider-manager.js')
const resolver = new ModelProviderManager(path.join(process.env.REPLAY_DATA_DIR, 'admin'))
await resolver.initialize()
const providers = resolver.listProviders().filter(p => p.endpoint === plan.endpoint && p.format === 'openai' && p.models.some(m => m.model_id === plan.model))
if (providers.length !== 1) throw new Error('Provider/model is not uniquely configured')
const conn = await resolver.buildConnectionInfo(providers[0].id, plan.model)
if (conn.endpoint !== plan.endpoint || conn.model_id !== plan.model || conn.format !== 'openai') throw new Error('Provider changed')
const live = require('./dist/engine/llm-adapter.js').createAdapter({ endpoint: conn.endpoint, apikey: conn.apikey, format: conn.format })
const journal = fs.openSync(path.join(out, 'events.jsonl'), 'ax', 0o600)
let requests = 0, reportedTokens = 0, stopReason
const results = [], reviews = [], mapping = []
const record = row => { fs.writeSync(journal, JSON.stringify(row).replaceAll(conn.apikey, '[REDACTED]') + '\n'); fs.fsyncSync(journal) }
try {
  record({ type: 'plan', hash })
  for (const condition of conditions) {
    if (stopReason) { results.push({ id: condition.id, status: `not_started_after_${stopReason}` }); continue }
    const c = evidenceCases.find(c => c.id === condition.caseId)
    // Serial eval-only selection; no runtime/source mutation. The catalog reads
    // this object on demand. Both arms use runHistory's complete guidance path.
    for (const name of Object.keys(before)) GUIDANCE[name] = structuredClone(before[name])
    const name = c.role === 'manager' ? 'manager.worker-events' : 'worker.diagnosis'
    if (condition.variant === 'after') GUIDANCE[name] = structuredClone(after[name])
    const rows = await runHistory({ c, variant: 'candidate', image: condition.image,
      root: path.join(out, 'runtime', condition.id), baseline: {}, maxRequests: condition.maxRequests,
      delegate: { stream(params) {
        if (stopReason || requests >= plan.maxRequests || reportedTokens >= plan.stopNewRequestsAtReportedTokens)
          throw Object.assign(new Error('Frozen comparison budget exhausted'), { code: 'EVAL_BUDGET' })
        record({ type: 'provider_request', id: condition.id, number: ++requests })
        return live.stream(params)
      } }, record(row) {
        if (row.type === 'response') {
          if (!row.usage) stopReason ??= 'missing_usage'
          reportedTokens += (row.usage?.inputTokens ?? 0) + (row.usage?.cacheReadTokens ?? 0) + (row.usage?.outputTokens ?? 0)
        }
        record({ id: condition.id, ...row })
      },
    })
    const end = rows.find(r => r.type === 'end'), facts = completionFacts(c, rows)
    results.push({ id: condition.id, facts, end })
    const reviewId = randomUUID(); mapping.push({ reviewId, id: condition.id })
    reviews.push({ reviewId, caseId: c.id, criterion: c.criterion, input: c.history, facts,
      events: rows.filter(r => ['response', 'executed_tool', 'local_rpc', 'error', 'runtime_error', 'episode_failure'].includes(r.type))
        .map(r => r.type === 'response' ? { ...r, id: undefined, usage: undefined } : r),
      after: end?.after, changed: end?.changed, outbox: end?.outbox, memory: end?.memory, rating: null,
    })
    console.log(JSON.stringify({ id: condition.id, requests: end?.requests, facts, reportedTokens }))
    if (end?.fatal === 'model-error') stopReason ??= 'provider_error'
    if (requests >= plan.maxRequests || reportedTokens >= plan.stopNewRequestsAtReportedTokens) stopReason ??= 'budget'
  }
  for (let i = reviews.length - 1; i > 0; i--) { const j = randomInt(i + 1); [reviews[i], reviews[j]] = [reviews[j], reviews[i]] }
  for (const [name, value] of Object.entries({ 'summary.json': { hash, requests, reportedTokens, stopReason, results },
    'review-blinded.json': reviews, 'review-mapping.json': mapping }))
    fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
} finally {
  for (const name of Object.keys(after)) GUIDANCE[name] = after[name]
  fs.closeSync(journal)
}
