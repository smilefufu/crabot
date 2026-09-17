// One explicitly user-authorized recovery. Never reroll the two successful decisions.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { runHistory, scriptedChunks } from './history-runtime.mjs'

const parent = process.env.GUIDANCE_PARENT
const out = process.env.GUIDANCE_OUTPUT
if (!parent || !out) throw new Error('GUIDANCE_PARENT and GUIDANCE_OUTPUT are required')
const plan = JSON.parse(fs.readFileSync(path.join(parent, 'inputs.json'), 'utf8'))
const original = fs.readFileSync(path.join(parent, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
const id = 'manager-repeat-approval/baseline/1'
const rows = original.filter(r => r.id === id)
const end = rows.find(r => r.type === 'end')
const prefix = rows.filter(r => r.type === 'response')
if (end?.fatal !== 'model-error' || end.requests !== 4 || end.changed.length || end.outbox.length
  || rows.some(r => r.type === 'executed_tool')
  || !rows.some(r => r.type === 'error' && r.error.includes('insufficient_quota'))
  || prefix.length !== 2 || prefix.some(r => r.role !== 'manager')
  || prefix[0].tools[0]?.name !== 'get_worker_turn' || prefix[1].tools[0]?.name !== 'send_to_worker') {
  throw new Error('Recovery preconditions do not match the recorded quota interruption')
}
const oldWorkerId = rows.find(r => r.type === 'historical_seed').workerId
const sha = x => createHash('sha256').update(x).digest('hex')
const manifest = {
  parentHash: plan.sha256, id, originalRequests: end.requests, prefix,
  maxNewRequests: 20, maxRequestsIncludingOriginal: 24,
  runtimeHash: sha(fs.readFileSync(path.join(import.meta.dirname, 'history-runtime.mjs'))),
  recoveryHash: sha(fs.readFileSync(import.meta.filename)),
  scope: 'Recreate unchanged artificial files and production runtime, then replay the two observed Manager texts/tool decisions without model calls. Map only old Worker ID to its newly allocated ID. Prior hidden reasoning was not retained by the request journal and is not reconstructed. Fresh timestamps, turn IDs and runtime paths differ, so this is a marked semantic continuation, not byte-identical resumption or an independent repeat. At most 20 new model calls; original 4 attempts remain in the audit.',
}
const prepared = JSON.stringify({ ...manifest, sha256: sha(JSON.stringify(manifest)) }, null, 2)
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const inputFile = path.join(out, 'inputs.json')
if (fs.existsSync(inputFile)) { if (fs.readFileSync(inputFile, 'utf8') !== prepared) throw new Error('Recovery plan changed') }
else fs.writeFileSync(inputFile, prepared, { flag: 'wx', mode: 0o600 })
if (process.argv.includes('--prepare')) { console.log(JSON.stringify({ id, out, maxNewRequests: 20, hash: sha(JSON.stringify(manifest)) })); process.exit() }
if (fs.existsSync(path.join(out, 'events.jsonl'))) throw new Error('Recovery may run only once')
if (manifest.runtimeHash !== plan.scripts['history-runtime.mjs']) throw new Error('Frozen runtime changed')

const require = createRequire(path.resolve(import.meta.dirname, '../../package.json'))
const adminRequire = createRequire(path.join(process.env.REPLAY_RUNTIME_ROOT, 'crabot-admin/package.json'))
const { ModelProviderManager } = adminRequire('./dist/model-provider-manager.js')
const resolver = new ModelProviderManager(path.join(process.env.REPLAY_DATA_DIR, 'admin'))
await resolver.initialize()
const providers = resolver.listProviders().filter(p => p.endpoint === plan.endpoint && p.format === 'openai'
  && p.models.some(m => m.model_id === plan.model))
if (providers.length !== 1) throw new Error('Frozen experiment provider is not uniquely configured')
const conn = await resolver.buildConnectionInfo(providers[0].id, plan.model)
if (conn.endpoint !== plan.endpoint || conn.model_id !== plan.model || conn.format !== 'openai') throw new Error('Provider changed')
const live = require('./dist/engine/llm-adapter.js').createAdapter({ endpoint: conn.endpoint, apikey: conn.apikey, format: conn.format })
const journal = fs.openSync(path.join(out, 'events.jsonl'), 'ax', 0o600)
const record = row => { fs.writeSync(journal, JSON.stringify(row).replaceAll(conn.apikey, '[REDACTED]') + '\n'); fs.fsyncSync(journal) }
let replayed = 0, actualRequests = 0
const replayIds = new Set()
const delegate = { stream(params, meta) {
  if (meta.role === 'manager' && replayed < prefix.length) {
    const workerId = JSON.stringify(params.messages).match(/w-[a-z0-9-]+/)?.[0]
    if (!workerId) throw new Error('New fixture Worker ID missing')
    const response = prefix[replayed++]
    replayIds.add(meta.request)
    record({ type: 'replay', request: meta.request, sourceRequest: response.request, oldWorkerId, workerId })
    const blocks = [...(response.text ? [{ type: 'text', text: response.text }] : []), ...response.tools]
    return scriptedChunks(JSON.parse(JSON.stringify(blocks).replaceAll(oldWorkerId, workerId)))
  }
  if (++actualRequests > 20) throw new Error('Quota recovery request budget exhausted')
  record({ type: 'provider_request', request: meta.request, actualRequests, role: meta.role })
  return live.stream(params)
} }
try {
  const events = await runHistory({
    c: plan.cases.find(c => c.id === 'manager-repeat-approval'), variant: 'baseline', image: plan.image,
    root: path.join(out, 'runtime'), baseline: plan.baseline, delegate, maxRequests: 22,
    record: row => record({ id, ...row, ...(replayIds.has(row.request) ? { replayed: true } : {}) }),
  })
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ id, actualRequests, replayed, result: events.find(e => e.type === 'end') }, null, 2), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ id, actualRequests, replayed, fatal: events.find(e => e.type === 'end')?.fatal }))
} finally { fs.closeSync(journal) }
