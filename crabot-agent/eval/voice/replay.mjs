// Synthetic voice conversations only. Every tool and playback receipt is local.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '../..')
const { ModelProviderManager } = require(path.join(root, '../crabot-admin/dist/model-provider-manager.js'))
const { createAdapter } = require(path.join(root, 'dist/engine/llm-adapter.js'))
const { thinkingParam } = require(path.join(root, 'dist/engine/llm-adapter-types.js'))
const { ManagerLoop } = require(path.join(root, 'dist/manager/loop.js'))
const { ManagerSessionStore } = require(path.join(root, 'dist/manager/session-store.js'))
const { ManagerWorkboardStore } = require(path.join(root, 'dist/manager/workboard-store.js'))
const { buildManagerToolFace } = require(path.join(root, 'dist/manager/tools/tool-face.js'))
const { createCrabMemoryServer } = require(path.join(root, 'dist/mcp/crab-memory.js'))
const { BUILTIN_WORKER_PERMISSIONS } = require(path.join(root, 'dist/workers/builtin/runtime.js'))
const { createAssistantMessage, createToolResultMessage } = require(path.join(root, 'dist/engine/index.js'))
const { proxyManager } = require(path.join(root, '../crabot-shared/dist/index.js'))
const data = process.env.VOICE_REPLAY_DATA, output = process.env.VOICE_REPLAY_OUTPUT
if (!data || !output) throw new Error('VOICE_REPLAY_DATA and VOICE_REPLAY_OUTPUT are required')
fs.mkdirSync(output, { recursive: true, mode: 0o700 })
const config = JSON.parse(fs.readFileSync(path.join(data, 'admin/agent-configs/crabot-agent.json')))
const models = new ModelProviderManager(path.join(data, 'admin')); await models.loadData()
const ref = config.model_config.powerful, connection = await models.buildConnectionInfo(ref.provider_id, ref.model_id)
const global = JSON.parse(fs.readFileSync(path.join(data, 'admin/global_model_config.json')))
proxyManager.updateConfig(global.proxy)
const adapter = createAdapter({ endpoint: connection.endpoint, apikey: connection.apikey, format: connection.format, accountId: connection.account_id })
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-behavior-'))
const key = 'voice-fixture::group'
const permissions = { ...BUILTIN_WORKER_PERMISSIONS, tool_access: { ...BUILTIN_WORKER_PERMISSIONS.tool_access, messaging: true, memory: false } }
const cases = [
  { id: 'simple', text: '螃蟹，二加二等于几？' },
  { id: 'query', text: '螃蟹，请用 inspect_crabot 查询 deployment，然后告诉我当前是否健康。' },
  { id: 'cross-channel', text: '螃蟹，请用 send_message 向 channel_id=remote、session_id=fixture-group 发送“测试成功”，我已授权这个测试目标；然后告诉我结果。' },
  { id: 'old-history', text: '螃蟹，再告诉我三乘三等于几？', history: true },
  { id: 'clarify', text: '螃蟹，帮我设置一个提醒。' },
  { id: 'failure', text: '螃蟹，请用 inspect_crabot 查询 deployment，失败的话告诉我实际情况。', failure: true },
  { id: 'silent', text: '小明对小红说：明天一起吃饭吧。', mention: false },
]
const results = []
try {
  for (const scenario of cases) {
    const toolCalls = [], requests = [], spoken = [], records = []
    const dir = path.join(sandbox, scenario.id), sessionStore = new ManagerSessionStore(dir)
    if (scenario.history) await sessionStore.save({ key, foldedCount: 0, recent: [
      createAssistantMessage([{ type: 'tool_use', id: 'old', name: 'send_message', input: { channel_id: 'voice-fixture', session_id: 'group', content: '旧工具回复' } }], 'tool_use'),
      createToolResultMessage('old', JSON.stringify({ platform_message_id: 'old-sent', sent_at: new Date().toISOString() })),
    ] })
    const rpc = { call: async () => { throw new Error('External RPC disabled in synthetic replay') }, callSensitive: async () => { throw new Error('External RPC disabled') } }
    const face = buildManagerToolFace({ voice: true, isSystemThread: false, managerTarget: { channel_id: 'voice-fixture', session_id: 'group' },
      harness: { listWorkers: async () => [] }, workerContext: () => ({ managerKey: key, reportTo: { channel_id: 'voice-fixture', session_id: 'group' }, principalPermissions: permissions }),
      messagingDeps: { rpcClient: rpc, moduleId: 'fixture', getAdminPort: async () => 1, resolveChannelPort: async () => 1 },
      memoryServer: createCrabMemoryServer({ rpcClient: rpc, moduleId: 'fixture', getMemoryPort: async () => 1 }, { accessContext: { actor_kind: 'conversation', memory_enabled: false }, visibility: 'internal', scopes: [], isMasterPrivate: false }),
      callAdmin: async () => ({}), workboard: { store: new ManagerWorkboardStore(path.join(dir, 'boards')), managerKey: key },
      projectDocs: { ledger: { listWorkers: async () => [], findWorker: async () => undefined }, readWorkerContext: async () => undefined, managerKey: key },
    }).map(tool => ({ ...tool, call: async input => {
      toolCalls.push({ name: tool.name, input })
      if (tool.name === 'inspect_crabot') return { output: scenario.failure ? '测试服务暂时不可用' : JSON.stringify({ healthy: true, modules: ['admin', 'agent', 'memory'] }), isError: !!scenario.failure }
      if (tool.name === 'send_message' && input.channel_id === 'remote' && input.session_id === 'fixture-group') return { output: JSON.stringify({ platform_message_id: 'simulated-external-send', sent_at: new Date().toISOString() }) }
      return { output: '该工具在本合成测试中不可用；请说明或询问必要信息，不重复调用。', isError: true }
    } }))
    const observed = { updateConfig: () => {}, stream: async function* (params) {
      requests.push({ systemPrompt: params.systemPrompt, tools: params.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), messages: params.messages })
      yield* adapter.stream({ ...params, signal: AbortSignal.timeout(60000) })
    } }
    let current = ''
    const context = { channel_id: 'voice-fixture', session_id: 'group', turn_id: scenario.id, connection_epoch: 'fixture', expires_at: new Date(Date.now() + 60000).toISOString() }
    const started = Date.now()
    const loop = new ManagerLoop({ key, store: sessionStore, isSystemThread: false, policy: { keepRecent: 10, hardCapTokens: 1000000 },
      adapter: () => observed, model: () => connection.model_id, thinking: () => thinkingParam(config.thinking?.powerful?.thinking_level, config.thinking?.powerful?.thinking_custom),
      maxTurns: 6, contextWindowTokens: () => 200000, toolFace: () => face, promptInputs: () => ({ isGroup: true, adminPersonality: config.system_prompt }),
      harness: { listWorkers: async () => [] }, now: () => new Date(), markPendingReply: () => {}, hasPendingReply: () => true,
      voiceOutput: { isVoice: () => true, save: r => { records.push(structuredClone(r)) }, records: () => records.slice(-3), send: async ({ event }) => {
        if (event.type === 'reply_start') current = ''
        if (event.type === 'reply_text') current += event.text
        if (event.type === 'reply_end') { spoken.push(current); return { platform_message_id: event.playback_id, sent_at: new Date().toISOString(), played_samples: 480 } }
        return { accepted: true }
      } },
    })
    const message = { platform_message_id: scenario.id, session: { channel_id: 'voice-fixture', session_id: 'group', type: 'group' }, sender: { platform_user_id: 'fixture-user', platform_display_name: '测试用户' }, content: { type: 'text', text: scenario.text }, features: { is_mention_crab: scenario.mention !== false }, platform_timestamp: new Date().toISOString() }
    const result = await loop.wakeUp({ wake: { kind: 'human_messages', messages: [message] }, received_at: new Date().toISOString(), timezone: 'Asia/Shanghai', voice_reply_context: context })
    const expectedTool = ['query', 'failure'].includes(scenario.id) ? 'inspect_crabot' : scenario.id === 'cross-channel' ? 'send_message' : undefined
    const passed = (scenario.id === 'silent' ? spoken.length === 0 : spoken.length > 0)
      && (!expectedTool || toolCalls.some(t => t.name === expectedTool))
      && !toolCalls.some(t => t.name === 'send_message' && t.input.channel_id !== 'remote')
      && requests.every(r => !r.systemPrompt.includes('用工具投递答复，普通文本不外发') && !JSON.stringify(r.messages).includes('只有 send_message 发送的内容才能送达人类'))
    const row = { id: scenario.id, passed, outcome: result.outcome, spoken, toolCalls, requests: requests.length, ms: Date.now() - started, playback: 'simulated-completed', external_side_effects: 0 }
    results.push(row)
    fs.writeFileSync(path.join(output, scenario.id + '.json'), JSON.stringify({ result: row, requests }, null, 2), { mode: 0o600 })
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ model: connection.model_id, format: connection.format, results }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(row))
  }
} finally { fs.rmSync(sandbox, { recursive: true, force: true }) }
if (results.some(r => !r.passed)) process.exitCode = 1
