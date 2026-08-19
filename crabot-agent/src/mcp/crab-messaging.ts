/**
 * Crab-Messaging MCP Server — Agent 统一通讯能力
 *
 * 提供 9 个工具：lookup_friend, list_contacts, list_groups, list_sessions, list_group_members, send_private_message, send_message, get_history, get_message
 * 对齐 protocol-crab-messaging.md
 *
 * @see crabot-docs/protocols/protocol-crab-messaging.md
 */

import { resolvePath } from '../engine/tools/utils.js'
import { createMcpServer, type McpServer } from './mcp-helpers.js'
import { z } from 'zod/v4'
import { SYSTEM_CHANNEL_ID, SYSTEM_SESSION_ID, type RpcClient } from 'crabot-shared'
import type { Friend } from '../types.js'
import { annotatePagination } from './pagination-annotator.js'
import { translateChannelError } from './error-translator.js'
import {
  dispatchOutboundMessage,
  type OutboundBufferEntry,
  type OutboundDispatchDeps,
  type PathMapping,
} from '../agent/outbound-flush.js'

// 历史兼容重导出：外部仍按 './mcp/crab-messaging' 导入 PathMapping / OutboundBufferEntry
export type { OutboundBufferEntry, PathMapping }
// ============================================================================
// 依赖注入接口
// ============================================================================

export interface CrabMessagingDeps {
  rpcClient: RpcClient
  moduleId: string
  getAdminPort: () => Promise<number>
  resolveChannelPort: (channelId: string) => Promise<number>
  /**
   * P6-A §11.5-9：Admin Chat 出站 delivery 事务钩子（仅 exact admin-web::admin-chat
   * 目标生效；其它目标的调用不携带 delivery metadata——不注入即剥离）。
   */
  readonly adminChatDelivery?: import('../agent/outbound-flush.js').AdminChatDeliveryHooks
  /**
   * 可选：返回当前调用 mcp 工具的 task 上下文。
   * Worker 调用路径返回非空（含 taskId + humanQueue 引用），用于 send_message(intent='ask_human')。
   * Front 调用路径返回 null（front 不能调 ask_human，工具内会拒绝）。
   */
  getTaskContext?: () => TaskContext | null
  /** 是否启用飞书文档读取工具（有飞书 channel 时才注入） */
  enableFeishuDocTool?: boolean
}

export interface TaskContext {
  taskId: string
  humanQueue: import('../engine/human-message-queue.js').HumanMessageQueue
  /** 任务来源类型——schedule 触发的任务禁止调用 send_message(intent='ask_human')。
   *  与 Task.source.trigger_type 同名同枚举。 */
  triggerType: 'message' | 'scheduled'
  /** 任务子分类（来自 Schedule.task_template.type 或人类指派）。
   *  现仅 scheduled + 'daily_reflection' 用于 messaging 工具白名单过滤——反思任务工具
   *  集合卡死到 send_master_private + 只读工具，避免反思内容被发到任意群/私聊。
   *  其他 scheduled 任务（用户自建的推送 / 巡检 / 数据采集）不受白名单影响。 */
  taskType?: string
  /** 当前 task 是否挂了 goal；agent-handler 在装 deps 时由 admin task 查询结果维护 cache，
   *  此处用 getter 形式以便 worker 中途 set_task_goal 后下一次工具调用立即生效。
   *  spec: 2026-05-23-goal-mode-design.md §4.2 */
  hasGoal: () => boolean
  /** Audit 等待态下被截留的 send_message intent='info' 缓冲区（同 WorkerTaskState.outboundBuffer 引用）。
   *  goal mode + 工作态时 handler 把 info 消息推入此处不真发；engine 在 audit pass / tool_use 等时机 flush。
   *  shape 与 WorkerTaskState.outboundBuffer 完全对齐（同一 OutboundBufferEntry 类型）。
   *
   *  **语义（spec §4.1 Revision 2026-06-09 第 1 段）**：永远 ≤ 1 条。
   *  push 新条前若已有旧条 → 先 sync flush 旧条（"新顶旧"），再 push 新条。
   *
   *  spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.1 + Revision 第 1 段 */
  outboundBuffer?: Array<OutboundBufferEntry>
  /** ask_human barrier 超时自醒时的本地兜底钩子：查一次 task 状态，已终态则 abort worker。
   *  admin 不可达时 fail-open（继续跑）。 */
  abortIfTaskTerminal?: () => Promise<void>
  /** 当前 task 是否处于"等审态"（activeAuditId 非空）。同步 getter，工具内每次调用现读。
   *  工作态（false）= 缓冲；等审态（true）= 立即 flush 给用户（过程响应）。
   *  spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 6 */
  hasActiveAudit?: () => boolean
  /** Dispatch 钩子点 callback（spec §4.13.6 Invariant #1+#2 / §4.13.7）。
   *  dispatchOutboundMessage 真 flush 成功后触发；抛错路径不触发。
   *  worker setup 时由 agent-handler 注入，回调内置 `taskState.everSentMessage = true`（PR-1 effect）。
   *  PR-2 落地时在同 callback 函数体追加 task.messages.push(...)。
   *  Front 调用路径无 task 上下文时不注入。
   *  spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.13.6 / §4.13.7 */
  onDispatched?: import('../agent/outbound-flush.js').OnDispatchedHook
  /** 消息进入 outboundBuffer 时触发（worker 交付了但被缓冲，可能被 audit 拦下丢弃）。
   *  agent-handler 注入回调置 taskState.everBufferedMessage=true——endTurnGate 据此
   *  区分"从未交付"和"交付被拦"两种 NO_DELIVERY 文案。
   *  spec: 2026-06-10-audit-anchor-human-request §3.5 */
  onBuffered?: () => void
  /** 当前真实人类输入轮次；send_message entry 创建时绑定，用于后续送达确认。 */
  getHumanInputEpoch?: () => number
  /** 当前 task 的工作目录（set_cwd 改的 taskState.cwd，缺省落到 workspace）。
   *  send_message 收到相对 file_path 时用它就地解析成绝对路径——相对路径若拖到延迟 flush
   *  阶段才在 dispatch 里抛错，那时已无法把失败回传给 worker（trace a72623ec 成因）。 */
  getCwd?: () => string
}

type MessagingToolProfile =
  | 'human_message'
  | 'scheduled'
  | 'scheduled_daily_reflection'

function resolveMessagingToolProfile(
  taskCtx: Pick<TaskContext, 'triggerType' | 'taskType'> | null,
): MessagingToolProfile {
  if (taskCtx?.triggerType !== 'scheduled') return 'human_message'
  if (taskCtx.taskType === 'daily_reflection') return 'scheduled_daily_reflection'
  return 'scheduled'
}

// ============================================================================
// 工具集声明 —— 由装配层显式给出，buildMessagingTools 不再自己从 TaskContext 推断
// ============================================================================

/**
 * 一次 messaging 装配要暴露的能力声明。装配层给出（worker 侧 = `buildWorkerMessagingTools`，
 * manager 侧 = `manager/tools/tool-face.ts`），`buildMessagingTools` 只照单执行。
 *
 * 它同时是**可见性**与**运行时门**的唯一来源：`tools` 决定构建哪些工具，两处旁路门
 * （scheduled 私聊捷径 / `send_message` 的 ask_human）也读同一份声明——两边共用一个来源，
 * 才不会出现"工具可见但调用被拦"这种极难排查的错位。
 *
 * `tools` 是**交集**语义：声明了但当前 deps 没构造的工具（如 `enableFeishuDocTool=false`
 * 时的飞书工具）自然不出现。新增工具时须同时登记进 `ALL_MESSAGING_TOOL_NAMES`。
 */
export interface MessagingToolSet {
  /** 要暴露的工具名集合。 */
  readonly tools: ReadonlySet<string>
  /** `send_message` 是否允许 `intent='ask_human'`（要求存在一个同步的人类应答方）。 */
  readonly allowAskHuman: boolean
}

/**
 * 声明的读取入口。取 **getter 而非定值**：worker 侧的声明由 `deps.getTaskContext()` 推出，
 * 而 TaskContext 是活的，构建时的快照未必等于调用那一刻的上下文；运行时门要的是**调用那一刻**
 * 的声明（回归用例：`tests/mcp/crab-messaging-send-master-private.test.ts`「构建后切到 message
 * context 时拒绝且零 RPC」）。manager 侧声明是常量，getter 原样返回即可。
 */
export type MessagingToolSetProvider = () => MessagingToolSet

// ============================================================================
// 路径映射类型（实现已抽到 ../agent/outbound-flush.ts 与 flush 路径共享，本文件仅重导出）
// ============================================================================

// ============================================================================
// 重试逻辑
// ============================================================================

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delays = [1000, 2000, 4000],
): Promise<T> {
  let lastError: Error | undefined
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const isRetryable = lastError.message.includes('ECONNREFUSED')
        || lastError.message.includes('ETIMEDOUT')
        || lastError.message.includes('ECONNRESET')
        || lastError.message.includes('socket hang up')
      if (!isRetryable || i === maxRetries - 1) throw lastError
      await new Promise(resolve => setTimeout(resolve, delays[i] ?? 4000))
    }
  }
  throw lastError
}

// ============================================================================
// ask_human 相关常量
// ============================================================================

/**
 * ask_human 的 pending_question 字段截断长度。
 * admin 端 Task.pending_question 没有强制 schema 上限，这里截 2000 保 prompt 注入精简 + 防止过长污染 active_tasks 段。
 */
const ASK_HUMAN_PENDING_QUESTION_MAX_LEN = 2000

/**
 * ask_human 设置 barrier 的超时。
 *
 * 必须 > admin 的 WAITING_HUMAN_TIMEOUT_MS(24h) + WAITING_HUMAN_SCAN_INTERVAL_MS(5min)：
 * admin 判死发生在 [24h, 24h+5min] 区间（超时值 + 一个扫描周期），barrier 早于这个区间醒
 * 就是 worker 假醒空跑。这里取 24h+15min 留足余量。
 * 注：admin 端两个常量都在 crabot-admin/src/index.ts AdminModule 上。
 *
 * barrier 超时后由 setBarrier 的 onTimeout 本地复查 Admin task 状态；确认任务已终态时
 * 才停止旧 worker，Admin 不再通过 task lifecycle RPC 主动控制 Agent worker。
 */
const ASK_HUMAN_BARRIER_TIMEOUT_MS = 24 * 60 * 60 * 1000 + 15 * 60 * 1000

// ============================================================================
// 工具类型定义
// ============================================================================

export interface MessagingTool {
  name: string
  description: string
  schema: Record<string, z.ZodTypeAny>
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
  }>
}

// ============================================================================
// 内部 helper
// ============================================================================

function wrapText(payload: unknown, opts?: { isError?: boolean }) {
  const base = { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
  return opts?.isError ? { ...base, isError: true } : base
}

/**
 * 私聊捷径的运行时门：读装配层声明，未声明即拒绝。
 *
 * 与可见性同源（`buildMessagingTools` 用同一份声明过滤工具数组），因此"能看见的一定能调、
 * 看不见的一定调不动"是构造上的不变量，而非两处规则碰巧一致。
 */
function requireDeclaredShortcut(
  getToolSet: MessagingToolSetProvider,
  toolName: 'send_private_message' | 'send_master_private',
): ReturnType<typeof wrapText> | null {
  if (getToolSet().tools.has(toolName)) return null
  return wrapText({
    error_code: 'SCHEDULED_ONLY_TOOL',
    error: `${toolName} is only available in scheduled tasks`,
  }, { isError: true })
}

function clampPageSize(n: number, max = 100): number {
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(Math.floor(n), max)
}

// ============================================================================
// buildMessagingTools — 可单测的纯函数，按装配层声明返回工具数组
// ============================================================================

/**
 * 本文件构造的全部 messaging 工具名。装配层拿它做基准裁剪，**新增工具时必须同步登记**
 * （漏登记 = worker 侧拿不到新工具；`tests/mcp/crab-messaging-tool-set.test.ts` 有守卫用例）。
 */
export const ALL_MESSAGING_TOOL_NAMES: readonly string[] = [
  'lookup_friend',
  'list_contacts',
  'list_groups',
  'list_sessions',
  'list_group_members',
  'send_private_message',
  'send_master_private',
  'send_message',
  'get_history',
  'get_message',
  'fetch_media',
  'read_feishu_document',
  'feishu_raw_get',
  'feishu_download_file',
  'feishu_write',
]

/**
 * daily-reflection 任务允许的 messaging 工具白名单。
 *
 * 背景：反思任务没有 task_origin（无对话方），prompt 不会给 channel/session 锚点；产出的报告
 * 又是 crabot 内部产物（trace 数据 / Evolution Mode / case→rule 等黑话）。若不限制工具，
 * agent 可能 lookup_friend / list_sessions 自行挑一个 session 把内部产物发出去
 * （已发生：2026-05-30 daily-reflection 把反思报告发到群"全栈工程师哈哈 & Mr.Wu"）。
 *
 * 仅对 triggerType='scheduled' + taskType='daily_reflection' 生效：
 *   - 对外唯一通道：send_master_private（admin 按 permission='master' 定位，封死目标）
 *   - 只读分析工具：get_history / get_message / read_feishu_document（用 trace 里拿到的 channel/session 查历史）
 *   - 其他工具不暴露：lookup_friend、list_contacts、list_groups、list_sessions、send_message、send_private_message
 *
 * 其他 scheduled 任务（如用户自建的 GitHub 新闻推送 / 群通报巡检）**不受此白名单影响**，
 * 走完整 messaging 工具集——它们本来就是要往群里发的合理用途。
 */
const DAILY_REFLECTION_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'send_master_private',
  'get_history',
  'get_message',
  'read_feishu_document',
  'feishu_raw_get',
  'feishu_download_file',
])

/** scheduled 任务（非 daily_reflection）：完整工具集；无同步应答方，禁 ask_human。 */
const SCHEDULED_TOOL_SET: MessagingToolSet = {
  tools: new Set(ALL_MESSAGING_TOOL_NAMES),
  allowAskHuman: false,
}

/** daily_reflection：白名单封死对外通道（见上方注释）。 */
const DAILY_REFLECTION_TOOL_SET: MessagingToolSet = {
  tools: DAILY_REFLECTION_ALLOWED_TOOLS,
  allowAskHuman: false,
}

/** message 触发的任务 / front：不给 scheduled 专属的两个私聊捷径；有人类在对面，可 ask_human。 */
const HUMAN_MESSAGE_TOOL_SET: MessagingToolSet = {
  tools: new Set(ALL_MESSAGING_TOOL_NAMES.filter(
    name => name !== 'send_private_message' && name !== 'send_master_private',
  )),
  allowAskHuman: true,
}

/**
 * worker/front 装配路径：按 TaskContext 算出工具集声明。
 *
 * 这是 `resolveMessagingToolProfile` 唯一的消费点——它的语义不变（仍是"按任务上下文裁剪"），
 * 只是从 `buildMessagingTools` 内部搬到了装配路径上。PR J 摘除 worker 侧 messaging 时，
 * 本函数与 profile 一并删除。
 */
export function workerMessagingToolSet(
  taskCtx: Pick<TaskContext, 'triggerType' | 'taskType'> | null,
): MessagingToolSet {
  switch (resolveMessagingToolProfile(taskCtx)) {
    case 'scheduled_daily_reflection':
      return DAILY_REFLECTION_TOOL_SET
    case 'scheduled':
      return SCHEDULED_TOOL_SET
    case 'human_message':
      return HUMAN_MESSAGE_TOOL_SET
  }
}

// ============================================================================
// 工具 schema（必须是模块级常量，只构建一次）
//
// 为什么不能放进 buildMessagingTools：worker 每轮 LLM turn 都会通过
// buildToolsDynamic 重建本 server；zod v4 的 .describe() 会把 schema clone
// 写入 globalRegistry（强引用 Map，永不清除）。inline 构建 = 每轮净增整棵
// schema 树 → 2026-06-11 OOM 事故根因。回归测试：tests/mcp/zod-registry-leak.test.ts
// ============================================================================

const LOOKUP_FRIEND_SCHEMA = {
  name: z.string().optional().describe('按名称模糊搜索'),
  friend_id: z.string().optional().describe('按 friend_id 精确查找'),
}

const LIST_CONTACTS_SCHEMA = {
  channel_id: z.string().describe('渠道 ID'),
  search: z.string().optional().describe('联系人名称搜索关键词'),
  page: z.number().optional().describe('页码，从 1 开始'),
  page_size: z.number().optional().describe('每页数量，默认 50，最大 100'),
}

const LIST_GROUPS_SCHEMA = {
  channel_id: z.string().describe('渠道 ID'),
  search: z.string().optional().describe('群名搜索关键词'),
  page: z.number().optional().describe('页码，从 1 开始'),
  page_size: z.number().optional().describe('每页数量，默认 50，最大 100'),
}

const LIST_SESSIONS_SCHEMA = {
  channel_id: z.string().describe('Channel 模块实例 ID'),
  type: z.enum(['private', 'group']).optional().describe('按类型过滤'),
  page: z.number().optional().describe('页码，从 1 开始'),
  page_size: z.number().optional().describe('每页数量，默认 20，最大 100'),
}

const LIST_GROUP_MEMBERS_SCHEMA = {
  channel_id: z.string().describe('Channel 模块实例 ID'),
  session_id: z.string().describe('群 Session ID（type=group）'),
  page: z.number().optional().describe('页码，从 1 开始'),
  page_size: z.number().optional().describe('每页数量，默认 50，最大 100'),
}

const SEND_PRIVATE_MESSAGE_SCHEMA = {
  friend_id: z.string().describe('目标熟人 ID'),
  content: z.string().describe('消息内容（文本）'),
}

const SEND_MASTER_PRIVATE_SCHEMA = {
  content: z.string().describe('给 master 看的一句人话（已翻译，无内部黑话）'),
  channel_id: z.string().optional().describe('指定走哪个 channel。不传则按 master.channel_identities 顺序尝试第一个可用的'),
}

const SEND_MESSAGE_SCHEMA = {
  channel_id: z.string().describe('Channel 模块实例 ID'),
  session_id: z.string().describe('目标 Session ID'),
  content: z.string().describe('消息内容（给人类看的自然语言；禁止塞 audit/criterion/`/清除目标` 等内部黑话）'),
  intent: z.enum(['info', 'ask_human']).optional().describe('意图：info=进度告知 / 最终交付（默认，单向，不等回复）；ask_human=阻塞等人类同步回复'),
  content_type: z.enum(['text', 'image', 'file']).optional().describe('消息类型，默认 text'),
  media_url: z.string().optional().describe('媒体 URL（网络地址，与 file_path 二选一）'),
  file_path: z.string().optional().describe('要发送的本地文件路径。可用绝对路径或相对路径/`~`（相对路径按当前工作目录解析）；远程沙盒场景自动转换为主机路径'),
  filename: z.string().optional().describe('文件名（可选）'),
  mentions: z.array(z.object({
    friend_id: z.string().optional().describe('熟人 ID（与 platform_user_id 二选一）'),
    platform_user_id: z.string().optional().describe('平台用户 ID（如飞书 open_id，从 list_contacts 获取）。有此字段时跳过熟人查找，可直接 @ 非熟人群成员'),
    at_name: z.string().optional().describe('你在 content 正文里写的 @标记文本（如 "@徐倩"）。提供后系统在正文里做内联高亮替换；不提供则在消息末尾追加 @ 通知'),
  })).optional().describe('@提及列表。每项提供 friend_id（熟人 ID）或 platform_user_id（平台 ID，从 list_contacts 获取）之一，加可选的 at_name'),
  quote_message_id: z.string().optional().describe('引用回复的平台消息 ID'),
}

const GET_HISTORY_SCHEMA = {
  channel_id: z.string().describe('Channel 模块实例 ID'),
  session_id: z.string().describe('Session ID'),
  keyword: z.string().optional().describe('关键词过滤'),
  limit: z.number().optional().describe('返回条数上限，默认 20'),
  before: z.string().optional().describe('查询此时间之前的消息（ISO 8601）'),
  after: z.string().optional().describe('查询此时间之后的消息（ISO 8601）'),
}

const GET_MESSAGE_SCHEMA = {
  channel_id: z.string().describe('Channel 模块实例 ID'),
  session_id: z.string().describe('Session ID'),
  platform_message_id: z.string().describe('要查询的消息 ID'),
}

const READ_FEISHU_DOCUMENT_SCHEMA = {
  url: z.string().describe('飞书云文档 URL，例如 https://xxx.feishu.cn/docx/TOKEN 或 /wiki/TOKEN 或 /sheets/TOKEN'),
  channel_id: z.string().optional().describe('飞书 channel 实例 ID（有多个飞书 channel 时必须指定）'),
  max_chars: z.number().optional().describe('正文最大字符数（默认 50000）'),
}

const FEISHU_RAW_GET_SCHEMA = {
  path: z.string().describe('飞书只读 API 路径，必须以 /open-apis/ 开头，例如 /open-apis/wiki/v2/spaces/get_node?token=xxx&obj_type=wiki'),
  query: z.record(z.string(), z.string()).optional().describe('可选 query 参数对象'),
  channel_id: z.string().optional().describe('多个飞书 channel 时指定'),
}

const FEISHU_DOWNLOAD_FILE_SCHEMA = {
  file_token: z.string().describe('drive 文件 token（box 开头）'),
  filename: z.string().optional().describe('文件名，决定本地扩展名'),
  channel_id: z.string().optional(),
}

const FEISHU_WRITE_SCHEMA = {
  method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP 写方法'),
  path: z.string().describe('飞书 API 路径，必须以 /open-apis/ 开头'),
  body: z.record(z.string(), z.unknown()).optional().describe('请求体 JSON 对象'),
  query: z.record(z.string(), z.string()).optional().describe('可选 query 参数'),
  channel_id: z.string().optional().describe('多个飞书 channel 时指定'),
}

const FETCH_MEDIA_SCHEMA = {
  channel_id: z.string().describe('Channel 模块实例 ID'),
  handle: z.string().describe('媒体下载句柄（消息标记里的 handle=fm_xxx）'),
}

/**
 * 按装配层给出的**显式声明**构造 messaging 工具数组。
 *
 * 本函数不再自己从 TaskContext 推断该给哪些工具——那是装配层的事（worker 侧
 * `buildWorkerMessagingTools`，manager 侧 `manager/tools/tool-face.ts`）。
 */
export function buildMessagingTools(
  deps: CrabMessagingDeps,
  getToolSet: MessagingToolSetProvider,
  sandboxPathMappingsRef?: { current: PathMapping[] },
): MessagingTool[] {
  const { rpcClient, moduleId, getAdminPort, resolveChannelPort } = deps

  // 解析飞书 channel port 的公共 helper（供 read_feishu_document / feishu_raw_get / feishu_download_file 共用）
  async function resolveFeishuChannelPort(args: Record<string, unknown>): Promise<
    { channelPort: number } | { error_code: string; error: string; available_channels?: string[] }
  > {
    let targetChannelId = args.channel_id as string | undefined
    if (!targetChannelId) {
      const adminPort = await getAdminPort()
      let feishuChannels: Array<{ id: string }> = []
      try {
        const result = await rpcClient.call<
          { pagination: { page: number; page_size: number } },
          { items: Array<{ id: string; implementation_id: string }> }
        >(adminPort, 'list_channel_instances', { pagination: { page: 1, page_size: 50 } }, moduleId)
        feishuChannels = result.items.filter(c => c.implementation_id === 'channel-feishu')
      } catch {
        return { error_code: 'CHANNEL_UNAVAILABLE', error: '无法获取飞书 channel 列表' }
      }
      if (feishuChannels.length === 0) return { error_code: 'CHANNEL_UNAVAILABLE', error: '没有找到飞书 channel，无法读取飞书文档' }
      if (feishuChannels.length > 1) return { error_code: 'AMBIGUOUS', error: '有多个飞书 channel，请通过 channel_id 参数指定', available_channels: feishuChannels.map(c => c.id) }
      targetChannelId = feishuChannels[0].id
    }
    try {
      const channelPort = await resolveChannelPort(targetChannelId)
      return { channelPort }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error_code: 'CHANNEL_UNAVAILABLE', error: `飞书 Channel ${targetChannelId} 不可用: ${msg}` }
    }
  }

  const allTools: MessagingTool[] = [
    // ================================================================
    // 1. lookup_friend — 查找熟人
    // ================================================================
    {
      name: 'lookup_friend',
      description: '搜索熟人信息，包括该熟人在哪些 Channel 上有身份。可按名称模糊搜索或按 friend_id 精确查找。',
      schema: LOOKUP_FRIEND_SCHEMA,
      handler: async (args) => {
        const friendId = args.friend_id as string | undefined
        const searchName = args.name as string | undefined

        if (!searchName && !friendId) {
          return wrapText({ error: '必须提供 name 或 friend_id 至少一个查询条件' })
        }

        const adminPort = await getAdminPort()

        if (friendId) {
          try {
            const result = await rpcClient.call<
              { friend_id: string },
              { friend: Friend }
            >(adminPort, 'get_friend', { friend_id: friendId }, moduleId)

            const friend = result.friend
            return wrapText({
              friends: [{
                friend_id: friend.id,
                display_name: friend.display_name,
                permission: friend.permission,
                channels: friend.channel_identities.map(ci => ({
                  channel_id: ci.channel_id,
                  platform_user_id: ci.platform_user_id,
                  platform_display_name: ci.platform_display_name ?? ci.platform_user_id,
                })),
              }],
            })
          } catch {
            return wrapText({ error: `Friend not found: ${friendId}` })
          }
        }

        // 按名称搜索
        const result = await rpcClient.call<
          { search?: string; pagination?: { page: number; page_size: number } },
          { items: Friend[]; pagination: { total_items: number } }
        >(adminPort, 'list_friends', { search: searchName, pagination: { page: 1, page_size: 20 } }, moduleId)

        const friends = result.items.map(f => ({
          friend_id: f.id,
          display_name: f.display_name,
          permission: f.permission,
          channels: f.channel_identities.map(ci => ({
            channel_id: ci.channel_id,
            platform_user_id: ci.platform_user_id,
            platform_display_name: ci.platform_display_name ?? ci.platform_user_id,
          })),
        }))

        return wrapText({ friends })
      },
    },

    // ================================================================
    // 2. list_contacts — 列出渠道的联系人列表（包含非熟人）
    // ================================================================
    {
      name: 'list_contacts',
      description: '列出渠道平台上的联系人（包括非熟人）。返回是分页结果——pagination.has_more=true 时只是部分；要拿全集请按 next_page 继续调用。不要把单页结果当作全集做断言。',
      schema: LIST_CONTACTS_SCHEMA,
      handler: async (args) => {
        const channel_id = args.channel_id as string
        let channelPort: number
        try {
          channelPort = await resolveChannelPort(channel_id)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用: ${msg}` })
        }
        if (!channelPort) {
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用` })
        }
        const page = (args.page as number | undefined) ?? 1
        const userSpecifiedPageSize = args.page_size != null
        const page_size = clampPageSize((args.page_size as number | undefined) ?? 50)
        try {
          const result = await rpcClient.call<
            { search?: string; pagination: { page: number; page_size: number } },
            { items: unknown[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }
          >(
            channelPort, 'list_contacts',
            { search: args.search as string | undefined, pagination: { page, page_size } },
            moduleId,
          )
          return wrapText(annotatePagination(result, { requestedPage: page, requestedPageSize: page_size, userSpecifiedPageSize }))
        } catch (err) {
          return wrapText(translateChannelError(err))
        }
      },
    },

    // ================================================================
    // 2b. list_groups — 列出渠道的群聊列表
    // ================================================================
    {
      name: 'list_groups',
      description: '列出渠道平台上的群（包括从未交互过的）。返回是分页结果——pagination.has_more=true 时只是部分；要拿全集请按 next_page 继续调用。不要把单页结果当作全集做断言。',
      schema: LIST_GROUPS_SCHEMA,
      handler: async (args) => {
        const channel_id = args.channel_id as string
        let channelPort: number
        try {
          channelPort = await resolveChannelPort(channel_id)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用: ${msg}` })
        }
        if (!channelPort) {
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用` })
        }
        const page = (args.page as number | undefined) ?? 1
        const userSpecifiedPageSize = args.page_size != null
        const page_size = clampPageSize((args.page_size as number | undefined) ?? 50)
        try {
          const result = await rpcClient.call<
            { search?: string; pagination: { page: number; page_size: number } },
            { items: unknown[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }
          >(
            channelPort, 'list_groups',
            { search: args.search as string | undefined, pagination: { page, page_size } },
            moduleId,
          )
          return wrapText(annotatePagination(result, { requestedPage: page, requestedPageSize: page_size, userSpecifiedPageSize }))
        } catch (err) {
          return wrapText(translateChannelError(err))
        }
      },
    },

    // ================================================================
    // 3. list_sessions — 查看会话列表（加分页元信息）
    // ================================================================
    {
      name: 'list_sessions',
      description: '查看指定 Channel 上当前已感知的会话列表。返回是分页结果——pagination.has_more=true 时只是部分；要拿全集请按 next_page 继续调用。',
      schema: LIST_SESSIONS_SCHEMA,
      handler: async (args) => {
        const channel_id = args.channel_id as string
        let channelPort: number
        try {
          channelPort = await resolveChannelPort(channel_id)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用: ${msg}` })
        }
        if (!channelPort) {
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用` })
        }
        const page = (args.page as number | undefined) ?? 1
        const userSpecifiedPageSize = args.page_size != null
        const page_size = clampPageSize((args.page_size as number | undefined) ?? 20)
        try {
          const result = await rpcClient.call<
            { type?: string; pagination: { page: number; page_size: number } },
            { items: unknown[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }
          >(
            channelPort, 'get_sessions',
            { type: args.type as string | undefined, pagination: { page, page_size } },
            moduleId,
          )
          return wrapText(annotatePagination(result, { requestedPage: page, requestedPageSize: page_size, userSpecifiedPageSize }))
        } catch (err) {
          return wrapText(translateChannelError(err))
        }
      },
    },

    // ================================================================
    // 3b. list_group_members — 查指定群的成员列表与总数
    // ================================================================
    {
      name: 'list_group_members',
      description:
        '查指定群（session_id 必须是 group 类型 session）的成员列表与总数。' +
        '返回 { items, pagination, member_count, members_complete, partial_reason? }。' +
        '**`members_complete=false` 时 `partial_reason` 会说明为什么不完整、哪些字段可信、如何兜底——必须读它再决定怎么用结果，不能拿 items 当全集**。' +
        '不要从 Session.participants 反推群成员，那是 channel 内部维护的"已感知"集合，不是全集。',
      schema: LIST_GROUP_MEMBERS_SCHEMA,
      handler: async (args) => {
        const channel_id = args.channel_id as string
        const session_id = args.session_id as string
        let channelPort: number
        try {
          channelPort = await resolveChannelPort(channel_id)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用: ${msg}` })
        }
        if (!channelPort) {
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用` })
        }
        const page = (args.page as number | undefined) ?? 1
        const userSpecifiedPageSize = args.page_size != null
        const page_size = clampPageSize((args.page_size as number | undefined) ?? 50)
        try {
          const result = await rpcClient.call<
            { session_id: string; pagination: { page: number; page_size: number } },
            {
              items: unknown[]
              pagination: { page: number; page_size: number; total_items: number; total_pages: number }
              member_count: number
              members_complete: boolean
              partial_reason?: string
            }
          >(
            channelPort, 'list_group_members',
            { session_id, pagination: { page, page_size } },
            moduleId,
          )
          return wrapText(annotatePagination(result, { requestedPage: page, requestedPageSize: page_size, userSpecifiedPageSize }))
        } catch (err) {
          return wrapText(translateChannelError(err))
        }
      },
    },

    // ================================================================
    // 4. send_private_message — 给熟人发私聊消息
    // ================================================================
    {
      name: 'send_private_message',
      description: '给熟人发私聊消息。当你不关心使用哪个 Channel 或不知道该用哪个 Channel 时使用此工具。系统自动查找可用 Channel 并创建/复用私聊 Session。如果你已知 channel_id 和 session_id，请直接使用 send_message。',
      schema: SEND_PRIVATE_MESSAGE_SCHEMA,
      handler: async (args) => {
        const contextError = requireDeclaredShortcut(getToolSet, 'send_private_message')
        if (contextError) return contextError
        const friend_id = args.friend_id as string
        const content = args.content as string
        try {
          // 1. 查询 friend 信息
          const adminPort = await getAdminPort()
          const friendResult = await rpcClient.call<
            { friend_id: string },
            { friend: Friend }
          >(adminPort, 'get_friend', { friend_id: friend_id }, moduleId)

          const identities = friendResult.friend.channel_identities
          if (identities.length === 0) {
            return wrapText({ error: `熟人 ${friendResult.friend.display_name} 没有关联任何 Channel` })
          }

          // 2. 逐个尝试 channel，找到第一个可用的
          let lastError = ''
          for (const identity of identities) {
            let channelPort: number
            try {
              channelPort = await resolveChannelPort(identity.channel_id)
            } catch {
              lastError = `Channel ${identity.channel_id} 不可用`
              continue
            }
            if (!channelPort) {
              lastError = `Channel ${identity.channel_id} 不可用`
              continue
            }

            try {
              // 3. 查找或创建私聊 session
              const sessionResult = await rpcClient.call<
                { platform_user_id: string },
                { session: { id: string }; created: boolean }
              >(channelPort, 'find_or_create_private_session', {
                platform_user_id: identity.platform_user_id,
              }, moduleId)

              const sessionId = sessionResult?.session?.id
              if (!sessionId) {
                lastError = `Channel ${identity.channel_id} 返回的 session 缺少 id`
                continue
              }

              // 4. 发送消息
              const sendResult = await withRetry(async () => {
                return rpcClient.call<
                  { session_id: string; content: { type: string; text: string } },
                  { platform_message_id: string; sent_at: string }
                >(channelPort, 'send_message', {
                  session_id: sessionId,
                  content: { type: 'text', text: content },
                }, moduleId)
              })

              return wrapText({
                ...sendResult,
                channel_id: identity.channel_id,
                session_id: sessionId,
              })
            } catch (err) {
              lastError = err instanceof Error ? err.message : String(err)
              continue
            }
          }

          return wrapText({ error: `所有 Channel 均不可用: ${lastError}` })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error: `发送失败: ${msg}` })
        }
      },
    },

    // ================================================================
    // 4b. send_master_private — 给 master 发私聊（按 permission='master' 自动定位）
    // ================================================================
    {
      name: 'send_master_private',
      description: `给 master 发私聊消息。

唯一入口：scheduled 任务（每日反思 / 记忆整理等）需要对外通知 master 时必须用此工具。
内部行为：admin 按 permission='master' 定位 master friend → 在指定 channel 上 find_or_create 私聊 session → 发出。
找不到 master 时**直接返回 error，不退化、不外发任何 channel**。

注意：发出的内容会被人类看到——禁止塞 trace 数据 / Evolution Mode / case→rule / Audit 等内部黑话，必须翻译成一行人话（"今日整理 X 条经验，无重大发现"这种），多行长报告请走 task outcome 不要外发。`,
      schema: SEND_MASTER_PRIVATE_SCHEMA,
      handler: async (args) => {
        const contextError = requireDeclaredShortcut(getToolSet, 'send_master_private')
        if (contextError) return contextError
        const content = args.content as string
        const preferredChannelId = args.channel_id as string | undefined

        const adminPort = await getAdminPort()
        const masterResult = await rpcClient.call<
          Record<string, never>,
          { friend: Friend | null }
        >(adminPort, 'find_master_friend', {}, moduleId)

        const master = masterResult.friend
        if (!master) {
          return wrapText({ error: 'No master friend configured; cannot send_master_private' })
        }

        const identities = master.channel_identities
        if (!identities || identities.length === 0) {
          return wrapText({ error: `Master friend ${master.display_name} has no channel identities` })
        }

        // preferredChannelId 指定时只尝试该 channel，不可用直接报错
        const candidates = preferredChannelId
          ? identities.filter(ci => ci.channel_id === preferredChannelId)
          : identities

        if (preferredChannelId && candidates.length === 0) {
          return wrapText({
            error: `Master has no identity on channel ${preferredChannelId}`,
            available_channels: identities.map(ci => ci.channel_id),
          })
        }

        let lastError = ''
        for (const identity of candidates) {
          let channelPort: number
          try {
            channelPort = await resolveChannelPort(identity.channel_id)
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err)
            continue
          }
          if (!channelPort) {
            lastError = `Channel ${identity.channel_id} 不可用`
            continue
          }

          try {
            const sessionResult = await rpcClient.call<
              { platform_user_id: string },
              { session: { id: string }; created: boolean }
            >(channelPort, 'find_or_create_private_session', {
              platform_user_id: identity.platform_user_id,
            }, moduleId)

            const sessionId = sessionResult?.session?.id
            if (!sessionId) {
              lastError = `Channel ${identity.channel_id} 返回的 session 缺少 id`
              continue
            }

            const sendResult = await withRetry(async () => {
              return rpcClient.call<
                { session_id: string; content: { type: string; text: string } },
                { platform_message_id: string; sent_at: string }
              >(channelPort, 'send_message', {
                session_id: sessionId,
                content: { type: 'text', text: content },
              }, moduleId)
            })

            return wrapText({
              ...sendResult,
              channel_id: identity.channel_id,
              session_id: sessionId,
              friend_id: master.id,
            })
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err)
            continue
          }
        }

        return wrapText({
          error: preferredChannelId
            ? `Channel ${preferredChannelId} 发送失败: ${lastError}`
            : `All master channels failed: ${lastError}`,
        })
      },
    },

    // ================================================================
    // 5. send_message — 发送消息
    // ================================================================
    {
      name: 'send_message',
      description: `在指定 Channel 的指定 Session 中发送消息。支持文本、媒体 URL、本地文件路径。

## 铁则：这是**唯一**让人类看到内容的工具

crabot 系统给你的所有信号——system prompt、supplement 注入、tool result、audit 报告、\`/清除目标\` 的响应、engine 拦截、forced summary 提醒——**人类完全看不见**，只有你看得见。它们是你的"内部思维空间"。

调用 send_message 前先问自己：**人类必须知道这件事吗？** 如果只是 crabot 系统在跟你对账（"audit 卡了 / 系统让我重写 / engine 不让我 end_turn"）——闭嘴，自己消化，换策略或开始干活。**不要把内部黑话（audit / criterion / 审计员 / \`/清除目标\` / blocked / acceptance_criteria / forced_summary）直接搬给人类看**，要翻译成自然语言（"我搞不定 X" / "需要您 Y"）。

## 两个合法场景（intent 参数）

唯一对外通道分两档，全部 audience 都是人类：

- **"info"（默认）**：进度告知 / ack / 中间结果 / 最终交付。人类会看到、不期待回复。**不用于**"我做不到 / 卡住了 / 想换方向"——这种话发出去人类也只是看到，loop 不会停，下一轮你还得面对同样状态。
- **"ask_human"**：阻塞等人类同步回复（task 切 waiting_human）。**任何想让 master 同步回复才能继续的场景**都用它，不限问句形态——决策分叉 / 求助 / 关键澄清都算。Self-check：你期不期待回复内容会改变下一轮动作？期待→ask_human，不期待→info。滥用会让任务停摆，能自己决策的不要 ask。`,
      schema: SEND_MESSAGE_SCHEMA,
      handler: async (args) => {
        const channel_id = args.channel_id as string
        const session_id = args.session_id as string
        const content = args.content as string
        const intent = args.intent as 'info' | 'ask_human' | undefined
        const content_type = args.content_type as 'text' | 'image' | 'file' | undefined
        const media_url = args.media_url as string | undefined
        let file_path = args.file_path as string | undefined

        // === 工具自愈（B）：本地（无沙盒映射）→ 就地用当前 cwd 把相对路径 / `~` 解析成绝对路径 ===
        // 远程 worker（有 sandboxPathMappings）的相对路径交给 dispatch 的 mapSandboxPathToHost 处理，不动。
        // 本地 unified agent 无映射时，相对路径若不在此解析，会拖到延迟 flush 才在 dispatch 抛错，
        // 且那时该消息已脱离工具调用轮、失败无法回传给 worker（trace a72623ec 成因）。
        // 用 canonical resolvePath（含 `~` 展开；对已是绝对路径的输入是 no-op）。
        if (
          file_path !== undefined
          && (!sandboxPathMappingsRef || sandboxPathMappingsRef.current.length === 0)
        ) {
          const cwd = deps.getTaskContext?.()?.getCwd?.()
          if (cwd) file_path = resolvePath(cwd, file_path)
        }
        const filename = args.filename as string | undefined
        const mentions = args.mentions as Array<{ friend_id?: string; platform_user_id?: string; at_name?: string }> | undefined
        const quote_message_id = args.quote_message_id as string | undefined

        // === SYSTEM_SESSION 哨兵拒收：schedule 无 target_session 时 ScheduledTaskRunner
        // 注入的占位 session 不可作为真实发送目标。worker 应按 trigger_message 的
        // system_event 文本指引调 send_master_private 或其他工具汇报。 ===
        if (channel_id === SYSTEM_CHANNEL_ID || session_id === SYSTEM_SESSION_ID) {
          return wrapText({
            error: '此 session 是系统占位符（schedule 无 target_session 场景），不可直接发送。请按 trigger_message 的文本指引调 send_master_private 或选定真实 channel/session 后再发。',
          })
        }

        // === ask_human：先验证 task context 存在，再继续（不提前切状态） ===
        if (intent === 'ask_human') {
          const taskCtx = deps.getTaskContext?.()
          if (!taskCtx) {
            // 消息尚未发出，直接拒绝。ask_human 不该被 front 调用，这是 safeguard。
            return wrapText({ error: 'ask_human 仅可在 worker 任务上下文内调用' })
          }
          // 运行时门读装配层声明（与工具可见性同源）：没声明 ask_human 就不给走。
          if (!getToolSet().allowAskHuman) {
            return wrapText({
              error: 'ask_human is not allowed in scheduled tasks. Scheduled tasks have no synchronous '
                + "human responder. If you are blocked or have failed, send_message with intent='info' "
                + 'to report status, then end_turn.',
            })
          }
        }

        // 统一构造 dispatchDeps（含 §4.13 钩子点 onDispatched）—— 缓冲分支 "新顶旧" sync flush 与
        // immediate-send 都用同一份，保证 dispatch success 路径触发钩子的语义统一。
        // taskCtx 为空时（front 调用）onDispatched 缺省，钩子不触发，行为不变。
        const dispatchDeps: OutboundDispatchDeps = {
          rpcClient,
          moduleId,
          resolveChannelPort,
          getAdminPort,
          ...(deps.adminChatDelivery ? { adminChatDelivery: deps.adminChatDelivery } : {}),
          ...(sandboxPathMappingsRef ? { sandboxPathMappingsRef } : {}),
          ...((() => {
            const taskCtx = deps.getTaskContext?.()
            return taskCtx?.onDispatched ? { onDispatched: taskCtx.onDispatched } : {}
          })()),
        }

        // === Goal mode 缓冲分支：goal mode + 工作态（无 active audit）时 intent='info' 进 outboundBuffer 不真发 ===
        // 等审态（audit 在跑）→ 立即 flush（过程响应/进度告知，不进新缓冲）
        // ask_human → 走下面的 send + barrier 路径
        // 非 goal mode → 立即发（现行行为）
        //
        // **新顶旧（spec §4.1 Revision 第 1 段）**：buffer 已有旧条时先 sync flush 旧条再 push 新条。
        // buffer 永远 ≤ 1 条，"send_message + 立即 end_turn" 组合才是触发 audit 的唯一路径。
        // spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.1 + §4.6
        if (intent !== 'ask_human') {
          const taskCtx = deps.getTaskContext?.()
          if (
            taskCtx
            && taskCtx.hasGoal()
            && taskCtx.outboundBuffer
            && taskCtx.hasActiveAudit
            && !taskCtx.hasActiveAudit()
          ) {
            // 新顶旧：buffer 已有上一条 → 先 sync flush 出去（触发 onDispatched 钩子置 everSentMessage）
            // 失败不阻塞新条入 buffer（与 createOutboundFlush 的 continue-on-error 一致）
            if (taskCtx.outboundBuffer.length > 0) {
              const oldEntries = taskCtx.outboundBuffer.splice(0)
              for (const oldEntry of oldEntries) {
                try {
                  await dispatchOutboundMessage(oldEntry, dispatchDeps)
                } catch (err) {
                  console.warn(
                    '[send_message] 新顶旧 flush 旧条失败:',
                    err instanceof Error ? err.message : String(err),
                  )
                }
              }
            }
            taskCtx.outboundBuffer.push({
              channel_id,
              session_id,
              content,
              // 缓冲分支只在 intent='info' 命中（goal mode + 工作态 + !ask_human + 非 immediate）。
              // ask_human 永远走下方 immediate-send 路径，不进 buffer。
              intent: 'info',
              ...(content_type !== undefined ? { content_type } : {}),
              ...(media_url !== undefined ? { media_url } : {}),
              ...(file_path !== undefined ? { file_path } : {}),
              ...(filename !== undefined ? { filename } : {}),
              ...(mentions !== undefined ? { mentions } : {}),
              ...(quote_message_id !== undefined ? { quote_message_id } : {}),
              ...(taskCtx.getHumanInputEpoch !== undefined ? { human_input_epoch: taskCtx.getHumanInputEpoch() } : {}),
              sent_at_attempt_ms: Date.now(),
            })
            taskCtx.onBuffered?.()
            return wrapText({
              buffered: true,
              sent_at: null,
              note: '消息已待发；将在 audit 通过后真正发给用户',
            })
          }
        }

        // === Step 1: 先 send（高失败率操作先做；失败 → state 完全不变）===
        // 路径选择 + mention 解析 + channel sendMessage 共用 dispatchOutboundMessage，保证 immediate-send
        // 与 flush 路径（createOutboundFlush）功能等价（同样的 path mapping + friend_id resolve + §4.13 钩子）。
        const currentTaskCtx = deps.getTaskContext?.()
        const dispatchEntry: OutboundBufferEntry = {
          channel_id,
          session_id,
          content,
          // 真实 intent —— immediate-send 路径覆盖了 ask_human + 非 goal mode info + 等审态 info 等。
          // PR-2 onDispatched callback 用 entry.intent 写 task.messages.agent_intent 真值。
          // intent 缺省（front 路径不带）时回退 'info'。spec §4.13.7 Revision 2026-06-09 第 2 段。
          intent: intent ?? 'info',
          ...(content_type !== undefined ? { content_type } : {}),
          ...(media_url !== undefined ? { media_url } : {}),
          ...(file_path !== undefined ? { file_path } : {}),
          ...(filename !== undefined ? { filename } : {}),
          ...(mentions !== undefined ? { mentions } : {}),
          ...(quote_message_id !== undefined ? { quote_message_id } : {}),
          ...(currentTaskCtx?.getHumanInputEpoch !== undefined
            ? { human_input_epoch: currentTaskCtx.getHumanInputEpoch() }
            : {}),
          sent_at_attempt_ms: Date.now(),
        }
        let sendResult: { platform_message_id: string; sent_at: string }
        try {
          // 重试包一层；dispatch 内部已含 path mapping + mention resolve + features 组装
          sendResult = await withRetry(() => dispatchOutboundMessage(dispatchEntry, dispatchDeps))
        } catch (err) {
          // send 失败 → state 完全不变（task 仍 executing，无 barrier）
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error: `发送失败: ${msg}` }, { isError: true })
        }

        // === Step 2 & 3: send 成功后处理 ask_human 后置逻辑 ===
        if (intent === 'ask_human') {
          // getTaskContext 在入口已校验过非 null，此处直接取
          const taskCtx = deps.getTaskContext!()!
          const adminPort = await getAdminPort()
          const pendingQuestion = content.slice(0, ASK_HUMAN_PENDING_QUESTION_MAX_LEN)

          const transitionToWaitingHuman = async () => {
            await rpcClient.call<
              { task_id: string; status: string; pending_question: string },
              { task: unknown }
            >(adminPort, 'update_task_status', {
              task_id: taskCtx.taskId,
              status: 'waiting_human',
              pending_question: pendingQuestion,
            }, moduleId)
          }

          // Step 2: update_task_status（admin 同进程 RPC，几乎不会失败；
          // 即使失败，消息已发，worker 看到 error 字段会自行处理，不会卡 barrier）
          let stateError: string | undefined
          try {
            await transitionToWaitingHuman()
          } catch (rpcErr) {
            const msg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr)
            // 区分两类失败：
            //  - persistent（状态机非法 transition，常因 trigger 路径未把 task 推到 executing）→ 尝试补齐状态机后重试
            //  - transient（admin 不健康 / 网络）→ 按 spec §5.3 直接兜底，不暂停 worker
            if (msg.includes('INVALID_STATUS_TRANSITION')) {
              // 无脑 try planning → executing；当前 status 若已在某档位，相应的 transition 会被 admin 拒，
              // 这里 catch 吞掉继续——目标是把 task 推到 executing 作为 waiting_human 的合法前继。
              for (const status of ['planning', 'executing'] as const) {
                try {
                  await rpcClient.call<
                    { task_id: string; status: string },
                    { task: unknown }
                  >(adminPort, 'update_task_status', {
                    task_id: taskCtx.taskId,
                    status,
                  }, moduleId)
                } catch { /* 状态机已在更高档位时同 status 转换会被拒，吞掉继续 */ }
              }
              try {
                await transitionToWaitingHuman()
              } catch (retryErr) {
                const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
                stateError = `update_task_status 重试仍失败：${retryMsg}`
              }
            } else {
              stateError = `update_task_status 失败：${msg}`
            }
          }

          if (stateError !== undefined) {
            // 补齐失败 / transient admin 故障：消息已发但状态没切。
            // 返回含 ask_human_state_error 的结果，worker 看到 error 字段会自己处理，不设 barrier 防止卡死。
            return wrapText({
              ...sendResult,
              ask_human_state_error: stateError,
            })
          }

          // Step 3: setBarrier（本地内存操作，从不失败）
          // onTimeout 兜底：barrier 自醒时先确认 admin 那边还没判死（见 abortIfTaskTerminal 注释）。
          taskCtx.humanQueue.setBarrier(ASK_HUMAN_BARRIER_TIMEOUT_MS, () => {
            void taskCtx.abortIfTaskTerminal?.()
          })
        }

        return wrapText({
          ...sendResult,
        })
      },
    },

    // ================================================================
    // 6. get_history — 查看聊天记录
    // ================================================================
    {
      name: 'get_history',
      description: '查看指定 Channel 上某个 Session 的历史消息。',
      schema: GET_HISTORY_SCHEMA,
      handler: async (args) => {
        const channel_id = args.channel_id as string
        const session_id = args.session_id as string
        const keyword = args.keyword as string | undefined
        const limit = args.limit as number | undefined
        const before = args.before as string | undefined
        const after = args.after as string | undefined

        try {
          const channelPort = await resolveChannelPort(channel_id)
          if (!channelPort) {
            return wrapText({ error: `Channel ${channel_id} 不可用` })
          }

          const timeRange = (before || after)
            ? { before: before, after: after }
            : undefined

          const result = await rpcClient.call<
            {
              session_id: string
              time_range?: { before?: string; after?: string }
              keyword?: string
              limit?: number
            },
            {
              // Channel 协议返回 PaginatedResult<HistoryMessage>，字段名是 items
              items: Array<{
                platform_message_id: string
                sender_name: string
                sender_platform_user_id?: string
                content: string
                content_type: string
                timestamp: string
              }>
            }
          >(channelPort, 'get_history', {
            session_id: session_id,
            ...(timeRange ? { time_range: timeRange } : {}),
            ...(keyword ? { keyword: keyword } : {}),
            limit: limit ?? 20,
          }, moduleId)

          const messages = result.items ?? []

          // 将 platform_user_id 映射为 friend_id（去重后批量查询）
          const adminPort = await getAdminPort()
          const uniqueUserIds = [...new Set(
            messages
              .map(m => m.sender_platform_user_id)
              .filter((id): id is string => !!id),
          )]
          const friendMap = new Map<string, string | undefined>()
          await Promise.all(uniqueUserIds.map(async (puid) => {
            try {
              const resolveResult = await rpcClient.call<
                { channel_id: string; platform_user_id: string },
                { friend: Friend | null }
              >(adminPort, 'resolve_friend', {
                channel_id: channel_id,
                platform_user_id: puid,
              }, moduleId)
              friendMap.set(puid, resolveResult.friend?.id)
            } catch {
              // ignore mapping failures
            }
          }))

          const enrichedMessages = messages.map(msg => ({
            platform_message_id: msg.platform_message_id,
            sender_name: msg.sender_name,
            sender_friend_id: msg.sender_platform_user_id
              ? friendMap.get(msg.sender_platform_user_id)
              : undefined,
            content: msg.content,
            content_type: msg.content_type,
            timestamp: msg.timestamp,
          }))

          return wrapText({ messages: enrichedMessages })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error: `查询历史失败: ${msg}` })
        }
      },
    },

    // ================================================================
    // 7. get_message — 按 ID 查询单条消息
    // ================================================================
    {
      name: 'get_message',
      description: '按消息 ID 查询单条消息详情。当消息内容不完整时可用此工具查看完整内容。',
      schema: GET_MESSAGE_SCHEMA,
      handler: async (args) => {
        const channel_id = args.channel_id as string
        const session_id = args.session_id as string
        const platform_message_id = args.platform_message_id as string

        try {
          const channelPort = await resolveChannelPort(channel_id)
          if (!channelPort) {
            return wrapText({ error: `Channel ${channel_id} 不可用` })
          }

          const result = await rpcClient.call<
            { session_id: string; platform_message_id: string },
            {
              platform_message_id: string
              sender: { platform_user_id: string; platform_display_name: string }
              content: { type: string; text?: string; media_url?: string }
              features: Record<string, unknown>
              platform_timestamp: string
            }
          >(channelPort, 'get_message', {
            session_id: session_id,
            platform_message_id: platform_message_id,
          }, moduleId)

          // friend-id enrichment（与 get_history 保持一致）
          let senderFriendId: string | undefined
          const puid = result.sender?.platform_user_id
          if (puid) {
            try {
              const adminPort = await getAdminPort()
              const resolveResult = await rpcClient.call<
                { channel_id: string; platform_user_id: string },
                { friend: Friend | null }
              >(adminPort, 'resolve_friend', {
                channel_id: channel_id,
                platform_user_id: puid,
              }, moduleId)
              senderFriendId = resolveResult.friend?.id
            } catch {
              // ignore mapping failure
            }
          }

          return wrapText({
            platform_message_id: result.platform_message_id,
            sender_name: result.sender?.platform_display_name,
            sender_friend_id: senderFriendId,
            content: result.content?.text ?? '',
            content_type: result.content?.type ?? 'text',
            timestamp: result.platform_timestamp,
            quote_message_id: result.features?.quote_message_id,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error: `查询消息失败: ${msg}` })
        }
      },
    },
    // ================================================================
    // 8. fetch_media — 按需下载消息附件（非图片），返回本地路径供 Read 工具读取
    // ================================================================
    {
      name: 'fetch_media',
      description:
        '按需下载某条消息携带的非图片文件（如 PDF/视频），返回可用 Read 工具读取的本地路径。' +
        '入参 channel_id（消息来源渠道）+ handle（来自消息里 [文件: … handle=fm_xxx] 标记）。' +
        '重复调用返回同一本地路径。',
      schema: FETCH_MEDIA_SCHEMA,
      handler: async (args: Record<string, unknown>) => {
        const channel_id = args.channel_id as string
        const handle = args.handle as string
        try {
          const channelPort = await resolveChannelPort(channel_id)
          if (!channelPort) {
            return wrapText({ error: `Channel ${channel_id} 不可用` })
          }
          const result = await rpcClient.call<
            { handle: string },
            { status: string; file_path?: string; mime_type?: string; size?: number; error?: string }
          >(channelPort, 'fetch_media', { handle }, moduleId)
          if (result.status === 'fetching') {
            return wrapText({
              ...result,
              note: '文件较大，正在后台下载。请 end_turn；下载完成事件会唤醒对应会话。' +
                '下载完成会唤醒你，届时再次调用 fetch_media 即可拿到 file_path。',
            })
          }
          return wrapText(result)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error: `fetch_media 失败: ${msg}` })
        }
      },
    },

    // ================================================================
    // 9. read_feishu_document — 读取飞书云文档正文（有飞书 channel 时才注入）
    // ================================================================
    ...(deps.enableFeishuDocTool ? [{
      name: 'read_feishu_document',
      description: '读取飞书云文档正文（支持 docx / wiki / sheets）。传入飞书文档 URL，返回标题和纯文本正文。遇到权限不足时返回授权指引。注意：读取 wiki/docx 需要把本应用（或应用所在群）加为文档/文件夹/知识空间的协作者。',
      schema: READ_FEISHU_DOCUMENT_SCHEMA,
      handler: async (args: Record<string, unknown>) => {
        const url = args.url as string
        const maxChars = typeof args.max_chars === 'number' ? args.max_chars : undefined
        const port = await resolveFeishuChannelPort(args)
        if ('error_code' in port) return wrapText(port)
        try {
          const result = await rpcClient.call<
            { url: string; max_chars?: number },
            { type: string; title: string; text: string; truncated: boolean; url: string }
          >(port.channelPort, 'read_document', { url, ...(maxChars !== undefined ? { max_chars: maxChars } : {}) }, moduleId)
          return wrapText(result)
        } catch (err: unknown) {
          return wrapText(translateChannelError(err))
        }
      },
    } as MessagingTool] : []),

    // ================================================================
    // 10. feishu_raw_get — 飞书原生只读 API 逃生门
    // ================================================================
    ...(deps.enableFeishuDocTool ? [{
      name: 'feishu_raw_get',
      description: '飞书原生只读 API 逃生门：GET 任意 /open-apis 端点。仅当 read_feishu_document 覆盖不到的非常规读场景才用；常规读文档/表格/wiki 一律优先 read_feishu_document。',
      schema: FEISHU_RAW_GET_SCHEMA,
      handler: async (args: Record<string, unknown>) => {
        const port = await resolveFeishuChannelPort(args)
        if ('error_code' in port) return wrapText(port)
        try {
          const result = await rpcClient.call(port.channelPort, 'feishu_get',
            { path: args.path, ...(args.query ? { query: args.query } : {}) }, moduleId)
          return wrapText(result)
        } catch (err: unknown) { return wrapText(translateChannelError(err)) }
      },
    } as MessagingTool, {
      name: 'feishu_download_file',
      description: '把 drive 文件登记为可下载句柄；返回 handle 后用 fetch_media(handle) 取本地路径再用 Read/Bash 解析。',
      schema: FEISHU_DOWNLOAD_FILE_SCHEMA,
      handler: async (args: Record<string, unknown>) => {
        const port = await resolveFeishuChannelPort(args)
        if ('error_code' in port) return wrapText(port)
        try {
          const result = await rpcClient.call(port.channelPort, 'feishu_download',
            { file_token: args.file_token, ...(args.filename ? { filename: args.filename } : {}) }, moduleId)
          return wrapText(result)
        } catch (err: unknown) { return wrapText(translateChannelError(err)) }
      },
    } as MessagingTool, {
      name: 'feishu_write',
      description: '飞书原生写操作透传（POST/PUT/PATCH/DELETE）。会真实修改飞书数据（改/删文档、表格、踢人等），多数不可回滚——调用前务必确认这是用户明确要的操作。只读一律用 read_feishu_document / feishu_raw_get。被本 channel 关闭写操作或缺写权限时会返回提示。',
      schema: FEISHU_WRITE_SCHEMA,
      handler: async (args: Record<string, unknown>) => {
        const port = await resolveFeishuChannelPort(args)
        if ('error_code' in port) return wrapText(port)
        try {
          const result = await rpcClient.call(port.channelPort, 'feishu_write',
            { method: args.method, path: args.path, ...(args.body ? { body: args.body } : {}), ...(args.query ? { query: args.query } : {}) }, moduleId)
          return wrapText(result)
        } catch (err: unknown) { return wrapText(translateChannelError(err)) }
      },
    } as MessagingTool] : []),
  ]

  const declared = getToolSet().tools
  return allTools.filter(tool => declared.has(tool.name))
}

/**
 * worker/front 装配入口：先按 TaskContext 算出工具集声明，再交给 `buildMessagingTools`。
 * PR J 摘除 worker 侧 messaging 装配时整个函数一并删除。
 */
export function buildWorkerMessagingTools(
  deps: CrabMessagingDeps,
  sandboxPathMappingsRef?: { current: PathMapping[] },
): MessagingTool[] {
  return buildMessagingTools(
    deps,
    () => workerMessagingToolSet(deps.getTaskContext?.() ?? null),
    sandboxPathMappingsRef,
  )
}

// ============================================================================
// MCP Server 创建
// ============================================================================

export function createCrabMessagingServer(
  deps: CrabMessagingDeps,
  sandboxPathMappingsRef?: { current: PathMapping[] },
): McpServer {
  const server = createMcpServer({ name: 'crab-messaging', version: '1.0.0' })

  const tools = buildWorkerMessagingTools(deps, sandboxPathMappingsRef)
  for (const t of tools) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, t.handler as never)
  }

  return server
}
