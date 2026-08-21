/**
 * manager 封闭工具面装配 —— protocol-agent-v3.md §4.3。
 *
 * manager 的工具面是**写死的白名单**，不接受外部扩展：四个来源原样/裁剪拼接后，末尾还有一道
 * 运行时护栏兜底（见 `assertClosedToolFace`），把"封闭"变成不变量而非只靠 review。
 *
 * 四个来源：
 * 1. crab-messaging（`buildMessagingTools`）—— 按白名单裁剪，`send_message` 额外做"去 intent"包装；
 * 2. crab-memory（`deps.memoryServer`，经 `mcpServerToToolDefinitions` 转换）—— 原样全给，不裁；
 * 3. worker 六件套（Task 4 `buildWorkerTools`）—— 原样加入；
 * 4. crabot-info 六件套（Task 3 `buildCrabotInfoTools`）—— 原样加入。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §4.3
 */

import { z } from 'zod/v4'
import { defineTool } from '../../engine/index.js'
import type { ToolDefinition, ToolCallResult } from '../../engine/index.js'
import type { McpServer } from '../../mcp/mcp-helpers.js'
import { mcpServerToToolDefinitions } from '../../agent/mcp-tool-bridge.js'
import { buildMessagingTools } from '../../mcp/crab-messaging.js'
import type { CrabMessagingDeps, MessagingTool, MessagingToolSet } from '../../mcp/crab-messaging.js'
import { buildWorkerTools } from './worker-tools.js'
import type { WorkerHarness } from '../../workers/harness/harness'
import { buildCrabotInfoTools } from './crabot-info.js'
import type { MasterAuthorization } from '../principal.js'

export interface ToolFaceDeps {
  readonly harness: WorkerHarness
  /** P6-C §7：list_worker_implementations 的 registry snapshot getter。 */
  readonly workerImplSnapshot?: import('./worker-tools.js').WorkerToolsDeps['workerImplSnapshot']
  readonly workerContext: Parameters<typeof buildWorkerTools>[0]['context']
  /** 复用现有类型 —— crab-messaging 的依赖注入接口。 */
  readonly messagingDeps: CrabMessagingDeps
  /** crab-memory，现有 createCrabMemoryServer 产物。 */
  readonly memoryServer: McpServer
  readonly callAdmin: <P, R>(m: string, p: P) => Promise<R>
  readonly getRuntimeConfigSummary?: () => unknown
  /** 该 manager 是否为保留的"系统任务"线程（决定 send_master_private / send_private_message 可见性）。 */
  readonly isSystemThread: boolean
  /** 成功投递且声明随后派发时，标记当前 Manager episode 做一次终止复核。 */
  readonly onPostSendAction?: (action: 'spawn_worker') => void
  /** Opaque control-plane authorization, never represented in any tool schema. */
  readonly authorization?: () => MasterAuthorization | undefined
  readonly validateMasterAuthorization?: (auth: MasterAuthorization) => Promise<boolean>
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

function messagingToolToDefinition(tool: MessagingTool, deps: ToolFaceDeps): ToolDefinition {
  const isSendMessage = tool.name === 'send_message'
  const isHumanDelivery = HUMAN_DELIVERY_TOOL_NAMES.has(tool.name)

  const baseShape = isSendMessage
    ? Object.fromEntries(Object.entries(tool.schema).filter(([key]) => key !== 'intent'))
    : tool.schema
  const shape = isHumanDelivery
    ? { ...baseShape, post_send_action: z.enum(['none', 'spawn_worker']).describe('本条消息发出后是否预计新建 Worker；仅供系统在本轮结束时做一次内部复核，不会自动派发或重复发送消息') }
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
    call: async (input): Promise<ToolCallResult> => {
      const postSendAction = input.post_send_action
      if (isHumanDelivery && postSendAction !== 'none' && postSendAction !== 'spawn_worker') {
        return { output: 'post_send_action 必须是 none 或 spawn_worker', isError: true }
      }
      const args = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'intent' && key !== 'post_send_action'))
      try {
        const result = await tool.handler(args)
        if (!result.isError && postSendAction === 'spawn_worker') deps.onPostSendAction?.('spawn_worker')
        const text = result.content.map((block) => block.text).join('\n')
        return { output: text, isError: !!result.isError }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { output: message, isError: true }
      }
    },
  })
}

function buildMessagingFace(deps: ToolFaceDeps): ToolDefinition[] {
  const toolSet = managerMessagingToolSet(deps.isSystemThread)
  return buildMessagingTools(deps.messagingDeps, () => toolSet).map((tool) => messagingToolToDefinition(tool, deps))
}

// ============================================================================
// 运行时护栏：把"封闭"变成不变量，而非只靠 review
// ============================================================================

/** worker 通用文件系统/编排类工具，manager 绝不应可见（一律派 worker 执行）。 */
const BANNED_TOOL_NAMES = new Set(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'delegate_task'])

/** crab-memory 走 `mcp__crab-memory__*` 前缀，是唯一允许出现在工具面里的 `mcp__` 前缀。 */
const ALLOWED_MCP_PREFIX = 'mcp__crab-memory__'

/**
 * 对装配结果做自检：不得包含通用文件系统/编排工具，也不得包含任何外装 MCP 工具
 * （即 `mcp__` 前缀里非 crab-memory 的）。命中即抛错——本函数独立导出，供测试直接
 * 注入违规工具验证（`buildManagerToolFace` 内部也会在返回前调用它）。
 */
export function assertClosedToolFace(tools: readonly ToolDefinition[]): void {
  for (const tool of tools) {
    if (BANNED_TOOL_NAMES.has(tool.name.toLowerCase())) {
      throw new Error(`buildManagerToolFace: 检测到不应出现在 manager 工具面的通用工具 '${tool.name}'`)
    }
    if (tool.name.startsWith('mcp__') && !tool.name.startsWith(ALLOWED_MCP_PREFIX)) {
      throw new Error(`buildManagerToolFace: 检测到不应出现在 manager 工具面的外装 MCP 工具 '${tool.name}'`)
    }
  }
}

// ============================================================================
// 装配入口
// ============================================================================

/** 返回该 manager 的完整工具面；白名单写死在本函数，不接受外部扩展。 */
export function buildManagerToolFace(deps: ToolFaceDeps): ToolDefinition[] {
  const messagingTools = buildMessagingFace(deps)
  const memoryTools = mcpServerToToolDefinitions(deps.memoryServer, 'crab-memory')
  const workerTools = buildWorkerTools({
    harness: deps.harness,
    context: deps.workerContext,
    authorization: deps.authorization,
    validateMasterAuthorization: deps.validateMasterAuthorization,
    ...(deps.workerImplSnapshot ? { workerImplSnapshot: deps.workerImplSnapshot } : {}),
  })
  const infoTools = buildCrabotInfoTools({
    callAdmin: deps.callAdmin,
    getRuntimeConfigSummary: deps.getRuntimeConfigSummary,
    ...(deps.workerImplSnapshot ? { workerImplSnapshot: deps.workerImplSnapshot } : {}),
  })

  const tools = [...messagingTools, ...memoryTools, ...workerTools, ...infoTools]
  assertClosedToolFace(tools)
  return tools
}
