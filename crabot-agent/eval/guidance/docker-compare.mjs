// Actual Docker file/process tools; model connection stays outside the containers.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { FixtureContainer, cases, docker } from './docker-fixtures.mjs'

const repo = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(repo, 'crabot-agent/package.json'))
const out = process.env.GUIDANCE_OUTPUT
const frozen = JSON.parse(fs.readFileSync(process.env.GUIDANCE_FROZEN, 'utf8'))
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
if (fs.existsSync(path.join(out, 'events.jsonl'))) throw Error('Refusing to overwrite or rerun an existing trajectory')
const { assembleBuiltinWorkerPrompt } = require('./dist/prompts/builtin-worker.js')
const { createGuidanceTool } = require('./dist/guidance/catalog.js')
const definitions = ['Read', 'Edit', 'Write', 'Bash'].map(name =>
  require(`./dist/engine/tools/${name.toLowerCase()}-tool.js`)[`create${name}Tool`](() => '/fixture'))

// Read the private production exit-tool definition without duplicating its schema/description.
const ts = require('typescript')
const source = fs.readFileSync(path.join(repo, 'crabot-agent/src/workers/builtin/adapter.ts'), 'utf8')
const ast = ts.createSourceFile('adapter.ts', source, ts.ScriptTarget.Latest, true)
let finishExpression
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'FINISH_TASK_TOOL') finishExpression = node.initializer.getText(ast)
  ts.forEachChild(node, visit)
}
visit(ast)
if (!finishExpression) throw Error('Production finish tool definition missing')
const finish = vm.runInNewContext(ts.transpileModule(`(${finishExpression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
  { defineTool: definition => definition })
definitions.push(finish, createGuidanceTool('worker'))
const wire = t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })
const image = (await docker(['image', 'inspect', 'crabot-guidance-tools:local', '--format', '{{.Id}}'])).trim()
const conditions = cases.flatMap(c => ['baseline', 'candidate'].map(variant => ({
  id: `${c.id}/${variant}`, c, variant,
  prompt: variant === 'baseline' ? frozen.baseline.worker : assembleBuiltinWorkerPrompt({ workspaceRoot: '/fixture', imageAvailable: false }),
  tools: definitions.filter(t => variant === 'candidate' || t.name !== 'load_guidance').map(wire),
})))
const sha = text => createHash('sha256').update(text).digest('hex')
const scripts = Object.fromEntries(['docker-compare.mjs', 'docker-fixtures.mjs', 'docker-tool-entry.mjs', 'build-docker.mjs']
  .map(name => [name, sha(fs.readFileSync(path.join(import.meta.dirname, name)))]))
const plan = { conditions, image, scripts, maxRounds: 8, maxRequests: 32, replicates: 1,
  endpoint: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max',
  scope: 'Synthetic files only. Production Read/Edit/Write/Bash in isolated Docker. No host mounts/network/credentials. Exit tool is a report, not a Worker lifecycle test.' }
const hash = sha(JSON.stringify(plan))
const inputs = JSON.stringify({ ...plan, sha256: hash }, null, 2)
const file = path.join(out, 'inputs.json')
if (fs.existsSync(file)) { if (fs.readFileSync(file, 'utf8') !== inputs) throw Error('Prepared plan changed') }
else fs.writeFileSync(file, inputs, { mode: 0o600, flag: 'wx' })
if (process.argv.includes('--prepare')) { console.log(JSON.stringify({ out, hash, image, trajectories: conditions.length, maxRequests: plan.maxRequests })); process.exit() }

const adminRequire = createRequire(path.join(process.env.REPLAY_RUNTIME_ROOT, 'crabot-admin/package.json'))
const { ModelProviderManager } = adminRequire('./dist/model-provider-manager.js')
const config = JSON.parse(fs.readFileSync(path.join(process.env.REPLAY_DATA_DIR, 'admin/agent-configs/crabot-agent.json'), 'utf8'))
const resolver = new ModelProviderManager(path.join(process.env.REPLAY_DATA_DIR, 'admin'))
await resolver.initialize()
const ref = config.model_config.powerful
const conn = await resolver.buildConnectionInfo(ref.provider_id, ref.model_id)
if (conn.endpoint !== plan.endpoint || conn.model_id !== plan.model || conn.format !== 'openai') throw Error('Provider changed')
const journal = fs.openSync(path.join(out, 'events.jsonl'), 'ax', 0o600)
function record(row) { fs.writeSync(journal, JSON.stringify(row) + '\n'); fs.fsyncSync(journal) }
record({ type: 'plan', hash, image, endpoint: plan.endpoint, model: plan.model, maxRequests: plan.maxRequests })
const results = []
async function run(condition) {
  const { id, c } = condition
  const box = new FixtureContainer(image)
  const messages = [{ role: 'system', content: condition.prompt }, { role: 'user', content: c.user }]
  let before, finalText = '', reason = 'round-limit', reported = null, requests = 0
  try {
    before = await box.start(c)
    record({ type: 'start', id, container: box.name, before })
    for (let round = 0; round < plan.maxRounds; round++) {
      requests++
      record({ type: 'request', id, round, messages, tools: condition.tools })
      const response = await fetch(conn.endpoint + '/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + conn.apikey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: conn.model_id, messages, tools: condition.tools, max_tokens: 2000, stream: false }),
        signal: AbortSignal.timeout(90000),
      })
      const body = await response.json()
      if (!response.ok) throw Error(`Provider HTTP ${response.status}: ${JSON.stringify(body)}`)
      record({ type: 'response', id, round, response: body })
      const message = body.choices?.[0]?.message
      if (!message) throw Error('Provider returned no message')
      messages.push(message)
      finalText = message.content ?? ''
      if (!message.tool_calls?.length) { reason = 'response-ended'; break }
      for (const call of message.tool_calls) {
        const name = call.function.name, input = JSON.parse(call.function.arguments)
        if (!condition.tools.some(t => t.function.name === name)) throw Error(`Unavailable tool: ${name}`)
        if (name === 'finish_task') {
          if (!['completed', 'failed'].includes(input.outcome) || typeof input.summary !== 'string') throw Error('Invalid finish report')
          reported = input; reason = 'finish-report'
          record({ type: 'report', id, input }); break
        }
        const receipt = await box.call(name, input)
        record({ type: 'executed_tool', id, name, input, receipt })
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(receipt.result) })
      }
      if (reported) break
    }
  } catch (error) {
    reason = 'error'
    record({ type: 'error', id, error: String(error).replaceAll(conn.apikey, '[REDACTED]') })
  } finally {
    try {
      if (before) {
        const after = await box.snapshot(), oracle = await box.verify(c)
        const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => JSON.stringify(before[name]) !== JSON.stringify(after[name]))
        const evidence = { id, reason, requests, reported, finalText, changed, before, after, oracle }
        record({ type: 'end', ...evidence }); results.push(evidence)
        console.log(JSON.stringify({ id, reason, requests, changed, oracle: oracle?.result.output.split('\n')[0] }))
      }
    } finally { await box.close(); record({ type: 'cleanup', id, container: box.name }) }
  }
}
try {
  // Two independent fresh containers at a time; no retries or resampling.
  for (let i = 0; i < conditions.length; i += 2) await Promise.allSettled(conditions.slice(i, i + 2).map(run)).then(settled => {
    for (const item of settled) if (item.status === 'rejected') throw item.reason
  })
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ hash, results }, null, 2), { mode: 0o600, flag: 'wx' })
} finally { fs.closeSync(journal) }
