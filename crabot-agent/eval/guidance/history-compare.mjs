import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { historyCases } from './history-cases.mjs'
import { runHistory } from './history-runtime.mjs'
import { docker } from './docker-fixtures.mjs'

const out = process.env.GUIDANCE_OUTPUT
if (!out || !process.env.GUIDANCE_FROZEN) throw new Error('GUIDANCE_OUTPUT and GUIDANCE_FROZEN are required')
const original = JSON.parse(fs.readFileSync(process.env.GUIDANCE_FROZEN, 'utf8'))
const require = createRequire(path.resolve(import.meta.dirname, '../../package.json'))
const image = (await docker(['image', 'inspect', 'crabot-guidance-tools:local', '--format', '{{.Id}}'])).trim()
const sha = value => createHash('sha256').update(value).digest('hex')
const conditions = historyCases.flatMap(c => [1, 2].flatMap(repeat => (repeat === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'])
  .map(variant => ({ id: `${c.id}/${variant}/${repeat}`, caseId: c.id, variant, repeat, maxRequests: c.role === 'manager' ? 24 : 12 }))))
const plan = {
  cases: historyCases, conditions, image, baseline: original.baseline,
  sourceBaseline: '739b50e0', sourceCandidate: '45f20e30',
  scripts: Object.fromEntries(['history-cases.mjs', 'history-runtime.mjs', 'history-compare.mjs', 'docker-fixtures.mjs'].map(name => [name, sha(fs.readFileSync(path.join(import.meta.dirname, name)))])),
  endpoint: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max',
  maxTokens: 2400, timeoutMs: 600000, maxRequests: conditions.reduce((n, c) => n + c.maxRequests, 0),
  scope: 'Artificial reconstructions of verified historical failure mechanisms, not verbatim private replays. Production Manager/Harness/Builtin continuation and native traces; actual Docker file/process tools. Historical starting Worker report is scripted. Channels and empty memory are local boundaries; channel delivery is not tested. In Manager comparisons only Manager prompt/guidance varies; downstream Worker uses the same approved candidate. All product code/tool schemas are current in both variants. No retries, resampling, production data, deployment, host execution tools, or external channel sends.',
}
const hash = sha(JSON.stringify(plan)), prepared = JSON.stringify({ ...plan, sha256: hash }, null, 2)
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const inputs = path.join(out, 'inputs.json')
if (fs.existsSync(inputs)) { if (fs.readFileSync(inputs, 'utf8') !== prepared) throw new Error('Prepared plan changed') }
else fs.writeFileSync(inputs, prepared, { flag: 'wx', mode: 0o600 })
if (process.argv.includes('--prepare')) { console.log(JSON.stringify({ out, hash, image, trajectories: conditions.length, maxRequests: plan.maxRequests })); process.exit() }
if (fs.existsSync(path.join(out, 'events.jsonl'))) throw new Error('Refusing to overwrite or resume completed/partial trajectories')

const adminRequire = createRequire(path.join(process.env.REPLAY_RUNTIME_ROOT, 'crabot-admin/package.json'))
const { ModelProviderManager } = adminRequire('./dist/model-provider-manager.js')
const config = JSON.parse(fs.readFileSync(path.join(process.env.REPLAY_DATA_DIR, 'admin/agent-configs/crabot-agent.json'), 'utf8'))
const resolver = new ModelProviderManager(path.join(process.env.REPLAY_DATA_DIR, 'admin'))
await resolver.initialize()
const ref = config.model_config.powerful
const conn = await resolver.buildConnectionInfo(ref.provider_id, ref.model_id)
if (conn.endpoint !== plan.endpoint || conn.model_id !== plan.model || conn.format !== 'openai') throw new Error('Provider changed')
const { createAdapter } = require('./dist/engine/llm-adapter.js')
const delegate = createAdapter({ endpoint: conn.endpoint, apikey: conn.apikey, format: conn.format })
const journal = fs.openSync(path.join(out, 'events.jsonl'), 'ax', 0o600)
const record = row => { fs.writeSync(journal, JSON.stringify(row).replaceAll(conn.apikey, '[REDACTED]') + '\n'); fs.fsyncSync(journal) }
const results = []
record({ type: 'plan', hash, image, maxRequests: plan.maxRequests })
try {
  for (let i = 0; i < conditions.length; i += 2) {
    const settled = await Promise.allSettled(conditions.slice(i, i + 2).map(async condition => {
      const c = historyCases.find(c => c.id === condition.caseId)
      const rows = await runHistory({ c, variant: condition.variant, image, baseline: plan.baseline, delegate,
        root: path.join(out, 'runtime', condition.caseId, condition.variant, String(condition.repeat)), maxRequests: condition.maxRequests,
        timeoutMs: plan.timeoutMs, record: row => record({ id: condition.id, ...row }),
      })
      const end = rows.find(r => r.type === 'end')
      const result = { id: condition.id, ...end, responses: rows.filter(r => r.type === 'response').map(r => ({ role: r.role, usage: r.usage, tools: r.tools.map(t => t.name) })) }
      results.push(result)
      console.log(JSON.stringify({ id: condition.id, requests: end?.requests, fatal: end?.fatal, oracle: end?.oracle?.result.output.split('\n')[0] }))
    }))
    for (const item of settled) if (item.status === 'rejected') throw item.reason
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ hash, results }, null, 2), { flag: 'wx', mode: 0o600 })
} finally { fs.closeSync(journal) }
