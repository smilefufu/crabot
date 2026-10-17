import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { digest } from './runtime.mjs'
const require = createRequire(new URL('../../package.json', import.meta.url))
const { assembleManagerSystemPrompt, VOICE_REPLY_PROMPT, SHARED_REQUEST_BOUNDARY, REQUEST_CONTEXT_PROMPT, VOICE_MANAGEMENT_REQUEST_PROMPT } = require('./dist/manager/prompt.js')
const { assembleBuiltinWorkerPrompt } = require('./dist/prompts/builtin-worker.js')
const { renderGuidance } = require('./dist/guidance/catalog.js')
const { buildManagerToolFace } = require('./dist/manager/tools/tool-face.js')
const { createManagerToolFaceState, NORMAL_MANAGER_CORE_NAMES, DAILY_REFLECTION_CORE_NAMES, MEMORY_GRAPH_REBUILD_CORE_NAMES } = require('./dist/manager/tools/tool-catalog.js')
const { createCrabMemoryServer } = require('./dist/mcp/crab-memory.js')
const { TOOL_ENTRY_EXPLANATIONS } = require('../crabot-shared/dist/index.js')
const output = process.env.REQUEST_REPLAY_OUTPUT
if (!output) throw new Error('REQUEST_REPLAY_OUTPUT required')
await fs.mkdir(output, { recursive: true, mode: 0o700 })
const base = { managerKey: 'synthetic::shared', isSystemThread: false, isGroup: true }
const variants = [
  ['private', { ...base, isGroup: false }], ['group', { ...base, requestAuthorization: 'shared' }],
  ['voice-group', { ...base, requestAuthorization: 'shared', voice: true }],
  ['request', { ...base, requestAuthorization: 'request' }], ['voice-request', { ...base, requestAuthorization: 'request', voice: true }],
  ['system', { ...base, isSystemThread: true }], ['daily-reflection', { ...base, isSystemThread: true, isBuiltinDailyReflection: true }],
]
const rows = []
for (const [name, input] of variants) {
  const prompt = assembleManagerSystemPrompt(input)
  const requestAware = !input.isSystemThread && input.isGroup && input.requestAuthorization
  if (requestAware) {
    assert.ok(!prompt.includes('以人类最新提出或确认的要求为准'))
    assert.ok(!prompt.includes('在现有会话授权覆盖时由你直接组织执行并代表人类委托'))
    assert.ok(prompt.includes(input.requestAuthorization === 'shared' ? SHARED_REQUEST_BOUNDARY : REQUEST_CONTEXT_PROMPT))
  }
  if (input.voice) { assert.ok(prompt.includes(VOICE_REPLY_PROMPT)); assert.ok(!prompt.includes('用工具投递答复，普通文本不外发')) }
  assert.equal(prompt.includes(VOICE_MANAGEMENT_REQUEST_PROMPT), !!input.voice && input.requestAuthorization === 'shared')
  if (!requestAware) { for (const mode of ['shared', 'request']) assert.equal(assembleManagerSystemPrompt({ ...input, requestAuthorization: mode }), prompt) }
  rows.push({ profile: name, prompt_sha256: digest(prompt), characters: prompt.length, prompt })
}
const worker = assembleBuiltinWorkerPrompt({ workspaceRoot: '/synthetic/worker', imageAvailable: false, skillListing: '' })
assert.ok(!worker.includes(SHARED_REQUEST_BOUNDARY)); assert.ok(!worker.includes(REQUEST_CONTEXT_PROMPT))
assert.equal(renderGuidance('worker', 'worker.project-context', { requestAware: true }), renderGuidance('worker', 'worker.project-context'))
rows.push({ profile: 'worker', prompt_sha256: digest(worker), characters: worker.length, prompt: worker })
const never = async () => { throw new Error('Prompt audit cannot execute operations') }
const transport = { rpcClient: { call: never, callSensitive: never }, moduleId: 'audit', getMemoryPort: never }
const catalog = []
for (const [profile, expected] of [['normal', NORMAL_MANAGER_CORE_NAMES], ['daily_reflection', DAILY_REFLECTION_CORE_NAMES], ['memory_graph_rebuild', MEMORY_GRAPH_REBUILD_CORE_NAMES]]) {
  const face = buildManagerToolFace({
    harness: {}, profile, isBuiltinDailyReflection: profile === 'daily_reflection', faceState: createManagerToolFaceState('progressive'), workerContext: () => ({ managerKey: base.managerKey }),
    messagingDeps: { ...transport, getAdminPort: never, resolveChannelPort: never }, memoryServer: createCrabMemoryServer(transport, { visibility: 'internal', scopes: [], isMasterPrivate: false }),
    callAdmin: never, isSystemThread: false, managerTarget: { channel_id: 'synthetic', session_id: 'shared' }, workboard: { store: {}, managerKey: base.managerKey }, projectDocs: {}
  })
  const names = face.map(tool => tool.name)
  assert.deepEqual(names, [...expected]); catalog.push({ profile, names, core_count: names.length })
}
const pending = []
if (TOOL_ENTRY_EXPLANATIONS.desktop.includes('仅可信 Master 私聊')) pending.push({ location: 'crabot-shared/src/permission-entries.ts:desktop', current: TOOL_ENTRY_EXPLANATIONS.desktop, status: 'awaiting_user_wording_confirmation' })
await fs.writeFile(path.join(output, 'prompt-audit.json'), JSON.stringify({ schema_version: 1, rows, catalog, pending }, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ profiles: rows.map(({ profile, characters }) => ({ profile, characters })), catalog, pending }))

// Inspect the actual adapter inputs saved by a replay, separately from prompt assembly.
const replayAudits = []
for (const replayRoot of process.argv.slice(2)) {
  const scenarios = []
  for (const item of await fs.readdir(replayRoot, { withFileTypes: true })) {
    if (!item.isDirectory()) continue
    const scenarioRoot = path.join(replayRoot, item.name)
    const eventFile = path.join(scenarioRoot, 'events.jsonl')
    const raw = await fs.readFile(eventFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    if (!raw) continue
    const events = raw.trim().split('\n').map(line => JSON.parse(line))
    const inputs = events.filter(event => event.type === 'model_input')
    const source = events.find(event => event.type === 'scenario_start')
    const result = events.findLast(event => event.type === 'scenario_result')?.result
    let shared = 0, requests = 0, workers = 0
    const failures = []
    const check = (condition, reason) => { if (!condition) failures.push(reason ?? 'prompt boundary mismatch') }
    for (const input of inputs) {
      if (input.role === 'worker') {
        workers++
        check(!input.systemPrompt.includes(SHARED_REQUEST_BOUNDARY))
        check(!input.systemPrompt.includes(REQUEST_CONTEXT_PROMPT))
        check(!input.tools.some(tool => ['send_message', 'send_private_message', 'execute_request', 'list_voice_contacts', 'manage_voice_contacts', 'get_voice_management_result'].includes(tool.name)))
        continue
      }
      if (input.systemPrompt.includes(REQUEST_CONTEXT_PROMPT)) {
        requests++
        check(!input.systemPrompt.includes(SHARED_REQUEST_BOUNDARY))
        check(!input.systemPrompt.includes('以人类最新提出或确认的要求为准'))
        check(!input.tools.some(tool => tool.name === 'execute_request'))
        const fixed = result?.request_records.find(value => input.systemPrompt.includes(`"request_id":"${value.request.request_id}"`))
        const original = result?.source_inputs.find(value => value.source_id === fixed?.request.source_id)
        check(original && input.systemPrompt.includes(JSON.stringify(original.message.content.text).slice(1, -1)), `model call ${input.number}: verified complete original missing`)
        for (const other of result?.source_inputs.filter(value => value.source_id !== fixed?.request.source_id) ?? []) {
          check(!JSON.stringify(input.messages).includes(JSON.stringify(other.message.content.text).slice(1, -1)), 'another original input entered fixed personal request')
        }
      } else {
        shared++
        check(input.systemPrompt.includes(SHARED_REQUEST_BOUNDARY))
        check(!input.tools.some(tool => ['list_voice_contacts', 'manage_voice_contacts', 'get_voice_management_result'].includes(tool.name)), 'voice management escaped the isolated request')
        check(!input.systemPrompt.includes('以人类最新提出或确认的要求为准'))
        if (source?.scenario_config.task === 'private') {
          const doc = await fs.readFile(path.join(scenarioRoot, 'data', 'owner-files', 'README.md'), 'utf8')
          const canary = doc.match(/B7_PRIVATE_[a-f0-9]+/)[0]
          check(!JSON.stringify(input).includes(canary), 'private body entered shared model input')
        }
      }
      if (source?.scenario_config.voice) {
        check(input.systemPrompt.includes(VOICE_REPLY_PROMPT), `model call ${input.number}: voice profile missing`)
        check(!input.systemPrompt.includes('用工具投递答复，普通文本不外发'), `model call ${input.number}: old text-delivery rule present`)
      }
    }
    scenarios.push({
      scenario: item.name, shared_model_calls: shared, request_model_calls: requests, worker_model_calls: workers,
      result: result?.status ?? 'no_final_result', actual_prompt_checks: failures.length ? 'failed' : 'passed', failures
    })
  }
  replayAudits.push({ replay: path.basename(replayRoot), scenarios })
}
await fs.writeFile(path.join(output, 'actual-input-audit.json'), JSON.stringify(replayAudits, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ actual_inputs: replayAudits }))

if (replayAudits.some(replay => replay.scenarios.some(scenario => scenario.actual_prompt_checks === 'failed'))) process.exitCode = 1
