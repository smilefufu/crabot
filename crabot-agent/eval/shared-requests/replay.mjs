import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { cases, digest, runCase } from './runtime.mjs'
const repo = path.resolve(import.meta.dirname, '../../..'), require = createRequire(path.join(repo, 'crabot-agent/package.json'))
const output = process.env.REQUEST_REPLAY_OUTPUT, data = process.env.REQUEST_REPLAY_DATA
if (!output) throw new Error('REQUEST_REPLAY_OUTPUT required; output must be a fresh private directory')
await fs.mkdir(output, { recursive: true, mode: 0o700 })
const selected = process.env.REQUEST_REPLAY_CASES?.split(',') ?? cases.map(item => item.id)
const scenarios = cases.filter(item => selected.includes(item.id))
if (scenarios.length !== selected.length) throw new Error('Unknown or duplicate case')
const plan = {
  schema_version: 1, code: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), scenarios,
  tool_loading_mode: 'progressive', maximum_model_calls: 48, maximum_model_calls_per_case: 24, max_tokens_per_call: 4096, scope: 'Synthetic identity, conversation, files, memory/Channel/MCP transports only; real production Manager/Request/Harness/Builtin and configured provider. No live messages, processes, contact/voice data or deployment.',
  source_hashes: Object.fromEntries(await Promise.all(['crabot-agent/src/manager/prompt.ts', 'crabot-agent/src/manager/request-loop.ts', 'crabot-agent/src/manager/conversation-request-runner.ts', 'crabot-agent/src/manager/bootstrap.ts', 'crabot-agent/src/guidance/content.ts', 'crabot-shared/src/permission-entries.ts', 'crabot-agent/eval/shared-requests/runtime.mjs'].map(async name => [name, digest(await fs.readFile(path.join(repo, name), 'utf8'))])))
}
await fs.writeFile(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600, flag: 'wx' })
if (!process.argv.includes('--live')) { console.log(JSON.stringify({ prepared: output, plan_sha256: digest(plan), cases: selected })); process.exit(0) }
if (!data) throw new Error('REQUEST_REPLAY_DATA required for configured model references')
const adminRequire = createRequire(path.join(repo, 'crabot-admin/package.json'))
const { ModelProviderManager } = adminRequire('./dist/model-provider-manager.js')
const config = JSON.parse(await fs.readFile(path.join(data, 'admin/agent-configs/crabot-agent.json'), 'utf8'))
const refs = config.models ?? config.model_config, ref = refs.powerful ?? refs.default
const resolver = new ModelProviderManager(path.join(data, 'admin')); await resolver.loadData()
const connection = await resolver.buildConnectionInfo(ref.provider_id, ref.model_id)
const { createAdapter } = require('./dist/engine/llm-adapter.js'), { thinkingParam } = require('./dist/engine/llm-adapter-types.js')
const { proxyManager } = require('../crabot-shared/dist/index.js')
proxyManager.updateConfig(resolver.getGlobalConfig().proxy)
const liveAdapter = createAdapter({ endpoint: connection.endpoint, apikey: connection.apikey, format: connection.format, accountId: connection.account_id })
await fs.writeFile(path.join(output, 'model.json'), JSON.stringify({ model: connection.model_id, format: connection.format, provider_origin: new URL(connection.endpoint).origin, thinking: config.thinking?.powerful ?? null }, null, 2), { mode: 0o600 })
let count = 0; const budget = { take: () => count < plan.maximum_model_calls ? (count++, true) : false }; const results = []
const scrub = value => JSON.stringify(value).replaceAll(connection.apikey, '[REDACTED]')
for (const scenario of scenarios) {
  const dir = path.join(output, scenario.id); await fs.mkdir(dir, { mode: 0o700 })
  const file = await fs.open(path.join(dir, 'events.jsonl'), 'wx', 0o600)
  let writes = Promise.resolve()
  try {
    const result = await runCase({
      scenario, root: path.join(dir, 'data'), liveAdapter, model: connection.model_id, thinking: thinkingParam(config.thinking?.powerful?.thinking_level, config.thinking?.powerful?.thinking_custom), connection,
      record: event => { const line = scrub(event) + '\n'; writes = writes.then(() => file.write(line)) }, budget
    })
    await fs.writeFile(path.join(dir, 'result.json'), scrub(result), { mode: 0o600 }); results.push(result)
    console.log(JSON.stringify({ scenario: scenario.id, status: result.status, checks: result.checks, requests: result.requests, elapsed_ms: result.elapsed_ms }))
  } catch (error) { results.push({ scenario: scenario.id, status: 'inconclusive', error: String(error.message).replaceAll(connection.apikey, '[REDACTED]') }); console.log(JSON.stringify(results.at(-1))) }
  finally { try { await writes; await file.sync() } finally { await file.close() } }
  await fs.writeFile(path.join(output, 'summary.json'), scrub({ plan_sha256: digest(plan), calls: count, results }), { mode: 0o600 })
  if (count >= plan.maximum_model_calls) break
}

if (results.length !== scenarios.length || results.some(result => result.status !== 'passed')) process.exitCode = 1
