import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { continuousCases } from './continuous-cases.mjs'
import { runContinuous } from './continuous-runtime.mjs'
import { docker } from './docker-fixtures.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(root, 'crabot-agent/package.json'))
const sha = value => createHash('sha256').update(value).digest('hex')
function compiledHash(sourceRoot) {
  const base = path.join(sourceRoot, 'crabot-agent/dist'), rows = []
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(dir, e.name)
      if (e.isDirectory()) walk(f)
      else if (e.name.endsWith('.js')) rows.push([path.relative(base, f), sha(fs.readFileSync(f))])
    }
  }
  walk(base)
  return sha(JSON.stringify(rows))
}
export function summarize(c, rows) {
  const end = rows.find(r => r.type === 'end')
  const responses = rows.filter(r => r.type === 'response')
  const calls = responses.flatMap(r => r.tools.map(t => ({ ...t, role: r.role })))
  const before = rows.find(r => r.type === 'board_before')?.board
  const after = rows.find(r => r.type === 'board_after')?.board
  const artifactPass = end?.oracle ? /^exit_code: 0\b/.test(end.oracle.result.output) : null
  const usage = { input: 0, cached: 0, output: 0, missingUsage: 0, missingCache: 0 }
  for (const r of responses) {
    if (!r.usage) usage.missingUsage++
    if (r.usage?.cacheReadTokens === undefined) usage.missingCache++
    usage.input += r.usage?.inputTokens ?? 0
    usage.cached += r.usage?.cacheReadTokens ?? 0
    usage.output += r.usage?.outputTokens ?? 0
  }
  return {
    fatal: end?.fatal ?? (!end ? 'missing-end' : null), requests: rows.filter(r => r.type === 'request').length,
    responses: responses.length, usage, totalTokens: usage.input + usage.cached + usage.output,
    elapsedMs: end?.elapsedMs, modelMs: responses.reduce((n, r) => n + r.elapsedMs, 0),
    artifactPass, outbox: end?.outbox, boardChanged: JSON.stringify(before) !== JSON.stringify(after),
    changed: end?.changed.filter(f => !f.startsWith('.git/')), calls,
    workers: rows.find(r => r.type === 'workers_after')?.workers,
    childCompletions: rows.filter(r => r.type === 'child_completion'),
    guideReads: rows.filter(r => r.type === 'executed_tool' && r.name === 'load_guidance').map(r => r.input.name),
    // Actual requests establish body consumption; a read choice alone never counts.
    guidesConsumed: [...new Set(rows.filter(r => r.type === 'request').flatMap(r => [...JSON.stringify(r.messages).matchAll(/## Guidance: ([a-z.-]+)/g)].map(m => m[1])))],
    criterion: c.criterion, assessment: 'pending-semantic-review',
  }
}

async function main() {
  const out = process.env.GUIDANCE_OUTPUT, baselineRoot = process.env.GUIDANCE_BASELINE_ROOT
  if (!out || !baselineRoot) throw new Error('GUIDANCE_OUTPUT and GUIDANCE_BASELINE_ROOT required')
  const sources = { baseline: baselineRoot, candidate: root }
  const conditions = []
  // Block by replicate, alternate within pairs. No replacement or favourable resampling.
  for (let repeat = 0; repeat < 3; repeat++) for (const [index, c] of continuousCases.entries()) {
    if (repeat >= c.repeats) continue
    for (const variant of (index + repeat) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      conditions.push({ id: `${c.id}/${repeat + 1}/${variant}`, variant, repeat: repeat + 1, c,
        maxRequests: c.id === 'manager-project' || c.id === 'manager-delegation' ? 40 : c.role === 'worker' ? 24 : 16 })
    }
  }
  const plan = {
    endpoint: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max',
    image: (await docker(['image', 'inspect', 'crabot-guidance-tools:local', '--format', '{{.Id}}'])).trim(),
    sources: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), compiledSha256: compiledHash(source),
    }])),
    scripts: Object.fromEntries(['continuous-cases.mjs', 'continuous-runtime.mjs', 'continuous-compare.mjs', 'docker-fixtures.mjs', 'docker-project-docs.mjs', 'docker-tool-entry.mjs', 'build-docker.mjs'].map(f => [f, sha(fs.readFileSync(path.join(import.meta.dirname, f)))])),
    conditions, maxRequests: conditions.reduce((n, c) => n + c.maxRequests, 0), stopNewRequestsAtReportedTokens: 2000000,
    scope: 'Synthetic cases only, no private history or project files. Actual selected-revision Manager/Harness/Builtin loops. Real file, command, workspace and Git operations inside isolated Docker. Channel and memory captured locally; no Feishu send. Fixed Worker event seeds are setup only. A readonly builtin reviewer runs with isolated production child prompt. Timer waiting, external channels and native CLI Workers are not tested. No retries, replacement samples or prompt changes.',
    acceptance: 'Check full trajectories, artifacts, board changes and outbox against frozen per-case criteria. Keep infrastructure errors and incomplete runs separate. Compare quality before cost, report all attempts plus complete comparable pairs, and list regressions even if aggregate tokens decrease. Repeats are limited and do not establish population non-inferiority or zero incident probability.',
  }
  fs.mkdirSync(out, { recursive: true, mode: 0o700 })
  const frozen = JSON.stringify({ ...plan, sha256: sha(JSON.stringify(plan)) }, null, 2)
  const inputPath = path.join(out, 'inputs.json')
  if (fs.existsSync(inputPath)) {
    if (fs.readFileSync(inputPath, 'utf8') !== frozen) throw new Error('Frozen input changed')
  } else fs.writeFileSync(inputPath, frozen, { flag: 'wx', mode: 0o600 })
  if (process.argv.includes('--prepare')) {
    console.log(JSON.stringify({ out, cases: continuousCases.length, trajectories: conditions.length, maxRequests: plan.maxRequests, maxTokens: plan.stopNewRequestsAtReportedTokens, sha256: sha(JSON.stringify(plan)) }))
    return
  }
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
  for (const condition of conditions) {
    if (requests >= plan.maxRequests || totalTokens >= plan.stopNewRequestsAtReportedTokens) {
      results.push({ id: condition.id, fatal: 'budget-not-started' })
      continue
    }
    const runtimeRoot = path.join(out, 'runtime', condition.id.replaceAll('/', '--'))
    process.env.CRABOT_AGENT_DATA_DIR = path.join(runtimeRoot, 'agent')
    const rows = await runContinuous({ c: condition.c, sourceRoot: sources[condition.variant], image: plan.image, root: runtimeRoot,
      maxRequests: condition.maxRequests, timeoutMs: 600000,
      delegate: { stream(params) {
        if (requests >= plan.maxRequests || totalTokens >= plan.stopNewRequestsAtReportedTokens) throw Object.assign(new Error('Frozen global budget reached'), { code: 'EVAL_BUDGET' })
        requests++
        return live.stream(params)
      } },
      record(row) {
        if (row.type === 'response') totalTokens += (row.usage?.inputTokens ?? 0) + (row.usage?.cacheReadTokens ?? 0) + (row.usage?.outputTokens ?? 0)
        record({ id: condition.id, ...row })
      },
    })
    const result = { id: condition.id, variant: condition.variant, caseId: condition.c.id, repeat: condition.repeat, ...summarize(condition.c, rows) }
    results.push(result)
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ requests, totalTokens, results }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ id: condition.id, fatal: result.fatal, requests, totalTokens, artifactPass: result.artifactPass, sends: result.outbox?.length, guides: result.guidesConsumed }))
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ requests, totalTokens, results }, null, 2), { mode: 0o600 })
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await main()
