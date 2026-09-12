/**
 * Manager 能力目录与 episode 工具投影 —— protocol-agent-v3.md §4.3。
 * 内置 messaging、memory、Worker、自省、任务板和项目文档仍按白名单构造；
 * 外部 MCP 另经授权和兼容过滤。profile 固定核心之后只追加当前 episode 搜索出的定义。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §4.3
 */

import { z } from 'zod/v4'
import { defineTool } from '../../engine/index.js'
import type { ToolDefinition, ToolCallResult } from '../../engine/index.js'
import type { McpServer } from '../../mcp/mcp-helpers.js'
import { mcpServerToToolDefinitions } from '../../agent/mcp-tool-bridge.js'
import { CRAB_MEMORY_MANAGER_TOOL_NAMES } from '../../mcp/crab-memory.js'
import { buildMessagingTools, createSendMessageChannelRepair } from '../../mcp/crab-messaging.js'
import type {
  CrabMessagingDeps,
  MessagingTool,
  MessagingToolSet,
  SessionChannelLookup,
  SessionTarget,
} from '../../mcp/crab-messaging.js'
import { buildWorkerTools } from './worker-tools.js'
import type { WorkerHarness } from '../../workers/harness/harness'
import { buildCrabotInfoTools, type ManagerScheduleToolsContext } from './crabot-info.js'
import type { MasterAuthorization } from '../principal.js'
import { buildWorkboardTools } from './workboard-tools.js'
import type { ManagerWorkboardStore } from '../workboard-store.js'
import { buildProjectDocTools, authorizeProjectRoot, type ProjectDocToolDeps } from './project-doc-tools.js'
import {
  ManagerToolCatalog,
  ToolSearchInputError,
  toolSearchQueryStats,
  serializedToolBytes,
  type ManagerToolFaceState,
  type ManagerToolProfile,
} from './tool-catalog.js'

export interface ToolFaceDeps {
  readonly harness: WorkerHarness
  /** P6-C §7：list_worker_implementations 的 registry snapshot getter。 */
  readonly workerImplSnapshot?: import('./worker-tools.js').WorkerToolsDeps['workerImplSnapshot']
  /** Agent-owned structured session projection for manager worker activity reads. */
  readonly readWorkerActivity?: import('./worker-tools.js').WorkerToolsDeps['readWorkerActivity']
  readonly workerContext: Parameters<typeof buildWorkerTools>[0]['context']
  /** 复用现有类型 —— crab-messaging 的依赖注入接口。 */
  readonly messagingDeps: CrabMessagingDeps
  /** 本 manager 的归属目标（来自 managerKey `channel::session`）。用于确定性补全 send_message.channel_id。 */
  readonly managerTarget?: SessionTarget
  /** 当前 Manager 已从可信结构化结果观察到的 Session 归属。 */
  readonly sessionChannelsFor?: SessionChannelLookup
  /** 将成功 messaging 调用产生的可信结构化 Session 归属登记到当前 Manager。 */
  readonly onObservedSessionTargets?: (targets: ReadonlyArray<SessionTarget>) => void
  /** crab-memory，现有 createCrabMemoryServer 产物。 */
  readonly memoryServer: McpServer
  readonly callAdmin: <P, R>(m: string, p: P) => Promise<R>
  readonly getRuntimeConfigSummary?: () => unknown
  readonly schedule?: ManagerScheduleToolsContext
  /** 该 manager 是否为保留的"系统任务"线程（决定 send_master_private / send_private_message 可见性）。 */
  readonly isSystemThread: boolean
  /** Daily reflection keeps send_message plus its fixed-target final summary action. */
  readonly isBuiltinDailyReflection?: boolean
  /** 成功投递且声明随后派发时，标记当前 Manager episode 做一次终止复核。 */
  readonly onPostSendAction?: (action: 'spawn_worker') => void
  /** Opaque control-plane authorization, never represented in any tool schema. */
  readonly authorization?: () => MasterAuthorization | undefined
  readonly validateMasterAuthorization?: (auth: MasterAuthorization) => Promise<boolean>
  /** Episode-local delivery/control evidence used to close a Worker turn. */
  readonly hasSuccessfulSendMessageTo?: (target: { channel_id: string; session_id: string }) => boolean
  readonly onSuccessfulSendMessage?: (target: { channel_id: string; session_id: string }) => void
  readonly hasContinuedWorker?: (workerId: string) => boolean
  readonly onWorkerContinuation?: (workerId: string) => void
  /** 当前 ManagerKey 的独立任务板；不进入 ManagerSessionState 或自动上下文。 */
  readonly workboard: {
    readonly store: ManagerWorkboardStore
    readonly managerKey: import('../types.js').ManagerKey
  }
  /** 当前 episode 的项目文档授权上下文；原始 WakeEvent 仅作控制面输入。 */
  readonly projectDocs: ProjectDocToolDeps
  /** 当前 Manager profile；未提供时按普通 Manager 处理。 */
  readonly profile?: ManagerToolProfile
  /** 当前 episode 的渐进加载状态；缺省表示返回兼容的完整内置工具面。 */
  readonly faceState?: ManagerToolFaceState
  readonly candidatePermissions?: import('../../types.js').ResolvedPermissions
  /** 当前 episode 已通过权限过滤的外部 MCP 工具目录。 */
  readonly externalMcpTools?: ReadonlyArray<ToolDefinition>
  /** 外部 MCP 每次实际调用前的当前主体/目标权限复核。 */
  readonly authorizeExternalMcpTool?: (tool: Pick<ToolDefinition, 'name' | 'category'>) => Promise<boolean>
}

// ============================================================================
// crab-messaging：白名单 + intent 去除
// ============================================================================

/**
 * 普通 manager 的 messaging 白名单（完整通讯能力含跨 session 投递，
 * protocol-agent-v3.md §4.3 明确不裁）。逐行对齐 protocol-crab-messaging.md §1 的两张可见性表。
 *
 * 末尾三个 channel 透传只读工具（§2.10.1–§2.10.3）**仅当存在飞书 channel 实例时才真的出现**：
 * `deps.messagingDeps.enableFeishuDocTool` 为 falsy 时 crab-messaging 压根不构造它们，
 * 而 `MessagingToolSet.tools` 是交集语义（声明 ≠ 存在）。**`feishu_write`（§2.10.4）不在此列**
 * ——任意写 API 透传、无逐操作确认、无 undo，而 manager 是人类原文的唯一入口，
 * 是最容易被 prompt 注入的一环（protocol-crab-messaging.md §1 的 note）。
 */
const MESSAGING_BASE_WHITELIST: readonly string[] = [
  'send_message',
  'send_private_message',
  'get_history',
  'get_message',
  'lookup_friend',
  'list_sessions',
  'list_contacts',
  'list_groups',
  'list_group_members',
  'fetch_media',
  'read_feishu_document',
  'feishu_raw_get',
  'feishu_download_file',
]

/**
 * 仅 isSystemThread===true 时额外暴露：`send_master_private` 的 reach_master 语义只属于
 * 系统线程（protocol-crab-messaging.md §1 投递类可见性表）。
 */
const MESSAGING_SYSTEM_EXTRA: readonly string[] = ['send_master_private']

/**
 * manager 交给 `buildMessagingTools` 的显式工具集声明。
 *
 * manager 不是任务执行者——它没有 TaskContext，也不该有；这里直接声明要哪些工具，
 * 由 crab-messaging 照单构造。`allowAskHuman:false`：ask_human 是 worker 侧概念，
 * manager 的 `send_message` 连 `intent` 参数都被去掉了（见 `messagingToolToDefinition`）。
 */
function managerMessagingToolSet(isSystemThread: boolean): MessagingToolSet {
  return {
    tools: new Set<string>([
      ...MESSAGING_BASE_WHITELIST,
      ...(isSystemThread ? MESSAGING_SYSTEM_EXTRA : []),
    ]),
    allowAskHuman: false,
  }
}

const DAILY_REFLECTION_MESSAGING_TOOL_SET: MessagingToolSet = {
  tools: new Set(['send_message']),
  allowAskHuman: false,
}

const DAILY_REFLECTION_SUMMARY_TARGET = {
  channel_id: 'admin-web',
  session_id: 'system-tasks',
} as const

/** 白名单内只读的子集（其余——发送类——一律 isReadOnly:false）。 */
const MESSAGING_READ_ONLY = new Set([
  'get_history',
  'get_message',
  'lookup_friend',
  'list_sessions',
  'list_contacts',
  'list_groups',
  'list_group_members',
  'fetch_media',
  // channel 透传只读三件套：都不改飞书数据（`feishu_download_file` 只把 token 登记成
  // media handle，落盘要再走 fetch_media），可与其它读工具并行成批。
  'read_feishu_document',
  'feishu_raw_get',
  'feishu_download_file',
])

/**
 * 把裸 `MessagingTool`（crab-messaging 的内部工具形状：`schema` 是 zod 原始 shape，
 * `handler` 返回 MCP content 数组）转成 engine `ToolDefinition`。**不走**
 * `mcpServerToToolDefinitions`——那个转换硬编码 `isReadOnly:false`，会抹掉
 * get_history/lookup_friend 等只读工具的正确标记。
 *
 * `send_message` 额外做"去 intent"包装：v3 下 `intent` 参数（info/ask_human）对 manager
 * 无意义——ask_human 是 worker 侧概念。不修改 crab-messaging 的 schema 常量（模块级共享，
 * P7 才做彻底清理），而是在这一层用去掉 `intent` 键的 shape 重新生成 JSON Schema 暴露给
 * LLM，并且调用底层 handler 时把 `intent` 从入参里丢弃——省略即走 handler 内
 * `intent ?? 'info'` 的默认分支，等价于显式传 'info'，比伪造一个固定值更贴近"没有这个
 * 参数"的语义。
 */
const HUMAN_DELIVERY_TOOL_NAMES = new Set([
  'send_message',
  'send_private_message',
  'send_master_private',
])

const MANAGER_SEND_MESSAGE_CHANNEL_SCHEMA = z.string().optional().describe(
  'Channel 模块实例 ID；可省略，省略时系统按当前 Manager 已登记的结构化 Session 归属补全（多渠道命中时仅取当前 Manager 归属渠道）',
)

const POST_SEND_ACTION_SCHEMA = z.enum(['none', 'spawn_worker']).describe(
  '本条消息发出后是否预计新建 Worker；仅供系统在本轮结束时做一次内部复核，不会自动派发或重复发送消息',
)

const DAILY_REFLECTION_SUMMARY_SCHEMA = z.object({
  content: z.string().describe('给人类看的自然语言摘要'),
})

function messagingToolToDefinition(tool: MessagingTool, deps: ToolFaceDeps): ToolDefinition {
  const isSendMessage = tool.name === 'send_message'
  const isHumanDelivery = HUMAN_DELIVERY_TOOL_NAMES.has(tool.name)

  const baseShape = isSendMessage
    ? {
        ...Object.fromEntries(
          Object.entries(tool.schema).filter(([key]) => key !== 'intent' && key !== 'channel_id'),
        ),
        channel_id: MANAGER_SEND_MESSAGE_CHANNEL_SCHEMA,
      }
    : tool.schema
  const shape = isHumanDelivery
    ? { ...baseShape, post_send_action: POST_SEND_ACTION_SCHEMA }
    : baseShape

  let inputSchema: Record<string, unknown> = { type: 'object', properties: {} }
  try {
    inputSchema = z.toJSONSchema(z.object(shape)) as Record<string, unknown>
  } catch {
    // 保底：极端情况下退化成空 schema，不阻断装配（与 mcp-tool-bridge 同策略）
  }

  return defineTool({
    name: tool.name,
    description: tool.description,
    inputSchema,
    isReadOnly: MESSAGING_READ_ONLY.has(tool.name),
    ...(isSendMessage
      ? {
          // 确定性参数修复（spec 2026-09-03-tool-input-repair）：channel_id 省略时按
          // 当前 Manager 已登记的 Session 归属补全。未知/歧义时原样透传，无额外输出。
          repairInput: createSendMessageChannelRepair(deps.sessionChannelsFor, deps.managerTarget),
        }
      : {}),
    call: async (input): Promise<ToolCallResult> => {
      const postSendAction = input.post_send_action
      if (isHumanDelivery && postSendAction !== 'none' && postSendAction !== 'spawn_worker') {
        return { output: 'post_send_action 必须是 none 或 spawn_worker', isError: true }
      }
      const args = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'intent' && key !== 'post_send_action'))
      try {
        const result = await tool.handler(args)
        if (result.observedSessionTargets?.length) {
          try {
            deps.onObservedSessionTargets?.(result.observedSessionTargets)
          } catch {
            // 派生观察登记失败不得改变原工具结果。
          }
        }
        if (!result.isError && postSendAction === 'spawn_worker') deps.onPostSendAction?.('spawn_worker')
        const text = result.content.map((block) => block.text).join('\n')
        if (isSendMessage && !result.isError) {
          const channelId = args.channel_id
          const sessionId = args.session_id
          if (typeof channelId === 'string' && typeof sessionId === 'string') {
            deps.onSuccessfulSendMessage?.({ channel_id: channelId, session_id: sessionId })
          }
        }
        return { output: text, isError: !!result.isError }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { output: message, isError: true }
      }
    },
  })
}

function buildMessagingFace(deps: ToolFaceDeps): ToolDefinition[] {
  if (deps.isBuiltinDailyReflection) return buildDailyReflectionMessagingFace(deps)
  const toolSet = managerMessagingToolSet(deps.isSystemThread)
  return buildMessagingTools(deps.messagingDeps, () => toolSet).map((tool) => messagingToolToDefinition(tool, deps))
}

function buildDailyReflectionMessagingFace(deps: ToolFaceDeps): ToolDefinition[] {
  const sendMessage = buildMessagingTools(
    deps.messagingDeps,
    () => DAILY_REFLECTION_MESSAGING_TOOL_SET,
  ).find((tool) => tool.name === 'send_message')
  if (!sendMessage) throw new Error('daily reflection summary requires send_message')

  return [messagingToolToDefinition(sendMessage, deps), defineTool({
    name: 'send_daily_reflection_summary',
    description: '将每日反思的必要摘要发送到 Admin Web 系统任务线程。仅接收人类可读文本，投递目标固定且不可修改。',
    inputSchema: z.toJSONSchema(DAILY_REFLECTION_SUMMARY_SCHEMA) as Record<string, unknown>,
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      try {
        const result = await sendMessage.handler({
          ...DAILY_REFLECTION_SUMMARY_TARGET,
          content: input.content as string,
        })
        if (result.observedSessionTargets?.length) {
          try {
            deps.onObservedSessionTargets?.(result.observedSessionTargets)
          } catch {
            // 派生观察登记失败不得改变原工具结果。
          }
        }
        return {
          output: result.content.map((block) => block.text).join('\n'),
          isError: !!result.isError,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { output: message, isError: true }
      }
    },
  })]
}

// ============================================================================
// 运行时护栏：把"封闭"变成不变量，而非只靠 review
// ============================================================================

/** worker 通用文件系统/编排类工具，manager 绝不应可见（一律派 worker 执行）。 */
const BANNED_TOOL_NAMES = new Set(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'delegate_task'])

/** 内置 memory 的保留前缀；外部 MCP 不得复用该名称空间。 */
const ALLOWED_MCP_PREFIX = 'mcp__crab-memory__'
const MANAGER_MEMORY_TOOL_NAMES = CRAB_MEMORY_MANAGER_TOOL_NAMES.map(
  (name) => `${ALLOWED_MCP_PREFIX}${name}`,
)

function buildManagerMemoryFace(memoryServer: McpServer): ToolDefinition[] {
  const tools = mcpServerToToolDefinitions(memoryServer, 'crab-memory')
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const expected = new Set(MANAGER_MEMORY_TOOL_NAMES)
  const missing = MANAGER_MEMORY_TOOL_NAMES.filter((name) => !byName.has(name))
  const unexpected = tools.map((tool) => tool.name).filter((name) => !expected.has(name))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `buildManagerToolFace: crab-memory 工具面与协议不一致 (missing=${missing.join(',') || 'none'}; unexpected=${unexpected.join(',') || 'none'})`,
    )
  }
  return MANAGER_MEMORY_TOOL_NAMES.map((name) => byName.get(name)!)
}

/**
 * 对装配结果做自检：不得包含通用文件系统/编排工具，也不得包含任何外装 MCP 工具
 * （即 `mcp__` 前缀里非 crab-memory 的）。命中即抛错——本函数独立导出，供测试直接
 * 注入违规工具验证（`buildManagerToolFace` 内部也会在返回前调用它）。
 */
export function assertClosedToolFace(tools: readonly ToolDefinition[], allowExternalMcp = false): void {
  for (const tool of tools) {
    if (BANNED_TOOL_NAMES.has(tool.name.toLowerCase())) {
      throw new Error(`buildManagerToolFace: 检测到不应出现在 manager 工具面的通用工具 '${tool.name}'`)
    }
    if (!allowExternalMcp && tool.name.startsWith('mcp__') && !tool.name.startsWith(ALLOWED_MCP_PREFIX)) {
      throw new Error(`buildManagerToolFace: 检测到不应出现在 manager 工具面的外装 MCP 工具 '${tool.name}'`)
    }
  }
}

// ============================================================================
// 装配入口
// ============================================================================

function buildSearchToolsTool(catalog: ManagerToolCatalog, state: ManagerToolFaceState): ToolDefinition {
  return defineTool({
    name: 'search_tools',
    description: '按动作和对象搜索当前 episode 可用的 Manager 工具。命中的具体工具从下一轮开始可见并可直接调用。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500, description: '简短的动作 + 对象，不要复制完整消息或秘密' },
        limit: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
      },
      required: ['query'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      state.searches = (state.searches ?? 0) + 1
      try {
        const result = catalog.search(state, input.query, input.limit)
        return {
          output: JSON.stringify({
            status: result.status,
            scope: 'current_episode',
            catalog_revision: result.catalogRevision,
            loaded: result.loaded,
            already_visible: result.alreadyVisible,
            omitted_due_to_budget: result.omittedDueToBudget,
          }),
          isError: false,
          traceMetadata: {
            ...toolSearchQueryStats(input.query),
            tool_search_status: result.status,
            loaded_names: result.loaded.join(','),
            already_visible: result.alreadyVisible.join(','),
            omitted_due_to_budget: result.omittedDueToBudget,
            loaded_schema_bytes: result.loaded.reduce((bytes, name) => bytes + serializedToolBytes(catalog.get(name)!), 0),
          },
        }
      } catch (error) {
        if (!(error instanceof ToolSearchInputError)) {
          catalog.loadBuiltinFallback(state)
          return {
            output: JSON.stringify({ status: 'degraded', scope: 'current_episode', catalog_revision: catalog.catalogRevision,
              loaded: [], already_visible: [], omitted_due_to_budget: 0 }),
            isError: false,
            traceMetadata: { tool_search_status: 'degraded' },
          }
        }
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
        }
      }
    },
  })
}

function wrapExternalMcpTool(
  tool: ToolDefinition,
  authorize: ToolFaceDeps['authorizeExternalMcpTool'],
): ToolDefinition | undefined {
  // External MCP is a discoverable-and-executable capability. If the caller
  // cannot provide the runtime authorization hook, fail closed at admission.
  if (!authorize || !/^mcp__[a-zA-Z0-9_-]+$/.test(tool.name) || tool.name.length > 64
    || tool.name.startsWith('mcp__crab-memory__')
    || (tool.category !== 'desktop' && tool.category !== 'mcp_skill')
    || hasUnsafeMetadata(tool.description) || hasUnsafeMetadata(tool.inputSchema)
    || serializedToolBytes(tool) > 64 * 1024) return undefined
  return {
    ...tool,
    isReadOnly: false,
    call: async (input, context) => {
      let allowed = false
      try {
        allowed = await authorize(tool)
      } catch {
        allowed = false
      }
      if (!allowed) return {
        output: 'TOOL_CATALOG_CHANGED', isError: true,
        traceMetadata: { mcp_status: 'permission_changed', tool_error_code: 'TOOL_CATALOG_CHANGED' },
      }
      return tool.call(input, context)
    },
  }
}

function hasUnsafeMetadata(value: unknown): boolean {
  if (typeof value === 'string') return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  if (Array.isArray(value)) return value.some(hasUnsafeMetadata)
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => hasUnsafeMetadata(key) || hasUnsafeMetadata(item))
  }
  return false
}

/** 返回完整内置工具面；有 episode 状态时投影为稳定核心 + 已加载尾部。 */
export function buildManagerToolFace(deps: ToolFaceDeps): ToolDefinition[] {
  if (deps.faceState?.catalog) return deps.faceState.catalog.project(deps.faceState, deps.faceState.searchTool)
  const messagingTools = buildMessagingFace(deps)
  const memoryTools = buildManagerMemoryFace(deps.memoryServer)
  const workerTools = buildWorkerTools({
    authorizeProjectRead: (workspaceRoot) => authorizeProjectRoot(deps.projectDocs, workspaceRoot, false),
    harness: deps.harness,
    context: deps.workerContext,
    authorization: deps.authorization,
    validateMasterAuthorization: deps.validateMasterAuthorization,
    ...(deps.workerImplSnapshot ? { workerImplSnapshot: deps.workerImplSnapshot } : {}),
    ...(deps.readWorkerActivity ? { readWorkerActivity: deps.readWorkerActivity } : {}),
    ...(deps.hasSuccessfulSendMessageTo ? { hasSuccessfulSendMessageTo: deps.hasSuccessfulSendMessageTo } : {}),
    ...(deps.hasContinuedWorker ? { hasContinuedWorker: deps.hasContinuedWorker } : {}),
    ...(deps.onWorkerContinuation ? { onWorkerContinuation: deps.onWorkerContinuation } : {}),
  })
  const infoTools = buildCrabotInfoTools({
    callAdmin: deps.callAdmin,
    getRuntimeConfigSummary: deps.getRuntimeConfigSummary,
    ...(deps.workerImplSnapshot ? { workerImplSnapshot: deps.workerImplSnapshot } : {}),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
  })
  const workboardTools = buildWorkboardTools(deps.workboard)
  const projectDocTools = buildProjectDocTools(deps.projectDocs)

  const builtinTools = [
    ...messagingTools,
    ...memoryTools,
    ...workerTools,
    ...workboardTools,
    ...projectDocTools,
    ...infoTools,
  ]
  assertClosedToolFace(builtinTools)
  if (!deps.faceState) return builtinTools

  const profile = deps.profile ?? (deps.isBuiltinDailyReflection ? 'daily_reflection' : 'normal')
  const mode = deps.faceState.mode ?? 'progressive'
  let externalMcpTools: ReadonlyArray<ToolDefinition> = []
  if (mode === 'progressive' && profile === 'normal') {
    if (!deps.faceState.externalMcpToolsCaptured) {
      deps.faceState.externalMcpTools = (deps.externalMcpTools ?? [])
        .map((tool) => wrapExternalMcpTool(tool, deps.authorizeExternalMcpTool))
        .filter((tool): tool is ToolDefinition => tool !== undefined)
      deps.faceState.externalMcpToolsCaptured = true
    }
    externalMcpTools = deps.faceState.externalMcpTools ?? []
  }
  const catalog = new ManagerToolCatalog(
    [...builtinTools.sort((a, b) => Number(CONDITIONAL_TOOLS.has(a.name)) - Number(CONDITIONAL_TOOLS.has(b.name)) || a.name.localeCompare(b.name)), ...externalMcpTools],
    profile,
    undefined,
    undefined,
    (tool) => {
      if (profile !== 'normal') return true
      const permissions = deps.candidatePermissions
      if (tool.name.startsWith('mcp__') && !tool.name.startsWith('mcp__crab-memory__')) {
        return (tool.category === 'mcp_skill' || tool.category === 'desktop') && permissions?.tool_access[tool.category] === true
      }
      if (tool.name.startsWith('mcp__crab-memory__')) return permissions?.tool_access.memory === true
      if (messagingTools.some((item) => item.name === tool.name)) return permissions?.tool_access.messaging === true
      if (tool.name === 'inspect_workspace_git') return permissions?.tool_access.file_io === true
      if (workerTools.some((item) => item.name === tool.name)) return permissions?.tool_access.task === true
      if (tool.name.endsWith('_schedule') || tool.name === 'list_schedules') {
        const access = permissions?.cli_access.schedule
        return access === 'write' || (access === 'read' && (tool.name === 'get_schedule' || tool.name === 'list_schedules'))
      }
      if (tool.name === 'get_friend_permissions') return permissions?.cli_access.permission === 'read' || permissions?.cli_access.permission === 'write'
      return true
    },
  )
  deps.faceState.catalog = catalog
  if (profile === 'memory_graph_rebuild') {
    const projected = catalog.project(deps.faceState)
    assertClosedToolFace(projected, true)
    return projected
  }
  const searchTool = buildSearchToolsTool(catalog, deps.faceState)
  deps.faceState.searchTool = searchTool
  const projected = catalog.project(deps.faceState, searchTool)
  assertClosedToolFace(projected, true)
  return projected
}

const CONDITIONAL_TOOLS = new Set(['read_feishu_document', 'feishu_raw_get', 'feishu_download_file', 'send_master_private', 'list_all_workers'])
