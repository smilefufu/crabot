import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildManagerStack, type BootstrapDeps, type ManagerStack } from '../../src/manager/bootstrap.js'
import { createCrabMemoryServer, type MemoryTaskContext } from '../../src/mcp/crab-memory.js'
import { WorkerTurnStore } from '../../src/workers/harness/worker-turn-store.js'
import type { ConversationRequestRecord } from '../../src/manager/conversation-request.js'
import { WorkerContextStore } from '../../src/workers/harness/context-store.js'
import { ConfigLoader } from '../../src/core/config-loader.js'
import type { ResolvedPermissions, ChannelMessage } from '../../src/types.js'
import type { LLMStreamParams, ToolCallResult } from '../../src/engine/index.js'
import type { RequestPermissionSource } from '../../src/manager/request-permission-sources.js'
import { VOICE_REPLY_PROMPT } from '../../src/manager/prompt.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

const key = 'voice::group' as const
const message = (): ChannelMessage => ({ platform_message_id: 'original', platform_timestamp: new Date().toISOString(),
  session: { channel_id: 'voice', session_id: 'group', type: 'group' }, sender: { platform_user_id: 'owner', platform_display_name: 'Untrusted Master' },
  content: { type: 'text', text: '查询这件事，结果私聊发我。不要发到群里。' }, features: { is_mention_crab: true } })
const permissions = (): ResolvedPermissions => ({ tool_access: { memory: false, messaging: false, task: true, mcp_skill: false, file_io: false, browser: false, shell: false, remote_exec: false, desktop: false },
  cli_access: { provider: 'none', agent: 'none', mcp: 'none', skill: 'none', schedule: 'none', channel: 'none', friend: 'none', permission: 'none', config: 'none', undo: 'none' }, storage: null, memory_scopes: [] })

describe('production isolated request tool closure', () => {
  let root: string, stack: ManagerStack, group: RequestPermissionSource, friend: RequestPermissionSource
  let current: { group: RequestPermissionSource; friend: RequestPermissionSource | null }
  let inspect: (params: LLMStreamParams) => Promise<void>, calls: LLMStreamParams[], contexts: MemoryTaskContext[]
  let rpc: ReturnType<typeof vi.fn>, admin: ReturnType<typeof vi.fn>, afterLookup: (() => void) | undefined
  let inspectErrors: unknown[]
  let plannedText: string | undefined
  let planned: { name: string; input: Record<string, unknown> } | undefined
  let results: Record<string, ToolCallResult>, throwSend: boolean, voiceChannel: boolean
  beforeEach(async () => {
    vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_MODE', 'progressive')
    vi.stubEnv('CRABOT_MANAGER_TOOL_LOADING_KEYS', '')
    inspectErrors = []
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'request-production-'))
    group = { kind: 'group', subject_id: key, is_master: false, resolved: permissions() }
    friend = { kind: 'friend', subject_id: 'f-owner', is_master: true, resolved: permissions() }
    friend.resolved.tool_access.messaging = true; friend.resolved.tool_access.memory = true; friend.resolved.memory_scopes = ['personal']
    current = { group, friend }; calls = []; contexts = []; results = {}; throwSend = false; voiceChannel = false; afterLookup = undefined
    inspect = async () => {}; planned = undefined
    vi.spyOn(ConfigLoader, 'getRuntimeBearer').mockReturnValue('fixture-runtime')
    rpc = vi.fn(async (_port, method, params) => {
      if (method === 'resolve_request_permission_sources') return structuredClone({ group, friend })
      if (method === 'resolve_request_permission_source') return { source: structuredClone(current[params.kind as 'group' | 'friend']) }
      if (method === 'get_capabilities') return voiceChannel ? { voice: { protocol_version: 6 } } : {}
      if (method === 'get_friend') { afterLookup?.(); return { friend: { display_name: 'Owner', channel_identities: [{ channel_id: 'chat', platform_user_id: 'owner-chat' }] } } }
      if (method === 'get_session') return { session: { type: 'private', platform_session_id: params.session_id === 'owner-private' ? 'owner-chat' : 'other' } }
      if (method === 'find_or_create_private_session') return { session: { id: 'owner-private' } }
      if (method === 'send_message') { if (throwSend) throw new Error('PRIVATE_BACKEND_ERROR'); return { platform_message_id: 'delivered', sent_at: new Date().toISOString() } }
      if (method === 'search_long_term') return { results: [] }
      return {}
    })
    admin = vi.fn(async (method, params) => method === 'get_friend' ? { friend: { channel_identities: [{ channel_id: 'chat', platform_user_id: 'owner-chat' }] } } : method === 'get_schedule' ? { schedule: { id: params.schedule_id, script: { source_sha256: 'abc' }, creator_friend_id: 'f-owner', target_session: message().session } } : {})
    const deps: BootstrapDeps = { dataRoot: root, now: () => new Date().toISOString(), timezone: () => 'Asia/Shanghai',
      managerModel: () => 'fixture', managerAdapter: () => ({ updateConfig() {}, async *stream(params) { calls.push(params); planned = undefined; plannedText = undefined; try { await inspect(params) } catch (error) { inspectErrors.push(error); throw error } yield* chunksFromContent(planned ? [{ type: 'tool_use', id: 'engine-' + calls.length, ...planned }] : plannedText ? [{ type: 'text', text: plannedText }] : [], planned ? 'tool_use' : 'end_turn') } }),
      coreRuntimeBearer: () => 'fixture-core', messagingDeps: { rpcClient: { call: rpc, callSensitive: rpc } as never, moduleId: 'crabot-agent', getAdminPort: async () => 10, resolveChannelPort: async () => 20 },
      memoryServerFor: ctx => { contexts.push(ctx); return createCrabMemoryServer({ rpcClient: { call: rpc, callSensitive: rpc } as never, moduleId: 'crabot-agent', getMemoryPort: async () => 30 }, ctx) },
      callAdmin: admin as never,
      principalResolver: { crabSelfHandle: () => undefined, getSessionType: async () => 'group', resolvePermissions: async () => structuredClone(group.resolved), sessionMemoryScopes: async () => ['group'], sceneProfile: async () => null,
        resolveChannelSender: async () => ({ id: 'f-owner', display_name: 'Owner', permission: 'master', channel_identities: [{ channel_id: 'voice', platform_user_id: 'owner' }], created_at: 't', updated_at: 't' }) },
    }
    stack = buildManagerStack(deps)
    await stack.principals.init()
    await stack.startContinuationReconciliation()
  })
  afterEach(async () => { await stack.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); expect(inspectErrors).toEqual([]) })
  async function execute(delivery: 'origin' | 'requester_private' = 'requester_private') {
    const inputs = await stack.trustedHumanInputs.capture(key, [message()])
    return stack.requestRunner.execute(key, inputs, { source_id: inputs[0].source_id, delivery })
  }
  async function bindPersonalWorker(record: ConversationRequestRecord) {
    await stack.conversationRequests.attachWorker(key, record.request_id, 'w-personal')
    const binding = { schema_version: 1 as const, request_id: record.request_id, source_sha256: record.source_sha256, execution_scope: 'request' as const }
    await stack.ledger.upsertWorker(key, 'w-personal', () => ({ worker_id: 'w-personal', manager_key: key,
      task: { id: 'w-personal', title: 'private', status: 'running', created_at: new Date().toISOString() },
      origin: { trigger_type: 'message', creator_friend_id: 'f-owner', request: binding }, report_to: { channel_id: 'voice', session_id: 'group' }, incarnations: [], updated_at: new Date().toISOString() }))
    await new WorkerContextStore(path.join(root, 'agent', 'workers')).write('w-personal', { schema_version: 2, manager_key: key, creator_friend_id: 'f-owner', request: binding, target_session: message().session })
    const turns = new WorkerTurnStore(path.join(root, 'agent', 'workers'))
    const turn = await turns.create({ worker_id: 'w-personal', manager_key: key, incarnation_id: 'fixture-incarnation', impl: 'builtin', seq: 1, session_ref: 'fixture', activity_from: '0', activity_through: '1', completed_at: new Date().toISOString(), completion_source: 'builtin_end_turn' })
    return { turns, turn }
  }
  function tool(params: LLMStreamParams, name: string) { const result = params.tools.find(item => item.name === name); expect(result, name).toBeDefined(); return result! }
  const context = { toolUseId: 'fixture-tool', signal: new AbortController().signal } as never

  it.each(['origin', 'requester_private'] as const)('keeps the known voice origin profile without inventing an audio opportunity (%s)', async delivery => {
    voiceChannel = true
    const prime = message()
    prime.platform_message_id = 'prime-channel-capabilities'
    prime.content = { type: 'text', text: '你好' }
    await stack.registry.routeHumanMessages('voice', 'group', [prime])
    let seen = false
    inspect = async params => {
      seen = true
      if (delivery === 'origin') {
        expect(params.systemPrompt).toContain(VOICE_REPLY_PROMPT)
        expect(params.systemPrompt).not.toContain('用工具投递答复，普通文本不外发')
        expect(tool(params, 'send_message').description).toContain('voice_reply')
        plannedText = '<voice_reply>没有可用回答机会时不能播报这段话。</voice_reply>'
      } else {
        expect(params.systemPrompt).not.toContain(VOICE_REPLY_PROMPT)
      }
    }
    await execute(delivery)
    expect(seen).toBe(true)
    expect(rpc.mock.calls.filter(call => call[1] === 'voice_output')).toEqual([])
  })

  it('uses existing lazy families and private target proof without leaking body to shared stores', async () => {
    let turn = 0
    inspect = async params => {
      if (turn++ > 0) return
      expect(params.systemPrompt).toContain('已经由系统固定来源的请求')
      expect(params.systemPrompt).toContain('requester_private')
      expect(params.tools.map(item => item.name)).not.toContain('execute_request')
      const family = await tool(params, 'load_tool_family').call({ family: 'messaging' }, context)
      expect(JSON.parse(family.output)).toMatchObject({ complete: true })
      results.group = await tool(params, 'send_message').call({ channel_id: 'voice', session_id: 'group', content: 'PRIVATE_BODY', post_send_action: 'none' }, context)
    }
    const result = await execute()
    expect(results.group.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_BODY')
    expect(JSON.stringify(await stack.store.load(key))).not.toContain('PRIVATE_BODY')
    expect((await stack.workboard.load(key)).objectives).toEqual([])
    expect(rpc.mock.calls.filter(call => call[1] === 'send_message')).toEqual([])
  })

  it('executes friend messaging via the actual Manager tools and records successful private delivery', async () => {
    let turn = 0
    inspect = async params => {
      if (turn++ === 0) { planned = { name: 'load_tool_family', input: { family: 'messaging' } }; return }
      if (turn === 2) {
        results.other = await tool(params, 'send_private_message').call({ friend_id: 'other', content: 'PRIVATE_BODY', post_send_action: 'none' }, context)
        results.sent = await tool(params, 'send_private_message').call({ friend_id: 'f-owner', content: 'PRIVATE_BODY', post_send_action: 'none' }, context)
      }
    }
    await execute()
    expect(results.other.isError).toBe(true); expect(results.sent.isError).toBe(false)
    const sent = rpc.mock.calls.filter(call => call[1] === 'send_message')
    expect(sent).toHaveLength(1); expect(sent[0][2]).toMatchObject({ session_id: 'owner-private', content: { text: 'PRIVATE_BODY' } })
    expect(JSON.stringify(await stack.store.load(key))).not.toContain('PRIVATE_BODY')
  })

  it('rechecks the same source after private-session lookup and refuses revoked delivery', async () => {
    let turn = 0
    inspect = async params => {
      if (turn++ === 0) { planned = { name: 'load_tool_family', input: { family: 'messaging' } }; return }
      if (turn === 2) {
        afterLookup = () => { current = { group, friend: null } }
        results.sent = await tool(params, 'send_private_message').call({ friend_id: 'f-owner', content: 'PRIVATE_BODY', post_send_action: 'none' }, context)
      }
    }
    await execute()
    expect(results.sent.isError).toBe(true)
    expect(rpc.mock.calls.some(call => call[1] === 'send_message')).toBe(false)
  })

  it('does not retry an uncertain send or fall back to the group', async () => {
    let turn = 0; throwSend = true
    inspect = async params => {
      if (turn++ === 0) { planned = { name: 'load_tool_family', input: { family: 'messaging' } }; return }
      if (turn === 2) {
        results.sent = await tool(params, 'send_private_message').call({ friend_id: 'f-owner', content: 'PRIVATE_BODY', post_send_action: 'none' }, context)
        results.retried = await tool(params, 'send_private_message').call({ friend_id: 'f-owner', content: 'PRIVATE_BODY', post_send_action: 'none' }, context)
      }
    }
    const result = await execute()
    expect(results.sent.isError).toBe(true); expect(results.retried.isError).toBe(true)
    expect(result.status).toBe('recovery_required')
    expect(rpc.mock.calls.filter(call => call[1] === 'send_message')).toHaveLength(1)
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_BODY|PRIVATE_BACKEND_ERROR/)
  })

  it('returns separate bounded capability sources and never merges schedule write with friend Shell', async () => {
    group.resolved.cli_access.schedule = 'write'; friend.resolved.cli_access.schedule = 'read'; friend.resolved.tool_access.shell = true
    let turn = 0
    inspect = async params => {
      if (turn++ === 0) {
        results.caps = await tool(params, 'get_execution_capabilities').call({}, context)
        planned = { name: 'load_tool_family', input: { family: 'schedule' } }; return
      }
      if (turn === 2) results.schedule = await tool(params, 'trigger_schedule').call({ schedule_id: 'script' }, context)
    }
    await execute('origin')
    const caps = JSON.parse(results.caps.output)
    expect(caps.request_sources.map((entry: any) => entry.kind)).toEqual(['group', 'friend'])
    expect(caps.request_sources[0].capabilities.authorization.tool_access.shell).toBe(false)
    expect(caps.request_sources[1].capabilities.authorization.cli_access.schedule).toBe('read')
    expect(results.schedule.isError).toBe(true)
    expect(admin.mock.calls.some(call => call[0] === 'trigger_now')).toBe(false)
  })

  it('injects a genuine group master_request Memory actor and fixes private writes to private visibility', async () => {
    let turn = 0
    inspect = async params => {
      if (turn++ === 0) { planned = { name: 'load_tool_family', input: { family: 'memory' } }; return }
      if (turn === 2) results.memory = await tool(params, 'mcp__crab-memory__store_memory').call({ content: 'PRIVATE_MEMORY' }, context)
    }
    await execute()
    expect(results.memory.isError).toBe(false)
    const write = rpc.mock.calls.find(call => call[1] === 'quick_capture')
    expect(write?.[2]).toMatchObject({ visibility: 'private', scopes: ['personal'], access_context: { actor_kind: 'master_request', scene: { type: 'group_session', channel_id: 'voice', session_id: 'group' }, request: { source: { sender_friend_id: 'f-owner', session_type: 'group' } } } })
    expect(contexts.some(ctx => ctx.isMasterPrivate)).toBe(false)
  })
  it('enforces explicit private send_message targets and preserves origin cross-channel business sends', async () => {
    let turn = 0
    inspect = async params => {
      if (turn++ > 0) return
      results.other = await tool(params, 'send_message').call({ channel_id: 'chat', session_id: 'other-private', content: 'PRIVATE_BODY', post_send_action: 'none' }, context)
      results.sent = await tool(params, 'send_message').call({ channel_id: 'chat', session_id: 'owner-private', content: 'PRIVATE_BODY', post_send_action: 'none' }, context)
    }
    await execute()
    expect(results.other.isError).toBe(true); expect(results.sent.isError).toBe(false)
    expect(rpc.mock.calls.filter(call => call[1] === 'send_message')).toHaveLength(1)
    const inputs = await stack.trustedHumanInputs.capture(key, [{ ...message(), platform_message_id: 'origin-second' }])
    turn = 0
    await stack.requestRunner.execute(key, inputs, { source_id: inputs[0].source_id, delivery: 'origin' })
    expect(results.other.isError).toBe(false)
    expect(rpc.mock.calls.filter(call => call[1] === 'send_message')).toHaveLength(3)
  })

  it('runs execute_request through the real shared Manager and keeps private tool history and board outside it', async () => {
    const original = message(), inputs = await stack.trustedHumanInputs.capture(key, [original])
    let sharedTurn = 0, childTurn = 0
    inspect = async params => {
      if (params.systemPrompt.includes('已经由系统固定来源的请求')) {
        expect(params.systemPrompt).toContain(original.content.text)
        expect(params.tools.some(item => item.name === 'execute_request')).toBe(false)
        if (childTurn++ === 0) { planned = { name: 'load_tool_family', input: { family: 'messaging' } }; return }
        if (childTurn === 2) { planned = { name: 'change_workboard', input: { action: 'create_objective', objective: { title: 'PRIVATE_BOARD_OBJECTIVE', completion_criteria: ['done'] } } }; return }
        if (childTurn === 3) { planned = { name: 'send_private_message', input: { friend_id: 'f-owner', content: 'PRIVATE_ENGINE_BODY', post_send_action: 'none' } }; return }
      } else {
        expect(params.systemPrompt).toContain('你的基础工具只有群公共授权')
        expect(JSON.stringify(params.messages)).not.toContain('PRIVATE_ENGINE_BODY')
        if (sharedTurn++ === 0) { planned = { name: 'load_tool_family', input: { family: 'crabot' } }; return }
        if (sharedTurn === 2) { planned = { name: 'execute_request', input: { source_id: inputs[0].source_id, delivery: 'requester_private' } }; return }
      }
    }
    await stack.registry.routeHumanMessages('voice', 'group', [original])
    expect(childTurn).toBeGreaterThanOrEqual(4)
    expect(JSON.stringify(await stack.store.load(key))).not.toMatch(/PRIVATE_ENGINE_BODY|PRIVATE_BOARD_OBJECTIVE/)
    const record = await stack.conversationRequests.forInputs(key, inputs).create({ source_id: inputs[0].source_id, delivery: 'requester_private' })
    const privateRoot = path.join(root, 'agent', 'conversation-requests', record.request_id)
    expect(JSON.parse(await fs.readFile(path.join(privateRoot, 'execution-observation.json'), 'utf8'))).toMatchObject({ role: 'manager', state: 'assembled' })
    const sessionFiles = await fs.readdir(path.join(privateRoot, 'session', encodeURIComponent(key)))
    expect((await stack.workboard.load(key)).objectives).toEqual([])
    expect(await fs.readFile(path.join(privateRoot, 'workboard', encodeURIComponent(key), 'workboard.json'), 'utf8')).toContain('PRIVATE_BOARD_OBJECTIVE')
    expect(sessionFiles).toContain('state.json')
    expect(await fs.readFile(path.join(privateRoot, 'session', encodeURIComponent(key), 'state.json'), 'utf8')).toContain('PRIVATE_ENGINE_BODY')
    expect(rpc.mock.calls.filter(call => call[1] === 'send_message').map(call => call[2].session_id)).toEqual(['owner-private'])
  })

  it('routes a genuinely double-bound personal Worker callback to the original request, and refuses it after identity revocation', async () => {
    const inputs = await stack.trustedHumanInputs.capture(key, [message()])
    const result = await stack.requestRunner.execute(key, inputs, { source_id: inputs[0].source_id, delivery: 'requester_private' })
    const record = (await stack.conversationRequests.get(key, result.request_id))!.record
    await bindPersonalWorker(record)
    const shared = vi.spyOn(stack.registry, 'routeOperationNotification')
    let turn = 0
    inspect = async params => {
      expect(params.systemPrompt).toContain('已经由系统固定来源的请求')
      expect(params.systemPrompt).toContain('f-owner')
      expect(JSON.stringify(params.messages)).toContain('PRIVATE_WORKER_RESULT')
      if (turn++ === 0) planned = { name: 'load_tool_family', input: { family: 'messaging' } }
      else if (turn === 2) planned = { name: 'send_private_message', input: { friend_id: 'f-owner', content: 'PRIVATE_EVENT_REPLY', post_send_action: 'none' } }
    }
    const event = { kind: 'turn_completed' as const, ts: new Date().toISOString(), worker_id: 'w-personal', seq: 1, detail: { summary: 'PRIVATE_WORKER_RESULT' } }
    expect(await (stack.harness as any).deps.onOperationNotification(key, event)).toEqual({ consumed: true })
    expect(turn).toBeGreaterThanOrEqual(3)
    expect(shared).not.toHaveBeenCalled()
    expect(JSON.stringify(await stack.store.load(key))).not.toMatch(/PRIVATE_WORKER_RESULT|PRIVATE_EVENT_REPLY/)
    const count = calls.length; current = { group, friend: null }
    expect(await (stack.harness as any).deps.onOperationNotification(key, { ...event, ts: new Date(Date.now() + 1).toISOString() })).toEqual({ consumed: false })
    expect(calls).toHaveLength(count)
    const publicFacts = await stack.harness.readManagerReviewFacts(key)
    expect(JSON.stringify(publicFacts)).not.toMatch(/PRIVATE_WORKER_RESULT|w-personal/)
  })

  it.each(['confirmed', 'unconfirmed', 'different_request'] as const)('settles a Worker only with confirmed delivery for its own request: %s', async mode => {
    const first = await execute(), record = (await stack.conversationRequests.get(key, first.request_id))!.record
    const { turns, turn } = await bindPersonalWorker(record)
    const originalRpc = rpc.getMockImplementation()!
    if (mode === 'unconfirmed') rpc.mockImplementation(async (...args) => args[1] === 'send_message' ? { buffered: true } : originalRpc(...args))
    let step = 0
    inspect = async params => {
      expect(tool(params, 'resolve_worker_turn').description).not.toContain('report_to')
      const args = { worker_id: 'w-personal', turn_id: turn.turn_id, resolution: 'reported' }
      if (step++ === 0) {
        results.before = await tool(params, 'resolve_worker_turn').call(args, context)
        planned = { name: 'load_tool_family', input: { family: 'messaging' } }; return
      }
      if (step === 2) {
        results.sent = await tool(params, 'send_private_message').call({ friend_id: 'f-owner', content: 'PRIVATE_BODY', post_send_action: 'none' }, context)
        results.after = await tool(params, 'resolve_worker_turn').call(args, context)
      }
    }
    if (mode === 'different_request') {
      const inputs = await stack.trustedHumanInputs.capture(key, [{ ...message(), platform_message_id: 'independent-request' }])
      await stack.requestRunner.execute(key, inputs, { source_id: inputs[0].source_id, delivery: 'requester_private' })
    } else await (stack.harness as any).deps.onOperationNotification(key, { kind: 'turn_completed', ts: new Date().toISOString(), worker_id: 'w-personal', seq: 1 })
    expect(results.before.isError).toBe(true)
    expect(results.sent.isError).toBe(mode === 'unconfirmed')
    expect(results.after.isError).toBe(mode !== 'confirmed')
    expect((await turns.get('w-personal', turn.turn_id))!.disposition.status).toBe(mode === 'confirmed' ? 'resolved' : 'pending')
  })

  it('restores a known private delivery receipt on event checkpoint recovery without resending the body', async () => {
    const initial = await execute(), record = (await stack.conversationRequests.get(key, initial.request_id))!.record
    const { turns, turn } = await bindPersonalWorker(record)
    const eventRoot = path.join(root, 'agent', 'conversation-requests', record.request_id, 'events')
    let step = 0, checkpoint = '', checkpointFile = ''
    inspect = async params => {
      if (step++ === 0) { planned = { name: 'load_tool_family', input: { family: 'messaging' } }; return }
      if (step === 2) { planned = { name: 'send_private_message', input: { friend_id: 'f-owner', content: 'PRIVATE_ONCE', post_send_action: 'none' } }; return }
      const [eventId] = await fs.readdir(eventRoot)
      checkpointFile = path.join(eventRoot, eventId, 'session', encodeURIComponent(key), 'running.json')
      checkpoint = await fs.readFile(checkpointFile, 'utf8')
    }
    await (stack.harness as any).deps.onOperationNotification(key, { kind: 'turn_completed', ts: new Date().toISOString(), worker_id: 'w-personal', seq: 1 })
    expect(checkpoint).toContain('owner-private')
    const [eventId] = await fs.readdir(eventRoot), file = path.join(eventRoot, eventId, 'event.json'), state = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, JSON.stringify({ ...state, phase: 'admitted', consumed: false }))
    await fs.writeFile(checkpointFile, checkpoint)
    inspect = async params => { results.restored = await tool(params, 'resolve_worker_turn').call({ worker_id: 'w-personal', turn_id: turn.turn_id, resolution: 'reported' }, context) }
    await stack.requestRunner.recoverPending()
    expect(results.restored.isError).toBe(false)
    expect((await turns.get('w-personal', turn.turn_id))!.disposition.status).toBe('resolved')
    expect(rpc.mock.calls.filter(call => call[1] === 'send_message')).toHaveLength(1)
  })

  it('selects a whole source for real project reads and refuses Messaging from group plus file scope from friend', async () => {
    const a = path.join(root, 'a'), b = path.join(root, 'b')
    await fs.mkdir(a); await fs.mkdir(b); await fs.writeFile(path.join(a, 'facts.md'), 'FRIEND_PROJECT_CONTENT')
    group.resolved.tool_access.file_io = true; group.resolved.tool_access.messaging = true
    group.resolved.storage = { workspace_path: b, access: 'readwrite' }
    friend.resolved.tool_access.file_io = true; friend.resolved.tool_access.messaging = false
    friend.resolved.storage = { workspace_path: a, access: 'read' }
    inspect = async params => {
      results.read = await tool(params, 'inspect_project_docs').call({ project_root: a, operation: 'read', path: 'facts.md' }, context)
      results.send = await tool(params, 'send_message').call({ channel_id: 'chat', session_id: 'other-private', content: 'file', file_path: path.join(a, 'facts.md'), post_send_action: 'none' }, context)
    }
    await execute('origin')
    expect(results.read.isError).toBe(false); expect(results.read.output).toContain('FRIEND_PROJECT_CONTENT')
    expect(results.send.isError).toBe(true)
    expect(rpc.mock.calls.some(call => call[1] === 'send_message' || call[1] === 'upload_media')).toBe(false)
  })

  it('keeps loaded families isolated even across requests from the same friend', async () => {
    inspect = async params => { planned = calls.length === 1 ? { name: 'load_tool_family', input: { family: 'memory' } } : undefined }
    await execute()
    const before = calls.length
    inspect = async params => { expect(params.tools.some(tool => tool.name === 'mcp__crab-memory__store_memory')).toBe(false) }
    const inputs = await stack.trustedHumanInputs.capture(key, [{ ...message(), platform_message_id: 'second-request' }])
    await stack.requestRunner.execute(key, inputs, { source_id: inputs[0].source_id, delivery: 'requester_private' })
    expect(calls.length).toBeGreaterThan(before)
  })

  it('reports the authorized Worker fixed request separately from its actual execution observation', async () => {
    const initial = await execute(), record = (await stack.conversationRequests.get(key, initial.request_id))!.record
    await bindPersonalWorker(record)
    await stack.ledger.upsertWorker(key, 'w-personal', worker => ({ ...worker!, incarnations: [{ incarnation_id: 'fixture-incarnation', impl: 'builtin', seq: 1, state: 'idle', workspace: root, session_ref: 'fixture', started_at: new Date().toISOString() }] }))
    inspect = async params => { results.workerCaps = await tool(params, 'get_execution_capabilities').call({ worker_id: 'w-personal' }, context) }
    await (stack.harness as any).deps.onOperationNotification(key, { kind: 'turn_completed', worker_id: 'w-personal', seq: 1, ts: new Date().toISOString() })
    expect(results.workerCaps.isError).toBe(false)
    const caps = JSON.parse(results.workerCaps.output)
    expect(caps.request).toMatchObject({ binding: { request_id: record.request_id, execution_scope: 'request' }, source: { sender_friend_id: 'f-owner', session_type: 'group' } })
    expect(caps.request.permission_sources.friend.subject_id).toBe('f-owner')
    expect(caps.execution.implementations[0].observation.state).toBe('legacy_unknown')
  })

  it('rejects a retained request tool after the host begins shutdown', async () => {
    let retained: LLMStreamParams['tools'][number] | undefined
    inspect = async params => { retained = tool(params, 'send_message') }
    await execute('origin')
    await stack.dispose()
    const result = await retained!.call({ channel_id: 'chat', session_id: 'owner-private', content: 'after shutdown', post_send_action: 'none' }, context)
    expect(result.isError).toBe(true)
    expect(rpc.mock.calls.some(call => call[1] === 'send_message')).toBe(false)
  })

  it('preserves the existing group Memory query fallback instead of treating empty scopes as an unfiltered search', async () => {
    group.resolved.tool_access.memory = true
    friend.resolved.tool_access.memory = false
    let step = 0
    inspect = async params => {
      if (step++ === 0) { planned = { name: 'load_tool_family', input: { family: 'memory' } }; return }
      if (step === 2) results.search = await tool(params, 'mcp__crab-memory__search_memory').call({ query: 'group facts', level: 'long_term', limit: 5 }, context)
    }
    await execute('origin')
    expect(results.search.isError).toBe(false)
    const search = rpc.mock.calls.find(call => call[1] === 'search_long_term')
    expect(search?.[2]).toMatchObject({ accessible_scopes: ['group'], access_context: { actor_kind: 'conversation', scene: { type: 'group_session' } } })
  })

})
