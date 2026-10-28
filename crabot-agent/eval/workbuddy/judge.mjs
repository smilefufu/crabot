// Metered endpoint for upstream benchmark judges only; Crabot itself connects natively.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { Budget, TOTAL_BUDGET } from './budget.mjs'
import { observeResponse } from './observe.mjs'
const data = process.env.REPLAY_DATA_DIR, runtime = process.env.REPLAY_RUNTIME_ROOT
const output = process.env.WORKBUDDY_JUDGE_OUTPUT, python = process.env.WORKBUDDY_PYTHON
if (!data || !runtime || !output || !python) throw new Error('Explicit runtime, data, output and benchmark Python required')
fs.mkdirSync(output, { recursive: false, mode: 0o700 })
const require = createRequire(path.join(runtime, 'crabot-admin/package.json'))
const { ModelProviderManager } = require('./dist/model-provider-manager.js')
const agentRequire = createRequire(path.join(runtime, 'crabot-agent/package.json'))
const { HttpResponseError, isRetryableError } = agentRequire('./dist/engine/retry-utils.js')
const resolver = new ModelProviderManager(path.join(data, 'admin')); await resolver.initialize()
const config = JSON.parse(fs.readFileSync(path.join(data, 'admin/agent-configs/crabot-agent.json'), 'utf8'))
const ref = config.model_config.powerful
const conn = await resolver.buildConnectionInfo(ref.provider_id, ref.model_id)
if (conn.format !== 'openai' || conn.model_id !== 'gpt-6.1-sol') throw new Error('Judge baseline changed')
const budget = new Budget(TOTAL_BUDGET, Number(process.env.WORKBUDDY_PRIOR_TOKENS ?? 0), Number(process.env.WORKBUDDY_UNKNOWN_RESERVE ?? 0))
const credential = randomUUID()
const shutdown = new AbortController()
let queue = Promise.resolve(), sequence = 0, stopped = false
const record = row => fs.appendFileSync(path.join(output, 'requests.jsonl'),
  JSON.stringify({ ts: new Date().toISOString(), role: 'judge', ...row }).split(conn.apikey).join('[REDACTED]').split(credential).join('[EVAL_TOKEN]') + '\n', { mode: 0o600 })
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.authorization !== 'Bearer ' + credential) {
    res.writeHead(403); res.end(); return
  }
  const before = queue; let release
  queue = new Promise(r => { release = r }); await before
  const id = ++sequence
  let admitted = false, sent = false
  try {
    if (stopped || req.aborted || res.destroyed) throw new Error('Judge budget stopped or caller disconnected')
    budget.begin(id); admitted = true
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    body.model = conn.model_id
    // Use the selected model's actual configuration, rather than a foreign model's tiny judge cap.
    delete body.max_tokens; delete body.max_completion_tokens
    if (conn.max_tokens !== undefined) body.max_tokens = conn.max_tokens
    const thinking = config.thinking?.powerful
    if (thinking?.thinking_level) body.reasoning_effort = thinking.thinking_level
    if (body.stream) body.stream_options = { ...body.stream_options, include_usage: true }
    record({ type: 'request', id, model: body.model, streaming: !!body.stream,
      maxTokens: body.max_tokens, reasoningEffort: body.reasoning_effort,
      requestSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') })
    sent = true
    const upstream = await fetch(conn.endpoint.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + conn.apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(1200000), shutdown.signal]),
    })
    const observed = observeResponse(upstream, undefined, !!body.stream)
    let text
    if (!body.stream || !upstream.ok) text = await observed.response.text()
    else {
      res.writeHead(upstream.status, { 'content-type': 'text/event-stream' }); res.flushHeaders()
      for await (const chunk of observed.response.body) res.write(chunk)
    }
    const receipt = await observed.receipt
    record({ type: 'wire_receipt', id, ...receipt })
    let providerError
    if (receipt.error) {
      let status = receipt.httpStatus
      if (status < 400) status = typeof receipt.error.status === 'number' ? receipt.error.status : 502
      providerError = new HttpResponseError(status, JSON.stringify({ error: receipt.error }), 'judge observer')
    } else if (!upstream.ok) {
      providerError = new HttpResponseError(upstream.status, text ?? '', 'judge observer')
    } else if (receipt.transportError) providerError = new Error(receipt.transportError)
    admitted = false
    if (receipt.usage) {
      const count = budget.finish(id, receipt.usage)
      record({ type: 'usage', id, ...count, cumulative: budget.used })
    } else {
      const reserve = budget.reserveUnknown(id)
      record({ type: 'unknown_usage', id, reserve, reserved: budget.reserved, cumulative: budget.used })
    }
    if (!receipt.usage && !providerError) throw new Error('Judge usage missing after full response EOF')
    if (providerError) {
      record({ type: 'provider_attempt_failed', id, error: String(providerError), upstreamRetryPreserved: isRetryableError(providerError) })
      if (!receipt.transportError && !isRetryableError(providerError)) stopped = true
    }
    if (budget.blocked) stopped = true
    if (!res.headersSent) res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    res.end(text)
  } catch (error) {
    if (admitted) {
      if (sent) {
        const reserve = budget.reserveUnknown(id)
        record({ type: 'unknown_usage', id, reserve, reserved: budget.reserved, cumulative: budget.used })
      } else budget.fail(id)
    }
    if (!isRetryableError(error) || budget.blocked) stopped = true
    record({ type: stopped ? 'fatal' : 'provider_attempt_failed', id, error: String(error) })
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Evaluation judge request failed; inspect local receipt.' }))
  } finally { release() }
})
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve))
const port = server.address().port
const child = spawn(python, [path.join(import.meta.dirname, 'verify.py'), ...process.argv.slice(2), '--output', path.join(output, 'verifier-run')], {
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    WORKBUDDY_VERIFIER_LLM_BASE_URL: `http://host.docker.internal:${port}/v1`,
    WORKBUDDY_VERIFIER_LLM_API_KEY: credential, WORKBUDDY_VERIFIER_LLM_MODEL: conn.model_id,
    LLM_JUDGE_MAX_CONCURRENT: '1',
  },
})
const stop = () => { stopped = true; shutdown.abort(); child.kill('SIGTERM') }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
const log = fs.createWriteStream(path.join(output, 'verify.log'), { mode: 0o600 })
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => log.write(chunk.toString().split(conn.apikey).join('[REDACTED]').split(credential).join('[EVAL_TOKEN]')))
try {
  const exit = await new Promise(resolve => child.on('exit', resolve))
  await queue
  fs.writeFileSync(path.join(output, 'usage.json'), JSON.stringify({ used: budget.used, reserved: budget.reserved, requests: sequence,
    stopped, exit, model: conn.model_id, transport: 'benchmark-only-metered-endpoint',
    judgeConfiguration: 'current powerful model/thinking/output settings; upstream prompts, evidence and scoring unchanged',
  }, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ exit, used: budget.used, reserved: budget.reserved, requests: sequence, stopped }))
  if (exit || stopped) process.exitCode = 1
} finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); log.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
