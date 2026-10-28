// Runs inside one isolated task container. Production code is used unchanged.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { UnifiedAgent } from '../../src/unified-agent.ts'
import { CLI_DOMAINS } from '../../src/types.ts'
import { Budget } from './budget.mjs'

async function main() {
const readInput = async () => { let s = ''; for await (const c of process.stdin) s += c; return JSON.parse(s) }
const input = await readInput()
const root = process.env.DATA_DIR
if (!root || !root.startsWith('/eval-')) throw new Error('Isolated DATA_DIR required')
fs.mkdirSync(root, { recursive: true })
const secrets = Object.values(input.config.agent_config.model_config).map(c => c.apikey).filter(Boolean)
const clean = value => {
  let s = JSON.stringify(value, (key, v) => key === 'reasoning_content' || key === 'raw_reasoning' ? undefined : v)
  for (const secret of secrets) s = s.split(secret).join('[REDACTED]')
  return s
}
const emit = row => {
  const line = clean({ ts: new Date().toISOString(), ...row }) + '\n'
  fs.appendFileSync(path.join(root, 'evaluation.jsonl'), line, { mode: 0o600 })
  process.stdout.write('CRABOT_EVAL ' + line)
}
let fatal, active = 0, requests = 0, lastChange = Date.now(), agent
const budget = new Budget(input.limit, input.used ?? 0, input.reserved ?? 0)
const originalFetch = globalThis.fetch
let requestQueue = Promise.resolve()
let scriptedSpawned = false, scriptedWritten = false, scriptedAck = false, scriptedFinal = false, scriptedRead = false
function script(body) {
  if (input.scriptedError) return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\ndata: {"error":{"message":"synthetic overloaded","type":"upstream_error","code":502}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  const names = (body.tools ?? []).map(t => t.function.name)
  let name, args, text = ''
  if (names.includes('finish_task')) {
    if (!scriptedWritten) { scriptedWritten = true; name = 'Bash'; args = { command: 'printf 42 > /workspace/smoke-answer.txt' } }
    else { name = 'finish_task'; args = { outcome: 'completed', summary: '已写入 /workspace/smoke-answer.txt，内容为42。' } }
  } else if (!names.includes('spawn_worker')) { name = 'load_tool_family'; args = { family: 'worker' } }
  else if (!scriptedSpawned) { scriptedSpawned = true; name = 'spawn_worker'; args = { title: '校验真实执行', prompt: '请写入 /workspace/smoke-answer.txt，内容为42，然后完成。', workspace: '/workspace', impl: 'builtin' } }
  else if (!names.includes('send_message')) { name = 'load_tool_family'; args = { family: 'messaging' } }
  else if (!scriptedRead) { scriptedRead = true; name = 'get_message'; args = { channel_id: 'eval-channel', session_id: input.taskId, platform_message_id: 'eval-human-request' } }
  else if (fs.existsSync('/workspace/smoke-answer.txt') && JSON.stringify(body.messages).includes('已写入 /workspace/smoke-answer.txt') && !scriptedFinal) { scriptedFinal = true; name = 'send_message'; args = { channel_id: 'eval-channel', session_id: input.taskId, content: '执行完成：/workspace/smoke-answer.txt 的内容为42。', post_send_action: 'none' } }
  else if (!scriptedAck) { scriptedAck = true; name = 'send_message'; args = { channel_id: 'eval-channel', session_id: input.taskId, content: '正在执行。', post_send_action: 'none' } }
  else text = '本轮结束。'
  const delta = name ? { tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: text }
  return new Response([
    { id: randomUUID(), choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
  ].map(v => 'data: ' + JSON.stringify(v) + '\n\n').join('') + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } })
}
globalThis.fetch = async (url, options = {}) => {
  if (!String(url).endsWith('/chat/completions')) throw new Error('Unexpected external endpoint')
  const previous = requestQueue; let release
  requestQueue = new Promise(resolve => { release = resolve }); await previous
  const id = requests + 1
  if (input.scripted && id > 25) { release(); throw new Error('Scripted transport exceeded expected flow') }
  if (fatal) { release(); throw new Error('Evaluation stopped') }
  try { budget.begin(id) } catch (error) { fatal = String(error); release(); throw error }
  requests = id; active++; lastChange = Date.now()
  const body = JSON.parse(options.body)
  const role = body.tools?.some(t => t.function.name === 'finish_task') ? 'worker' : body.tools?.length ? 'manager' : 'compression'
  emit({ type: 'request', id, role, model: body.model, body })
  let usage, pending = '', ended = false, sawDone = false, providerError
  const settle = error => {
    if (ended) return; ended = true; active--; lastChange = Date.now()
    try {
      if (error) { budget.fail(id); throw error }
      const count = budget.finish(id, usage)
      emit({ type: 'usage', id, role, model: body.model, ...count, cumulative: budget.used })
    } catch (error) { fatal = String(error); emit({ type: 'fatal', id, error: fatal }) }
    release()
  }
  try {
    const response = input.scripted ? script(body) : await originalFetch(url, options)
    if (!response.ok || !response.body) { settle(new Error('Provider HTTP ' + response.status)); return response }
    const decoder = new TextDecoder()
    const stream = new TransformStream({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })
        const lines = pending.split('\n'); pending = lines.pop()
        if (lines.some(line => line.trim() === 'data: [DONE]')) sawDone = true
        for (const line of lines) if (line.startsWith('data: ') && !line.includes('[DONE]')) {
          try { const v = JSON.parse(line.slice(6)); if (v.usage) usage = v.usage
            if (v.error) { providerError = JSON.stringify(v.error); emit({ type: 'provider_error', id, error: v.error }) }
            if (v.choices) emit({ type: 'response_delta', id, choices: v.choices })
          } catch {}
        }
        controller.enqueue(chunk)
      }, flush() { settle(providerError ? new Error(providerError) : undefined) },
    })
    const reader = response.body.getReader()
    const monitored = new ReadableStream({ async pull(controller) {
      try { const v = await reader.read(); if (v.done) controller.close(); else controller.enqueue(v.value) }
      catch (e) { settle(e); controller.error(e) }
    }, async cancel(reason) { settle(sawDone && usage ? undefined : new Error(providerError ?? 'Provider stream cancelled')); await reader.cancel(reason) } })
    return new Response(monitored.pipeThrough(stream), { status: response.status, headers: response.headers })
  } catch (e) { settle(e); throw e }
}
const now = () => new Date().toISOString()
const friend = { id: 'eval-human', display_name: '评测用户', permission: 'master', channel_identities: [], created_at: now(), updated_at: now() }
const permissions = {
  tool_access: { memory: true, messaging: true, mcp_skill: true, file_io: true, shell: true, desktop: false },
  cli_access: Object.fromEntries(CLI_DOMAINS.map(d => [d, 'none'])),
  storage: { workspace_path: '/workspace', access: 'readwrite' }, memory_scopes: [input.taskId],
}
const outbox = [], memory = []
const session = { channel_id: 'eval-channel', session_id: input.taskId, type: 'private' }
const message = { platform_message_id: 'eval-human-request', sender: { friend_id: friend.id,
  platform_user_id: friend.id, platform_display_name: friend.display_name }, session,
  content: { type: 'text', text: input.instruction }, features: { is_mention_crab: false }, platform_timestamp: now() }
const page = items => ({ items, pagination: { page: 1, page_size: 100, total_items: items.length, total_pages: items.length ? 1 : 0 } })
const rpc = async (_port, method, params) => {
  emit({ type: 'rpc', method, params }); lastChange = Date.now()
  if (method === 'issue_agent_cli_credential') return { token: 'isolated-eval-unusable-credential', expires_at: new Date(Date.now() + 3600000).toISOString() }
  if (method === 'resolve_principal_permissions') return { resolved: permissions, sources: {} }
  if (method === 'get_friend' || method === 'resolve_friend') return { friend }
  if (method === 'get_session') return { session }
  if (method === 'get_sessions') return page([{ ...session, id: input.taskId, name: input.taskId }])
  if (method === 'get_history') return page([message])
  if (method === 'get_message') {
    if (params.session_id !== input.taskId || params.platform_message_id !== message.platform_message_id) throw new Error('NOT_FOUND: evaluation message')
    const { session: _session, ...historyMessage } = message
    return historyMessage
  }
  if (method === 'get_scene_profile') return { profile: null }
  if (method === 'send_message') {
    if (params.session_id !== input.taskId || (params.channel_id && params.channel_id !== session.channel_id)) throw new Error('Outbox target mismatch')
    const receipt = { platform_message_id: 'eval-out-' + outbox.length, sent_at: now() }
    outbox.push({ ...params, ...receipt }); emit({ type: 'outbox', ...params, ...receipt }); return receipt
  }
  if (method === 'get_capabilities') return { supported_message_types: ['text', 'file'], supported_features: [], supports_history_query: true, supports_platform_user_query: false, max_message_length: null, max_file_size: null, supports_file_path: true, supports_list_contacts: false, supports_list_groups: false, supports_list_group_members: false }
  if (method === 'add_reaction' || method === 'publish_event') return {}
  if (method === 'search_short_term' || method === 'search_long_term' || method === 'search_memory') return { results: [] }
  if (method === 'list_entries') return { entries: memory, pagination: page(memory).pagination }
  if (method === 'quick_capture') { const entry = { ...params, id: randomUUID(), status: 'inbox' }; memory.push(entry); return { id: entry.id, status: 'ok' } }
  if (method === 'get_runtime_identity') return { module_id: 'eval-boundary', module_type: 'memory', pid: 1, started_at: now() }
  fatal = 'Unsupported evaluation RPC boundary: ' + method
  throw new Error(fatal)
}
let result = { status: 'failed' }
try {
  agent = new UnifiedAgent(input.config)
  agent.rpcClient.call = rpc; agent.rpcClient.callSensitive = rpc
  agent.rpcClient.resolve = async () => [{ port: 1 }]
  const stack = agent.managerStack
  await agent.agentHandler.releaseRecoveredWorkerEntityExits()
  const key = 'eval-channel::' + input.taskId
  const routed = stack.registry.routeHumanMessages('eval-channel', input.taskId, [message], friend)
  let initialDone = false
  routed.then(r => { initialDone = true; emit({ type: 'initial_episode', result: r }) }, e => { fatal = String(e); initialDone = true })
  const deadline = Date.now() + input.timeoutMs
  while (Date.now() < deadline && !fatal) {
    const workers = await stack.ledger.listWorkers(key)
    const busy = workers.some(w => w.incarnations.some(i => i.state === 'running' || i.state === 'starting'))
    const background = (await agent.agentHandler.getBuiltinBgEntityRegistry().list()).some(r => r.status === 'running')
    const pendingNotifications = (await Promise.all(workers.map(w => agent.agentHandler.hasPendingWorkerNotification(w.worker_id)))).some(Boolean)
    if (initialDone && !active && !busy && !background && !pendingNotifications && !stack.registry.isEpisodeActive(key)
      && Date.now() - lastChange > 3000) break
    await new Promise(r => setTimeout(r, 100))
  }
  const workers = await stack.ledger.listWorkers(key)
  result = { status: fatal ? 'evaluation_error' : Date.now() >= deadline ? 'timeout' : 'ended',
    error: fatal, used: budget.used, reserved: budget.reserved, requests, outbox, workers }
  if (input.scripted && !input.scriptedError && (!fs.existsSync('/workspace/smoke-answer.txt') || !outbox.some(m => (typeof m.content === 'string' ? m.content : m.content?.text)?.includes('42'))))
    throw new Error('Scripted end-to-end acceptance failed')
} catch (e) { result = { ...result, error: String(e), used: budget.used, reserved: budget.reserved, requests }; process.exitCode = 1 }
finally {
  if (agent) await Promise.race([agent.stop().catch(e => emit({ type: 'cleanup_error', error: String(e) })), new Promise(r => setTimeout(r, 5000))])
  fs.writeFileSync(path.join(root, 'result.json'), clean(result), { mode: 0o600 })
  emit({ type: 'result', ...result })
  setTimeout(() => process.exit(process.exitCode ?? 0), 100)
}

}
main().catch(error => { console.error(error); process.exitCode = 1 })
