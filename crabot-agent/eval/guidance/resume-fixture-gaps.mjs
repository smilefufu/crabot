// Continue the four original Worker trajectories from their recorded tool gaps.
// No new case, resampling, prompt change, business command or business file access.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { initialFile, simulateFixtureTool } from './fixtures.mjs'

const out = process.env.GUIDANCE_OUTPUT
const { sha256, ...plan } = JSON.parse(fs.readFileSync(path.join(out, 'inputs.json'), 'utf8'))
if (createHash('sha256').update(JSON.stringify(plan)).digest('hex') !== sha256) throw Error('Frozen inputs changed')
const journalPath = path.join(out, 'events.jsonl')
const rows = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse)
if (rows.some(row => row.type === 'harness_resume')) throw Error('Fixture continuation already attempted')
const gaps = plan.conditions.filter(condition => {
  if (condition.c.role !== 'worker') return false
  return rows.filter(row => row.id === condition.id).at(-1)?.type === 'harness_gap'
})
if (gaps.length !== 4 || !gaps.every(item => /^(simple-fix|unclear-failure)\/(baseline|candidate)$/.test(item.id))) {
  throw Error('Expected exactly the four recorded Worker fixture gaps')
}
let requestCount = rows.filter(row => row.type === 'request').length
const req = createRequire(path.resolve(import.meta.dirname, '../../package.json'))
const { createGuidanceTool } = req('./dist/guidance/catalog.js')
const adminReq = createRequire(path.join(process.env.REPLAY_RUNTIME_ROOT, 'crabot-admin/package.json'))
const { ModelProviderManager } = adminReq('./dist/model-provider-manager.js')
const config = JSON.parse(fs.readFileSync(path.join(process.env.REPLAY_DATA_DIR, 'admin/agent-configs/crabot-agent.json'), 'utf8'))
const resolver = new ModelProviderManager(path.join(process.env.REPLAY_DATA_DIR, 'admin'))
await resolver.initialize()
const ref = config.model_config.powerful
const conn = await resolver.buildConnectionInfo(ref.provider_id, ref.model_id)
if (conn.endpoint !== 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
  || conn.model_id !== 'qwen3.8-max' || conn.format !== 'openai') throw Error('Provider changed')
const journal = fs.openSync(journalPath, 'a', 0o600)
function record(row) { fs.writeSync(journal, JSON.stringify(row) + '\n'); fs.fsyncSync(journal) }
record({ type: 'harness_resume', hash: sha256, ids: gaps.map(item => item.id),
  previousRequests: requestCount, maxTotalRequests: 72, maxRounds: plan.maxRounds,
  change: 'Closed simulation of already observed command variants; preserve all preceding messages and receipts.' })

async function run(condition) {
  const { id } = condition
  const events = rows.filter(row => row.id === id)
  const lastRequest = events.filter(row => row.type === 'request').at(-1)
  const responseIndex = events.findLastIndex(row => row.type === 'response')
  const pending = events[responseIndex].response.choices[0].message
  const messages = structuredClone(lastRequest.messages)
  const state = { file: initialFile, passed: false }
  for (const event of events) {
    if (event.type === 'simulated_tool' && event.name === 'Edit') simulateFixtureTool(event.name, event.args, state)
  }
  const alreadyReturned = events.slice(responseIndex + 1).filter(row => row.type === 'simulated_tool')
  const finish = reason => record({ type: 'end', id, reason, fixtureVerified: state.passed, fixtureRevision: 2 })
  async function receive(message, previous = []) {
    messages.push(message)
    if (!message.tool_calls?.length) { finish('response-ended'); return false }
    for (const [index, call] of message.tool_calls.entries()) {
      const name = call.function.name
      let args, receipt
      try {
        args = JSON.parse(call.function.arguments)
        const prior = previous[index]
        if (prior) {
          if (prior.name !== name || JSON.stringify(prior.args) !== JSON.stringify(args)) throw Error('Recorded receipt mismatch')
          receipt = prior.receipt
        } else {
          receipt = name === 'load_guidance'
            ? await createGuidanceTool('worker').call(args, {})
            : simulateFixtureTool(name, args, state)
          record({ type: 'simulated_tool', id, name, args, receipt, fixtureRevision: 2 })
        }
      } catch (error) { record({ type: 'harness_gap', id, name, args, reason: error.message, fixtureRevision: 2 }); return false }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(receipt) })
      if (name === 'finish_task') { finish('decision-observed'); return false }
    }
    return true
  }
  if (!await receive(pending, alreadyReturned)) return
  for (let round = lastRequest.round + 1; round < plan.maxRounds; round++) {
    if (requestCount >= 72) { finish('total-request-limit'); return }
    requestCount++
    record({ type: 'request', id, round, messages, tools: condition.tools, fixtureRevision: 2 })
    let response
    try {
      const r = await fetch(conn.endpoint + '/chat/completions', { method: 'POST',
        headers: { Authorization: 'Bearer ' + conn.apikey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: conn.model_id, messages, tools: condition.tools, max_tokens: 2000, stream: false }),
        signal: AbortSignal.timeout(90000) })
      response = await r.json()
      if (!r.ok) throw Error(JSON.stringify(response))
    } catch (error) { record({ type: 'missing', id, round, error: String(error).replaceAll(conn.apikey, '[REDACTED]') }); return }
    record({ type: 'response', id, round, response, fixtureRevision: 2 })
    const message = response.choices?.[0]?.message
    if (!message) { record({ type: 'missing', id, round, error: 'no message' }); return }
    if (!await receive(message)) return
  }
  finish('round-limit')
}
const slots = [...gaps]
async function consume() { while (slots.length) await run(slots.shift()) }
await Promise.all([consume(), consume()])
fs.closeSync(journal)
console.log(JSON.stringify({ finished: out, hash: sha256, totalRequests: requestCount }))
