/**
 * Crab-Memory MCP Server — Agent 长期记忆能力
 *
 * 两组工具（共 18 个，按任务 profile 分组注册，见 resolveMemoryToolProfile）：
 * - A 组 6 个（Worker 普通对话可见）：store_memory / search_memory / get_memory_detail /
 *   set_scene_profile / get_scene_profile / delete_scene_profile
 *   importance / brief 等字段自动推断，最少参数即可落盘
 * - B 组 12 个（反思/整理/重建类任务可见）：quick_capture / search_long_term /
 *   update_long_term / delete_memory / list_recent / list_entries / set_memory_links /
 *   run_maintenance / get_stats / get_evolution_mode / set_evolution_mode / promote_to_rule
 *   字段精细可控，工具名与 Memory RPC 一一对应，供反思/整理/重建 SKILL 使用
 *
 * @see crabot-docs/protocols/protocol-memory.md
 */

import { createMcpServer, type McpServer } from './mcp-helpers.js'
import { z } from 'zod/v4'
import type { RpcClient } from 'crabot-shared'

// ============================================================================
// 依赖注入接口
// ============================================================================

export interface CrabMemoryDeps {
  rpcClient: RpcClient
  moduleId: string
  getMemoryPort: () => Promise<number>
}

/** 每次任务创建时传入的上下文，用于自动填充 source/visibility/scopes */
export interface MemoryTaskContext {
  /** Worker 调用时必传；Front 调用时可省（Front 不是 task 上下文） */
  taskId?: string
  channelId?: string
  sessionId?: string
  visibility: 'private' | 'internal' | 'public'
  scopes: string[]
  /** 记忆来源类型，默认 'conversation' */
  sourceType?: 'conversation' | 'reflection' | 'system'
  /** 场景推断所需：群聊 sessionType='group'；私聊 'private' 需 friendId */
  sessionType?: 'private' | 'group'
  senderFriendId?: string
  /** master 私聊场景；决定 scene_profile 工具是否暴露 scene 参数（v0.3.0 起） */
  isMasterPrivate: boolean
}

function defaultSceneProfileLabel(
  scene: { type: 'group_session'; channel_id: string; session_id: string } | { type: 'friend'; friend_id: string },
): string {
  if (scene.type === 'friend') return `friend:${scene.friend_id}`
  return `group:${scene.channel_id}:${scene.session_id}`
}

/** brief 必须 ≤80 字符且非空，从 content 首行截取 */
function deriveBriefFromContent(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const trimmed = firstLine || content.trim()
  return trimmed.slice(0, 80) || 'untitled'
}

/** 1-10 importance → 4 维 importance_factors（0-1 区间） */
function importanceToFactors(importance: number | undefined): {
  proximity: number
  surprisal: number
  entity_priority: number
  unambiguity: number
} {
  const raw = typeof importance === 'number' ? importance : 5
  const clamped = Math.min(10, Math.max(1, raw))
  const normalized = clamped / 10
  return {
    proximity: 0.5,
    surprisal: normalized,
    entity_priority: 0.5,
    unambiguity: 0.5,
  }
}

export async function resolveSceneAnchorLabel(params: {
  rpcClient: RpcClient
  memoryPort: number
  moduleId: string
  scene: { type: 'group_session'; channel_id: string; session_id: string } | { type: 'friend'; friend_id: string }
}): Promise<string> {
  const result = await params.rpcClient.call<
    { scene: typeof params.scene },
    { profile: { label?: string | null } | null }
  >(
    params.memoryPort,
    'get_scene_profile',
    { scene: params.scene },
    params.moduleId,
  )

  const existingLabel = result?.profile?.label?.trim()
  return existingLabel || defaultSceneProfileLabel(params.scene)
}

// ============================================================================
// 工具分组 profile（同构于 crab-messaging.ts 的 resolveMessagingToolProfile）
// ============================================================================

export type MemoryToolProfile =
  | 'conversation'
  /** 全量 18 个：daily_reflection 反思 / memory_curate 整理 / memory_rebuild 重建任务 */
  | 'daily_reflection'

/**
 * A 组：Worker 普通对话可见的 6 个简化工具（未加 mcp__ 前缀的工具名）。
 * 其余 12 个（B 组）仅在反思/整理/重建类任务中注册。
 */
export const CRAB_MEMORY_CONVERSATION_TOOLS: ReadonlySet<string> = new Set([
  'store_memory',
  'search_memory',
  'get_memory_detail',
  'set_scene_profile',
  'get_scene_profile',
  'delete_scene_profile',
])

/** buildToolsDynamic 转换后的工具名前缀（mcp__<server>__<tool>） */
const CRAB_MEMORY_TOOL_PREFIX = 'mcp__crab-memory__'

/**
 * 按任务用途决定 crab-memory 工具注册范围（不再要求 trigger_type==='scheduled'）：
 * - task_type ∈ {daily_reflection, memory_curate} 或 tags 含 'memory_rebuild' → 全量 18 个
 *   （反思/整理/重建 SKILL 需要 B 组精细工具：list_entries / delete_memory /
 *    update_long_term / set_memory_links 等）
 * - 其他所有任务 → 仅 A 组 6 个
 * memory_maintenance 任务不经 Worker（scheduled-task-runner 直接 RPC），不受此影响。
 */
export function resolveMemoryToolProfile(
  taskCtx: { taskType?: string; tags?: readonly string[] } | null,
): MemoryToolProfile {
  if (
    taskCtx?.taskType === 'daily_reflection'
    || taskCtx?.taskType === 'memory_curate'
    || taskCtx?.tags?.includes('memory_rebuild') === true
  ) {
    return 'daily_reflection'
  }
  return 'conversation'
}

/** 按 profile 过滤已转换的 crab-memory 工具列表（conversation → 仅 A 组） */
export function filterMemoryToolsByProfile<T extends { name: string }>(
  tools: ReadonlyArray<T>,
  profile: MemoryToolProfile,
): T[] {
  if (profile === 'daily_reflection') return [...tools]
  return tools.filter((t) =>
    CRAB_MEMORY_CONVERSATION_TOOLS.has(t.name.slice(CRAB_MEMORY_TOOL_PREFIX.length)))
}

// ============================================================================
// 工具 inputSchema（必须是模块级常量，只构建一次）
//
// 为什么不能放进 createCrabMemoryServer：worker 每轮 LLM turn 都会通过
// buildToolsDynamic 重建本 server；zod v4 的 .describe() 会把 schema clone
// 写入 globalRegistry（强引用 Map，永不清除）。inline 构建 = 每轮净增整棵
// schema 树 → 2026-06-11 OOM 事故根因。回归测试：tests/mcp/zod-registry-leak.test.ts
// ============================================================================

const STORE_MEMORY_SCHEMA = {
  content: z.string().describe('要记住的完整信息（成为 body），应包含足够上下文'),
  brief: z.string().optional()
    .describe('召回标题（≤80 字符）。不传则自动从 content 首行截取'),
  type: z.enum(['fact', 'lesson', 'concept']).optional()
    .describe('记忆类型：fact=客观事实, lesson=经验教训, concept=概念定义（默认 fact）'),
  importance: z.number().min(1).max(10).optional()
    .describe('重要性 1-10，日常偏好 3-5，重要决策 6-8，关键信息 9-10（用于推断 importance_factors）'),
  tags: z.array(z.string()).optional()
    .describe('分类标签'),
}

const SEARCH_MEMORY_SCHEMA = {
  query: z.string().describe('FTS5 全文检索查询（trigram tokenizer，CJK/英文混合都支持）；query 抽词后 <3 字符的 token 不命中（trigram 固有限制）'),
  level: z.enum(['short_term', 'long_term']).default('long_term')
    .describe('搜索范围：short_term=事件流水账（找历史 ID 的入口），long_term=认知知识库'),
  limit: z.number().min(1).max(20).default(5)
    .describe('返回数量上限'),
}

const GET_MEMORY_DETAIL_SCHEMA = {
  memory_id: z.string().describe('记忆 ID'),
  include: z.enum(['brief', 'full']).default('full')
    .describe('详细程度：brief=仅返回标识与 brief, full=附带 body 与 frontmatter'),
}

const sourceRefSchema = z.object({
  type: z.enum(['conversation', 'reflection', 'system']).describe('来源类型'),
  task_id: z.string().optional(),
  channel_id: z.string().optional(),
  session_id: z.string().optional(),
})

const importanceFactorsSchema = z.object({
  proximity: z.number().min(0).max(1),
  surprisal: z.number().min(0).max(1),
  entity_priority: z.number().min(0).max(1),
  unambiguity: z.number().min(0).max(1),
})

// protocol-memory v0.3.0：SceneIdentity 收 2 路（global 已废除）
const sceneSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('group_session'),
    channel_id: z.string(),
    session_id: z.string(),
  }),
  z.object({
    type: z.literal('friend'),
    friend_id: z.string(),
  }),
])

type SceneArg =
  | { type: 'friend'; friend_id: string }
  | { type: 'group_session'; channel_id: string; session_id: string }

const QUICK_CAPTURE_SCHEMA = {
  type: z.enum(['fact', 'lesson', 'concept']).describe('记忆类型'),
  brief: z.string().describe('一行召回标题（≤80 字符），需含场景关键词'),
  content: z.string().describe('完整正文 markdown'),
  source_ref: sourceRefSchema.optional()
    .describe('来源指纹；不传默认 reflection'),
  entities: z.array(z.object({
    id: z.string(),
    type: z.string(),
    name: z.string().optional(),
  })).optional(),
  tags: z.array(z.string()).optional(),
  importance_factors: importanceFactorsSchema.optional()
    .describe('4 维重要性因子（每维 0-1）；不传默认全 0.5'),
  lesson_meta: z.object({
    scenario: z.string().optional(),
    outcome: z.enum(['success', 'failure']).optional(),
    source_cases: z.array(z.string()).optional(),
  }).optional()
    .describe('lesson 类型专属元数据'),
  source_trust: z.number().int().min(1).max(5).optional()
    .describe('来源信任度 1-5；默认 3'),
  content_confidence: z.number().int().min(1).max(5).optional()
    .describe('内容置信度 1-5；默认 3'),
  event_time: z.string().optional()
    .describe('ISO8601 事件时间；不传默认现在'),
}

const SEARCH_LONG_TERM_SCHEMA = {
  query: z.string().describe('自然语言查询；用 "*" 或 "recent" 占位 + filters 时表示无主题约束'),
  k: z.number().int().min(1).max(50).default(10),
  filters: z.object({
    type: z.enum(['fact', 'lesson', 'concept']).optional(),
    status: z.enum(['inbox', 'confirmed', 'trash']).optional(),
    tags: z.array(z.string()).optional(),
  }).optional(),
  include: z.enum(['brief', 'full']).default('brief'),
  recent_entities: z.array(z.string()).optional(),
}

const UPDATE_LONG_TERM_SCHEMA = {
  id: z.string().describe('记忆 ID'),
  patch: z.record(z.string(), z.unknown())
    .describe('字段差量。例如 { content_confidence_increment: 1 }、{ invalidated_by: "<新条 id>" }、{ maturity: "confirmed" }'),
}

const DELETE_MEMORY_SCHEMA = {
  id: z.string().describe('记忆 ID'),
}

const LIST_RECENT_SCHEMA = {
  window_days: z.number().int().min(1).max(90).default(7)
    .describe('时间窗口（天数）'),
  type: z.enum(['fact', 'lesson', 'concept']).optional(),
  limit: z.number().int().min(1).max(100).default(20),
}

const LIST_ENTRIES_SCHEMA = {
  type: z.enum(['fact', 'lesson', 'concept']).optional()
    .describe('按记忆类型过滤'),
  status: z.enum(['inbox', 'confirmed', 'trash']).optional()
    .describe('按审核状态过滤'),
  tags: z.array(z.string()).optional()
    .describe('按标签过滤'),
  ingestion_time_start: z.string().optional()
    .describe('按入库时间过滤，包含起点；ISO8601。记忆整理按 schedule watermark 增量扫描时使用'),
  ingestion_time_end: z.string().optional()
    .describe('按入库时间过滤，排除终点；ISO8601。记忆整理按 schedule 当前时间增量扫描时使用'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('返回数量上限'),
  offset: z.number().int().min(0).optional()
    .describe('分页偏移'),
}

const SET_MEMORY_LINKS_SCHEMA = {
  id: z.string().describe('记忆 ID'),
  links: z.array(z.object({
    target: z.string().describe('关联目标记忆 ID'),
    relation: z.enum(['related', 'refines', 'depends_on', 'part_of'])
      .describe('关联关系：related=相关 / refines=细化 / depends_on=依赖 / part_of=从属'),
  })).describe('关联链接列表（覆盖式写入 links 字段）'),
}

const RUN_MAINTENANCE_SCHEMA = {
  scope: z.enum(['all', 'observation_check', 'stale_aging', 'trash_cleanup']).default('all'),
  now_iso: z.string().optional().describe('覆盖当前时间（测试用）'),
}

const SET_EVOLUTION_MODE_SCHEMA = {
  mode: z.enum(['balanced', 'innovate', 'harden', 'repair-only']),
  reason: z.string().optional().describe('切换原因（写入审计）'),
}

const SCENE_ONLY_SCHEMA = {
  scene: sceneSchema,
}

const SET_SCENE_PROFILE_MASTER_SCHEMA = {
  scene: sceneSchema,
  label: z.string().optional(),
  content: z.string().describe('场景画像正文（覆盖式写入）'),
  source_memory_ids: z.array(z.string()).optional()
    .describe('来源记忆 ID 列表（追溯用）'),
}

const SET_SCENE_PROFILE_SCHEMA = {
  content: z.string().describe('场景画像正文（覆盖式写入）'),
  source_memory_ids: z.array(z.string()).optional()
    .describe('来源记忆 ID 列表（追溯用）'),
}

const PROMOTE_TO_RULE_SCHEMA = {
  source_cases: z.array(z.string()).min(3)
    .describe('≥3 条来源 case 的 id（spec §6.4 门槛）'),
  brief: z.string().describe('rule 召回标题（≤80 字符）'),
  content: z.string().describe('rule 完整正文：scenario / 适用条件 / 推荐做法 / 反例'),
  scenario: z.string().optional().describe('场景描述；不传则空'),
  source_trust: z.number().int().min(1).max(5).default(4),
  content_confidence: z.number().int().min(1).max(5).default(4),
  observation_window_days: z.number().int().min(1).max(90).default(7),
}

// ============================================================================
// MCP Server 创建
// ============================================================================

export function createCrabMemoryServer(
  deps: CrabMemoryDeps,
  ctx: MemoryTaskContext,
): McpServer {
  const { rpcClient, moduleId, getMemoryPort } = deps

  const server = createMcpServer({ name: 'crab-memory', version: '1.0.0' })

  server.registerTool(
        'store_memory',
        {
          description: '将信息写入长期记忆 inbox。用户要求记住时必须使用；发现有价值的偏好、案例、模式等信息时也应主动使用。',
          inputSchema: STORE_MEMORY_SCHEMA,
        },
        async (args) => {
          try {
            const memoryPort = await getMemoryPort()
            const brief = args.brief?.trim() || deriveBriefFromContent(args.content)
            const type = args.type ?? 'fact'
            const result = await rpcClient.call(
              memoryPort,
              'quick_capture',
              {
                type,
                brief,
                content: args.content,
                author: 'agent',
                source_ref: {
                  type: ctx.sourceType ?? 'conversation',
                  task_id: ctx.taskId,
                  channel_id: ctx.channelId,
                  session_id: ctx.sessionId,
                },
                entities: [],
                tags: args.tags ?? [],
                importance_factors: importanceToFactors(args.importance),
              },
              moduleId
            ) as { id?: string; status?: string }

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  action: result.status ?? 'ok',
                  memory_id: result.id,
                  brief,
                }),
              }],
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[${moduleId}] store_memory failed:`, message)
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: message,
                }),
              }],
            }
          }
        },
      ),
  server.registerTool(
        'search_memory',
        {
          description: '搜索记忆。short_term=跨 session 事件流水账（每条自带 channel/session/task/trace 锚点）；long_term=认知知识库（事实/经验/概念）。' +
            '【short_term 用途】未知 task_id/trace_id 时回溯历史事件的入口——任何需要回答"哪一次任务/事件 / 上一次怎么处理 / 之前为什么变成这样"的问题，先调本工具（level=short_term）拿锚点，再用 find_task / get_task_progress 取详情。',
          inputSchema: SEARCH_MEMORY_SCHEMA,
        },
        async (args) => {
          try {
            const memoryPort = await getMemoryPort()
            if (args.level === 'short_term') {
              const result = await rpcClient.call(
                memoryPort, 'search_short_term',
                {
                  query: args.query, limit: args.limit,
                  min_visibility: ctx.visibility,
                  ...(ctx.scopes.length > 0 ? { accessible_scopes: ctx.scopes } : {}),
                },
                moduleId
              ) as { results: Array<{ id: string; content: string; event_time: string; topic?: string }> }
              return { content: [{ type: 'text' as const, text: JSON.stringify({ results: result.results }) }] }
            }
            const result = await rpcClient.call(
              memoryPort, 'search_long_term',
              {
                query: args.query, k: args.limit, include: 'brief',
                min_visibility: ctx.visibility,
                ...(ctx.scopes.length > 0 ? { accessible_scopes: ctx.scopes } : {}),
                ...(ctx.taskId ? { task_id: ctx.taskId } : {}),
              },
              moduleId
            ) as { results: Array<{ id: string; type: string; status: string; brief: string; tags?: string[]; maturity?: string; invalidated?: boolean }> }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ results: result.results }) }],
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }] }
          }
        },
      ),
  server.registerTool(
        'get_memory_detail',
        {
          description: '获取某条长期记忆的详细内容。先用 search_memory 找到记忆 ID，再用此工具查看详情。',
          inputSchema: GET_MEMORY_DETAIL_SCHEMA,
        },
        async (args) => {
          try {
            const memoryPort = await getMemoryPort()
            const result = await rpcClient.call(
              memoryPort, 'get_memory',
              { id: args.memory_id, include: args.include },
              moduleId
            ) as { id: string; type: string; status: string; brief: string; body?: string; frontmatter?: Record<string, unknown> }
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }] }
          }
        },
  )

  // ============================================================================
  // 反思级原生 RPC 工具组
  // ============================================================================
  // 这一组工具直接透传到 Memory 后端 RPC，工具名与 RPC 一一对应，
  // 供 daily-reflection / memory-curate 等内置 SKILL 在反思 / 整理流程中精细操作。
  // 与 A 组 Worker 简化工具的区别：参数完整、字段精细可控、不做隐式推断。
  // 详见 protocol-memory.md。

  // 透传 helper：统一错误返回格式
  const callRpc = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
    try {
      const memoryPort = await getMemoryPort()
      const result = await rpcClient.call(memoryPort, method, params, moduleId)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${moduleId}] crab-memory ${method} failed:`, message)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
      }
    }
  }

  /** 从当前 ctx 推断场景（普通群聊 / 非 master 私聊使用） */
  function inferSceneFromCtx(): SceneArg | null {
    if (ctx.sessionType === 'group' && ctx.channelId && ctx.sessionId) {
      return { type: 'group_session', channel_id: ctx.channelId, session_id: ctx.sessionId }
    }
    if (ctx.sessionType === 'private' && ctx.senderFriendId) {
      return { type: 'friend', friend_id: ctx.senderFriendId }
    }
    return null
  }

  function cannotInferSceneResp() {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        success: false,
        error: '无法推断当前场景（缺少 channel_id/session_id 或 friend_id）',
      }) }],
    }
  }

  server.registerTool(
    'quick_capture',
    {
      description: '把一条候选记忆写入 inbox（待审）。反思流程提炼经验时使用，与 store_memory 相比字段更精细可控。',
      inputSchema: QUICK_CAPTURE_SCHEMA,
    },
    async (args) => callRpc('quick_capture', args as Record<string, unknown>),
  )

  server.registerTool(
    'search_long_term',
    {
      description: '在长期记忆中按语义/关键词搜索，支持按 type、status、tags 等过滤。反思流程使用此工具按 status: "inbox" 拉候选。',
      inputSchema: SEARCH_LONG_TERM_SCHEMA,
    },
    async (args) => callRpc('search_long_term', args as Record<string, unknown>),
  )

  server.registerTool(
    'update_long_term',
    {
      description: '更新一条长期记忆的字段。支持的 patch 字段：brief / tags / entities / maturity / importance_factors / invalidated_by / lesson_meta / observation / body / content_confidence_increment / use_count_increment / observation_outcome。',
      inputSchema: UPDATE_LONG_TERM_SCHEMA,
    },
    async (args) => callRpc('update_long_term', args as Record<string, unknown>),
  )

  server.registerTool(
    'delete_memory',
    {
      description: '把一条长期记忆软删除到 trash（30 天后由 maintenance 物理清理；期间可 restore_memory 恢复）。',
      inputSchema: DELETE_MEMORY_SCHEMA,
    },
    async (args) => callRpc('delete_memory', args as Record<string, unknown>),
  )

  server.registerTool(
    'list_recent',
    {
      description: '列出最近 N 天写入的长期记忆（按 ingestion_time 倒序）。反思流程做"今日新增"扫描时使用。',
      inputSchema: LIST_RECENT_SCHEMA,
    },
    async (args) => callRpc('list_recent', args as Record<string, unknown>),
  )

  server.registerTool(
    'list_entries',
    {
      description: '列出长期记忆条目（按 type/status/tags 过滤、分页）。全量重建 / 批量建链时遍历 confirmed 用。',
      inputSchema: LIST_ENTRIES_SCHEMA,
    },
    async (args) => callRpc('list_entries', args as Record<string, unknown>),
  )

  server.registerTool(
    'set_memory_links',
    {
      description: '为某条记忆设置关联链接（relation ∈ related/refines/depends_on/part_of）。反思批量建链用。',
      inputSchema: SET_MEMORY_LINKS_SCHEMA,
    },
    async (args) => callRpc('update_long_term', {
      id: (args as { id: string }).id,
      patch: { links: (args as { links: unknown }).links },
    }),
  )

  server.registerTool(
    'run_maintenance',
    {
      description: '触发记忆维护任务。scope=all 会依次跑 observation_check（按 pass/fail 净值判定观察期到期项）/ stale_aging（180 天未访问的 fact 标 stale）/ trash_cleanup（30 天回收站）。每天凌晨 04:00 已有内置 schedule 自动跑一次，此处用于反思末尾兜底或手动触发。',
      inputSchema: RUN_MAINTENANCE_SCHEMA,
    },
    async (args) => callRpc('run_maintenance', args as Record<string, unknown>),
  )

  server.registerTool(
    'get_stats',
    {
      description: '获取记忆模块统计：短期 / 长期条目数、token 估算等。Evolution mode 自评判断时使用。',
      inputSchema: {},
    },
    async () => callRpc('get_stats', {}),
  )

  server.registerTool(
    'get_evolution_mode',
    {
      description: '查询当前演化模式：balanced / innovate / harden / repair-only。',
      inputSchema: {},
    },
    async () => callRpc('get_evolution_mode', {}),
  )

  server.registerTool(
    'set_evolution_mode',
    {
      description: '切换演化模式。balanced=默认；innovate=低错误率时偏向新知识；harden=大量 case 待整理时偏向抽象 rule；repair-only=高错误率时只修不增。',
      inputSchema: SET_EVOLUTION_MODE_SCHEMA,
    },
    async (args) => callRpc('set_evolution_mode', args as Record<string, unknown>),
  )

  // ========================================================================
  // 场景画像 RPC（v0.3.0 起按 ctx.isMasterPrivate 分叉）
  //
  // - master 私聊 ctx：scene 必填，可读/写/删任意场景画像（运维通道）
  // - 其他 ctx：scene 参数不暴露，强制从 ctx 推断（保证 LLM 不会选错场景）
  // ========================================================================

  async function setSceneProfileImpl(
    scene: SceneArg,
    content: string,
    sourceMemoryIds: string[] | undefined,
    explicitLabel: string | undefined,
  ) {
    const memoryPort = await getMemoryPort()
    let label = explicitLabel
    if (!label) {
      label = await resolveSceneAnchorLabel({ rpcClient, memoryPort, moduleId, scene })
    }
    const now = new Date().toISOString()
    const result = await rpcClient.call<
      Record<string, unknown>,
      { profile: unknown }
    >(
      memoryPort,
      'upsert_scene_profile',
      {
        scene, label, content,
        ...(sourceMemoryIds ? { source_memory_ids: sourceMemoryIds } : {}),
        created_at: now, updated_at: now, last_declared_at: now,
      },
      moduleId,
    )
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true, profile: result.profile }) }],
    }
  }

  function setSceneProfileErrorResp(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[${moduleId}] set_scene_profile failed:`, message)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
    }
  }

  if (ctx.isMasterPrivate) {
    // ───── master 私聊：scene 必填，可操作任意场景 ─────
    server.registerTool(
      'get_scene_profile',
      {
        description: '【master 通道】取任意场景的画像。scene 必填——按 friend_id 或 (channel_id, session_id) 定位。',
        inputSchema: SCENE_ONLY_SCHEMA,
      },
      async (args) => callRpc('get_scene_profile', args as Record<string, unknown>),
    )

    server.registerTool(
      'set_scene_profile',
      {
        description:
          '【master 通道】写入或覆盖任意场景的画像（覆盖式写入，非 patch）。' +
          'scene 必填——明确指定要写哪个场景（friend / group_session）。' +
          '【关键】这是覆盖式写入；当前场景的画像已在你 prompt 顶部，覆盖前请基于现状合并。' +
          '【边界】跨场景通用偏好不要写到本工具——走 store_memory。',
        inputSchema: SET_SCENE_PROFILE_MASTER_SCHEMA,
      },
      async (args) => {
        try {
          return await setSceneProfileImpl(args.scene, args.content, args.source_memory_ids, args.label)
        } catch (error) {
          return setSceneProfileErrorResp(error)
        }
      },
    )

    server.registerTool(
      'delete_scene_profile',
      {
        description: '【master 通道】删除任意场景的画像。仅在画像已被新证据完全推翻、且无替代时使用。',
        inputSchema: SCENE_ONLY_SCHEMA,
      },
      async (args) => callRpc('delete_scene_profile', args as Record<string, unknown>),
    )
  } else {
    // ───── 普通群聊 / 非 master 私聊：scene 不暴露，强制 ctx 推断 ─────
    server.registerTool(
      'get_scene_profile',
      {
        description: '取当前对话场景的画像（群聊 / 好友各一份）。无需也无法指定场景——当前对话即目标。返回 null 表示当前场景尚无画像。',
        inputSchema: {},
      },
      async () => {
        const scene = inferSceneFromCtx()
        if (!scene) return cannotInferSceneResp()
        return callRpc('get_scene_profile', { scene })
      },
    )

    server.registerTool(
      'set_scene_profile',
      {
        description:
          '写入或覆盖当前对话场景的画像。' +
          '【关键】这是覆盖式写入，不是 patch——当前场景画像已在你 prompt 顶部，覆盖前请基于现状合并。' +
          '【边界】跨多个场景都适用的用户偏好不要写到本工具——走 store_memory。' +
          '操作类指令（"修改 X 配置 / 调整 Y schedule"）不要写到本工具——走对应 admin/CLI 操作。',
        inputSchema: SET_SCENE_PROFILE_SCHEMA,
      },
      async (args) => {
        try {
          const scene = inferSceneFromCtx()
          if (!scene) return cannotInferSceneResp()
          return await setSceneProfileImpl(scene, args.content, args.source_memory_ids, undefined)
        } catch (error) {
          return setSceneProfileErrorResp(error)
        }
      },
    )

    server.registerTool(
      'delete_scene_profile',
      {
        description: '清空当前对话场景的画像。仅在画像已被新证据完全推翻、且无替代时使用。',
        inputSchema: {},
      },
      async () => {
        const scene = inferSceneFromCtx()
        if (!scene) return cannotInferSceneResp()
        return callRpc('delete_scene_profile', { scene })
      },
    )
  }

  server.registerTool(
    'promote_to_rule',
    {
      description: 'Case→Rule 自动晋升。在凑齐 ≥3 条同 scenario 的 case 后，把 LLM 抽象出的 rule 文本直接写入 confirmed/lesson/，maturity=rule，进 7 天观察期。无人工 confirm。',
      inputSchema: PROMOTE_TO_RULE_SCHEMA,
    },
    async (args) => callRpc('promote_to_rule', args as Record<string, unknown>),
  )

  return server
}
