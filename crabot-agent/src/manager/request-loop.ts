import path from 'node:path'
import type { BootstrapDeps } from './bootstrap.js'
import type { RequestRunContext } from './conversation-request-runner.js'
import type { RequestPermissionSource } from './request-permission-sources.js'
import type { WorkerHarness } from '../workers/harness/harness.js'
import type { LedgerStore } from '../workers/harness/ledger-store.js'
import type { WorkerContextStore } from '../workers/harness/context-store.js'
import type { WorkerRequestGuard } from '../workers/harness/request-guard.js'
import type { VoiceOutputPort } from './voice-output.js'
import type { CompactionPolicy } from './compaction.js'
import type { MemoryTaskContext } from '../mcp/crab-memory.js'
import { RequestDeliveryStore } from './request-delivery-store.js'
import { ManagerLoop } from './loop.js'
import { ManagerWorkboardStore } from './workboard-store.js'
import { requestSourceFor } from './conversation-request-store.js'
import { RequestManagerToolScope, requestMemoryScopes } from './tools/request-tool-scope.js'
import { buildManagerToolFace, type ToolFaceDeps } from './tools/tool-face.js'
import { readObservation, observationFile, executionObservation, persistObservation, requestObservation } from '../permissions/execution-observation.js'
import { checkProjectFileAccess } from './tools/project-doc-tools.js'
import { allowed, denied } from '../permissions/tool-authorization.js'

interface Dependencies {
  canRun?(): boolean
  bootstrap: BootstrapDeps
  harness: WorkerHarness
  ledger: LedgerStore
  contexts: WorkerContextStore
  guard: WorkerRequestGuard
  policy: CompactionPolicy
  root: string
  voiceOutput?: VoiceOutputPort
}

/** Same Manager role and real group identity; no Registry mailbox, shared trace or private-session disguise. */
export function createConversationRequestLoop(context: RequestRunContext, deps: Dependencies): ManagerLoop {
  const host = deps.bootstrap, request = context.request, source = context.source
  const target = source.message.session, key = request.manager_key
  const voiceOutput = request.delivery.kind === 'origin' ? deps.voiceOutput : undefined
  const board = new ManagerWorkboardStore(path.join(deps.root, request.request_id, 'workboard'))
  const deliveries = new RequestDeliveryStore(path.join(deps.root, request.request_id), request)
  let loop: ManagerLoop, pending = false
  const visibleLedger: ToolFaceDeps['projectDocs']['ledger'] = {
    findWorker: async id => {
      const found = await deps.ledger.findWorker(id)
      if (!found || found.managerKey !== key) return undefined
      await deps.guard.authorizeControl(id, context.authority, async () => allowed)
      return found
    },
    listWorkers: async managerKey => {
      if (managerKey !== key) return []
      const result = []
      for (const worker of await deps.ledger.listWorkers(key)) {
        try { await deps.guard.authorizeControl(worker.worker_id, context.authority, async () => allowed); result.push(worker) } catch { /* No cross-owner metadata. */ }
      }
      return result
    },
  }
  const verifyPrivateTarget = async (channelId: string, sessionId: string): Promise<boolean> => {
    const friend = await host.callAdmin<{ friend_id: string }, { friend: { channel_identities: Array<{ channel_id: string; platform_user_id: string }> } }>('get_friend', { friend_id: request.delivery.requester_friend_id! })
    const session = await host.messagingDeps.rpcClient.call<{ session_id: string }, { session: { type: string; platform_session_id: string } }>(
      await host.messagingDeps.resolveChannelPort(channelId), 'get_session', { session_id: sessionId }, host.messagingDeps.moduleId)
    return session.session.type === 'private' && friend.friend.channel_identities.some(identity => identity.channel_id === channelId && identity.platform_user_id === session.session.platform_session_id)
  }
  const makeMemory = (actor: RequestPermissionSource): MemoryTaskContext => ({
    channelId: target.channel_id, sessionId: target.session_id, sessionType: 'group',
    senderFriendId: source.sender_friend_id ?? undefined, isMasterPrivate: false,
    sourceType: 'conversation', visibility: request.delivery.kind === 'requester_private' ? 'private' : 'internal',
    scopes: requestMemoryScopes(actor, target.session_id),
    accessContext: { actor_kind: actor.is_master ? 'master_request' : 'conversation', memory_enabled: actor.resolved.tool_access.memory,
      ...(actor.is_master ? { request: { request_id: request.request_id, source: requestSourceFor(source) } } : {}),
      scene: { type: 'group_session', channel_id: target.channel_id, session_id: target.session_id } },
  })
  const raw = (actor: RequestPermissionSource, recheck?: () => Promise<RequestPermissionSource>, operation?: { name: string; input: Record<string, unknown> }): ToolFaceDeps => {
    const permissions = actor.resolved
    const mcpContext = { managerKey: key, targetSession: target, profile: 'normal' as const, requestId: request.request_id,
      requestPermissions: async () => (recheck ? await recheck() : actor).resolved,
      ...(source.sender_friend_id ? { creatorFriendId: source.sender_friend_id } : {}), permissions }
    const memory = makeMemory(actor)
    if (recheck) memory.resolveContext = async () => makeMemory(await recheck())
    const channelPorts = new Map<number, string>()
    const rpc = new Proxy(host.messagingDeps.rpcClient, { get(client, property) {
      const value = Reflect.get(client, property, client)
      if (typeof value !== 'function') return value
      if (property !== 'call' && property !== 'callSensitive') return value.bind(client)
      return async (...args: unknown[]) => {
        await recheck?.()
        if (recheck && request.delivery.kind === 'requester_private' && args[1] === 'send_message') {
          const channelId = channelPorts.get(args[0] as number), params = args[2] as { session_id?: string }
          if (!channelId || typeof params?.session_id !== 'string' || !await verifyPrivateTarget(channelId, params.session_id)) throw new Error('PERMISSION_DENIED: 私发目标绑定已改变')
        }
        if (args[1] === 'send_message') {
          const channelId = channelPorts.get(args[0] as number), params = args[2] as { session_id?: string }
          if (!operation || !channelId || typeof params?.session_id !== 'string') throw new Error('DELIVERY_OUTCOME_UNKNOWN: Missing host send context')
          return deliveries.send({ channel_id: channelId, session_id: params.session_id }, operation, async () => recheck?.(), () => value.apply(client, args))
        }
        return value.apply(client, args)
      }
    } })
    return {
      harness: deps.harness, requestGuard: deps.guard, requestAuthorization: 'request',
      workerRequestControl: { scope: 'request', authority: async () => context.authority },
      readExecutionObservation: (workerId, incarnationId, impl) => readObservation(observationFile(path.join(host.dataRoot, 'agent', 'workers'), workerId, incarnationId),
        executionObservation({ role: 'worker', impl, source: 'legacy', state: 'legacy_unknown', worker_id: workerId, incarnation_id: incarnationId, constraints: ['无该化身记录，历史工具未知。'] })),
      workerImplSnapshot: host.workerImplSnapshot, describeExecutionTools: host.describeExecutionTools,
      readWorkerActivity: host.readWorkerActivity, readWorkerSubagents: host.readWorkerSubagents,
      readWorkerSubagentDetail: host.readWorkerSubagentDetail, readWorkerSubagentTrace: host.readWorkerSubagentTrace,
      workerContext: () => ({ managerKey: key, episodeId: loop?.currentEpisodeTraceId, creatorFriendId: source.sender_friend_id ?? undefined,
        principalPermissions: permissions, reportTo: { channel_id: target.channel_id, session_id: target.session_id },
        targetSession: target, triggerType: 'message', onWorkerSpawned: id => loop?.recordSpawnedWorker(id) }),
      messagingDeps: { ...host.messagingDeps, rpcClient: rpc, voiceReplyContext: () => context.voiceReplyContext,
        resolveChannelPort: async channelId => { const port = await host.messagingDeps.resolveChannelPort(channelId); channelPorts.set(port, channelId); return port } },
      managerTarget: target, voice: voiceOutput?.isVoice() === true,
      sessionChannelsFor: id => loop?.sessionChannelsFor(id),
      onObservedSessionTargets: targets => loop?.recordObservedSessionTargets(targets),
      onPostSendAction: () => loop?.recordPostSendAction(),
      hasSuccessfulSendMessageTo: value => loop?.hasSuccessfulSendMessageTo(value) ?? false,
      hasSuccessfulWorkerDelivery: async worker => {
        const bound = await deps.guard.load(worker.worker_id)
        if (bound?.request.delivery.kind === 'requester_private') return bound.request.request_id === request.request_id && loop.hasSuccessfulHumanDelivery
        return loop?.hasSuccessfulSendMessageTo(worker.report_to) ?? false
      },
      onSuccessfulSendMessage: value => {
        loop.recordSuccessfulSendMessage(value)
        if (request.delivery.kind === 'requester_private') { pending = false }
        else if (value.channel_id === target.channel_id && value.session_id === target.session_id) { pending = false; context.onSuccessfulOriginDelivery?.(value) }
      },
      hasContinuedWorker: id => loop?.hasContinuedWorker(id) ?? false,
      onWorkerContinuation: id => loop?.recordWorkerContinuation(id),
      memoryServer: host.memoryServerFor(memory),
      callAdmin: async (method, params) => { await recheck?.(); return host.callAdmin(method, params) },
      getRuntimeConfigSummary: host.getRuntimeConfigSummary,
      externalMcpTools: host.managerMcpToolsFor?.(mcpContext),
      authorizeExternalMcpTool: async tool => {
        const current = recheck ? await recheck() : actor
        return host.managerMcpToolAuthorization?.({ ...mcpContext, permissions: current.resolved, toolName: tool.name, category: tool.category }) ?? false
      },
      schedule: { targetSession: target, ...(source.sender_friend_id ? { creatorFriendId: source.sender_friend_id } : {}),
        canCreate: !!source.sender_friend_id, resolvePermissions: async () => (recheck ? await recheck() : actor).resolved },
      isSystemThread: false, workboard: { store: board, managerKey: key },
      projectDocs: { ledger: visibleLedger, managedWorkspace: (id, workspace) => deps.harness.managedWorkspaceScope(id, workspace), readWorkerContext: id => deps.contexts.read(id), managerKey: key, managerPrincipalPermissions: permissions },
    }
  }
  const scope = new RequestManagerToolScope({ context, raw, checkOperation: async (name, input, actor) => {
    if (deps.canRun?.() === false || host.isClosing?.()) return denied('CAPABILITY_UNKNOWN', '运行时正在关闭')
    if (name === 'send_message' && request.delivery.kind === 'requester_private') {
      if (typeof input.channel_id !== 'string' || typeof input.session_id !== 'string') return denied('PERMISSION_DENIED', '私发目标未核实')
      if (!await verifyPrivateTarget(input.channel_id, input.session_id)) return denied('PERMISSION_DENIED', '私发目标不是原发起人')
    }
    if (name === 'inspect_workspace_git' && typeof input.worker_id === 'string') {
      const found = await visibleLedger.findWorker(input.worker_id)
      const workspace = found?.worker.incarnations.filter(item => item.forked_from === undefined).at(-1)?.workspace
      if (!workspace) return denied('PERMISSION_DENIED', '执行器目录不可核实')
      return checkProjectFileAccess(raw(actor).projectDocs, workspace)
    }
    if (name.endsWith('_schedule') || name === 'list_schedules') {
      const read = name === 'get_schedule' || name === 'list_schedules', access = actor.resolved.cli_access.schedule
      if (access !== 'write' && (!read || access !== 'read')) return denied('PERMISSION_DENIED', 'Schedule未获完整授权')
      let shell = input.script !== undefined || input.include_script_source === true
      if ((name === 'update_schedule' || name === 'trigger_schedule') && typeof input.schedule_id === 'string') {
        const result = await host.callAdmin<{ schedule_id: string }, { schedule: { script?: unknown } }>('get_schedule', { schedule_id: input.schedule_id })
        const disable = name === 'update_schedule' && input.enabled === false && Object.keys(input).length === 2
        shell ||= !!result.schedule.script && !disable
      }
      if (shell && !actor.resolved.tool_access.shell) return denied('PERMISSION_DENIED', '同一Schedule来源需要Shell授权')
    }
    // Preserve configured query/label scopes without changing Memory's coarse visibility policy.
    if (name.startsWith('mcp__crab-memory__')) {
      const memoryTarget = request.permission_sources.friend?.resolved.tool_access.memory
        ? request.permission_sources.friend : request.permission_sources.group
      if (memoryTarget.is_master && !actor.is_master) return denied('PERMISSION_DENIED', 'Master记忆来源未获授权')
      const ceiling = request.permission_sources[actor.kind]!
      const before = requestMemoryScopes(ceiling, target.session_id), now = requestMemoryScopes(actor, target.session_id)
      if (before.length > 0 && now.length > 0 && !before.some(scope => now.includes(scope))) return denied('PERMISSION_DENIED', 'Memory配置范围已变化，原请求没有可沿用的查询范围')
      if (request.delivery.kind === 'requester_private' && !PRIVATE_MEMORY_READS.has(name.replace('mcp__crab-memory__', ''))
        && !(actor.is_master && ['mcp__crab-memory__store_memory', 'mcp__crab-memory__quick_capture'].includes(name))) return denied('PERMISSION_DENIED', '私发上下文只允许新建私人记忆')
    }
    return allowed
  } })
  // The union below is used ONLY by catalog visibility; every actual tool is decorated.
  const candidate = structuredClone(request.permission_sources.group.resolved)
  for (const actor of [request.permission_sources.group, request.permission_sources.friend]) if (actor) {
    for (const entry of Object.keys(candidate.tool_access) as Array<keyof typeof candidate.tool_access>) candidate.tool_access[entry] ||= actor.resolved.tool_access[entry]
    for (const domain of Object.keys(candidate.cli_access) as Array<keyof typeof candidate.cli_access>) {
      if (actor.resolved.cli_access[domain] === 'write' || candidate.cli_access[domain] === 'none') candidate.cli_access[domain] = actor.resolved.cli_access[domain]
    }
  }
  loop = new ManagerLoop({ key, managerKey: () => key, isSystemThread: false, store: context.store,
    policy: deps.policy, adapter: host.managerAdapter, model: host.managerModel,
    observeTools: async (_key, episodeId, tools) => persistObservation(path.join(deps.root, request.request_id, 'execution-observation.json'),
      requestObservation(tools, { role: 'manager', impl: 'manager', source: 'manager_request', constraints: [`episode=${episodeId}`] })),
    onRuntimeConfigApplied: host.onRuntimeConfigApplied, runtimeConfigAppliedGeneration: host.runtimeConfigAppliedGeneration,
    thinking: host.managerThinking, contextWindowTokens: host.managerContextWindowTokens,
    // No automatic quoted-message/history prefetch across the request boundary.
    toolFace: (_wake, faceState) => {
      const base = raw(request.permission_sources.group)
      const candidates = new Map<string, NonNullable<ToolFaceDeps['externalMcpTools']>[number]>()
      for (const actor of [request.permission_sources.group, request.permission_sources.friend]) if (actor) for (const tool of raw(actor).externalMcpTools ?? []) candidates.set(tool.name, tool)
      return buildManagerToolFace({ ...base, faceState, candidatePermissions: candidate, externalMcpTools: [...candidates.values()], decorateTool: scope.decorate })
    },
    promptInputs: () => ({ isGroup: true, requestAuthorization: 'request',
      dialogProfile: JSON.stringify({ request_id: request.request_id, source: requestSourceFor(source), original_message: source.message, selection: request.selection, delivery: request.delivery }),
      ...(host.managerPersonality?.() ? { adminPersonality: host.managerPersonality() } : {}) }),
    voiceOutput, voiceResponseEndOwner: context.voiceReplyContext ? 'parent' : undefined,
    onSuccessfulVoiceReply: value => { pending = false; context.onSuccessfulOriginDelivery?.(value) },
    harness: deps.harness, now: () => new Date(host.now()), timezone: host.timezone,
    markPendingReply: () => { pending = true }, hasPendingReply: () => pending,
  })
  return loop
}

const PRIVATE_MEMORY_READS = new Set(['search_memory', 'get_memory_detail', 'get_scene_profile', 'search_long_term', 'list_recent', 'list_entries', 'get_stats', 'get_evolution_mode'])
