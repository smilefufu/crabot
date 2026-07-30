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
import type { CrabMessagingDeps, MessagingTool, TaskContext } from '../../mcp/crab-messaging.js'
import { HumanMessageQueue } from '../../engine/human-message-queue.js'
import { buildWorkerTools } from './worker-tools.js'
import type { WorkerHarness } from '../../workers/harness/harness'
import { buildCrabotInfoTools } from './crabot-info.js'

export interface ToolFaceDeps {
  readonly harness: WorkerHarness
  readonly workerContext: Parameters<typeof buildWorkerTools>[0]['context']
  /** 复用现有类型 —— crab-messaging 的依赖注入接口。 */
  readonly messagingDeps: CrabMessagingDeps
  /** crab-memory，现有 createCrabMemoryServer 产物。 */
  readonly memoryServer: McpServer
  readonly callAdmin: <P, R>(m: string, p: P) => Promise<R>
  /** 该 manager 是否为保留的"系统任务"线程（决定 send_master_private / send_private_message 可见性）。 */
  readonly isSystemThread: boolean
  /**
   * query_worker 异步失败出口（Task 4 留口、Task 8 接线）：原样透传给 `buildWorkerTools` 的
   * `WorkerToolsDeps.onAsyncError`——真正的绑定逻辑（按 key 决定 enqueueDuringEpisode 还是
   * 重新 wakeUp）在 `ManagerRegistry.handleAsyncToolError`，本层只负责不掉链子地转发。
   * 缺省不传时行为与之前完全一致（query_worker 失败仅 console.error）。
   */
  readonly onAsyncError?: Parameters<typeof buildWorkerTools>[0]['onAsyncError']
}

// ============================================================================
// crab-messaging：白名单 + intent 去除
// ============================================================================

/**
 * 普通 manager 的 messaging 白名单（9 项，完整通讯能力含跨 session 投递，
 * protocol-agent-v3.md §4.3 明确不裁）。
 */
const MESSAGING_BASE_WHITELIST: readonly string[] = [
  'send_message',
  'get_history',
  'get_message',
  'lookup_friend',
  'list_sessions',
  'list_contacts',
  'list_groups',
  'list_group_members',
  'fetch_media',
]

/** 仅 isSystemThread===true 时额外暴露。 */
const MESSAGING_SYSTEM_EXTRA: readonly string[] = ['send_master_private', 'send_private_message']

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
])

/**
 * isSystemThread===true 时，`buildMessagingTools` 内部的 `resolveMessagingToolProfile`
 * 必须判成 'scheduled'（而非缺省的 'human_message'）——send_master_private /
 * send_private_message 的可见性完全由 `taskCtx.triggerType` 决定（crab-messaging.ts），
 * 没有第二条口子。因此这里用一个最小 stub `TaskContext` 覆盖
 * `deps.messagingDeps.getTaskContext`，仅为解锁这两个工具在 `buildMessagingTools` 返回
 * 数组里的可见性、以及它们运行时 `requireScheduledShortcutContext` 检查（读的是同一个
 * `getTaskContext`）的通过。
 *
 * 隐式语义审查（CLAUDE.md「语义边界与复用审查」）：
 * - `hasGoal` 固定 false —— 不会触发 goal-mode 的 outboundBuffer 缓冲分支（该分支要求
 *   `hasGoal()===true` 才生效），manager 的 send_message 因此总是立即发送，语义不受影响；
 * - manager 侧 `send_message` 的 `intent` 参数已被本模块整体去除（见 `messagingToolToDefinition`），
 *   唯一读 `humanQueue`/`taskId` 的 `intent==='ask_human'` 分支因此永远不会被触发，stub 的
 *   `taskId`/`humanQueue` 只用于满足 `TaskContext` 的类型要求，不承载真实语义；
 * - 不影响非系统线程 manager：`isSystemThread===false` 时 `getTaskContext` 原样透传
 *   `deps.messagingDeps`，不做任何覆盖。
 */
function buildSystemThreadTaskContext(): TaskContext {
  return {
    taskId: 'manager-system-thread',
    humanQueue: new HumanMessageQueue(),
    triggerType: 'scheduled',
    hasGoal: () => false,
  }
}

function resolveEffectiveMessagingDeps(deps: ToolFaceDeps): CrabMessagingDeps {
  if (!deps.isSystemThread) return deps.messagingDeps
  const systemThreadContext = buildSystemThreadTaskContext()
  return {
    ...deps.messagingDeps,
    getTaskContext: () => systemThreadContext,
  }
}

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
function messagingToolToDefinition(tool: MessagingTool): ToolDefinition {
  const isSendMessage = tool.name === 'send_message'

  const shape = isSendMessage
    ? Object.fromEntries(Object.entries(tool.schema).filter(([key]) => key !== 'intent'))
    : tool.schema

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
      const args = isSendMessage
        ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'intent'))
        : input
      try {
        const result = await tool.handler(args)
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
  const effectiveMessagingDeps = resolveEffectiveMessagingDeps(deps)
  const rawTools = buildMessagingTools(effectiveMessagingDeps)
  const whitelist = new Set<string>([
    ...MESSAGING_BASE_WHITELIST,
    ...(deps.isSystemThread ? MESSAGING_SYSTEM_EXTRA : []),
  ])
  return rawTools.filter((tool) => whitelist.has(tool.name)).map(messagingToolToDefinition)
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
  const workerTools = buildWorkerTools({ harness: deps.harness, context: deps.workerContext, onAsyncError: deps.onAsyncError })
  const infoTools = buildCrabotInfoTools({ callAdmin: deps.callAdmin })

  const tools = [...messagingTools, ...memoryTools, ...workerTools, ...infoTools]
  assertClosedToolFace(tools)
  return tools
}
