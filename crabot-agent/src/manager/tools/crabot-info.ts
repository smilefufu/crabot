/**
 * crabot-info 只读方法集 —— protocol-agent-v3.md §4.3。
 *
 * manager loop 的 self-awareness 工具面:六个只读方法,回答"你部署在哪 / 都会什么 /
 * 有哪些定时任务 / 某人权限如何"一类问题。**无写方法**——对 crabot 的写操作一律派 worker 执行。
 *
 * 不走 `mcp-tool-bridge`(它把所有工具硬编码 `isReadOnly: false`),直接用 `defineTool`
 * 构造 `ToolDefinition`,六个工具均标 `isReadOnly: true`。
 *
 * admin 侧只暴露 RPC bus(`registerMethod` 注册的方法,经 `deps.callAdmin` 调用)——
 * `crabot-admin/src/index.ts`。provider / mcp / skill / 全局 model config / undo 等域目前
 * 只有 HTTP REST 入口(`/api/model-providers` 等),没有对应 RPC,manager 侧够不着,因此
 * 下面六个方法里有三个是直接对应既有 RPC,三个是拿现成的 RPC 组合出来的(注释逐一标注来源)。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §4.3
 */

import { defineTool } from '../../engine/index.js'
import type { ToolCallContext, ToolDefinition } from '../../engine/index.js'
import type { ResolvedPermissions } from '../../types.js'
import type { MasterAuthorization } from '../principal.js'

interface ManagerScheduleTarget {
  readonly channel_id: string
  readonly session_id: string
  readonly type: 'private' | 'group'
}

interface ManagerScheduleView {
  readonly id: string
  readonly is_builtin?: boolean
  readonly creator_friend_id?: string
  readonly target_session?: ManagerScheduleTarget
  readonly task_template?: unknown
  readonly script?: {
    readonly source_sha256: string
    readonly timeout_seconds: number
    readonly deliver_result: boolean
    readonly source?: string
  }
  readonly [key: string]: unknown
}

export interface ManagerScheduleToolsContext {
  readonly targetSession?: ManagerScheduleTarget
  readonly creatorFriendId?: string
  readonly canCreate: boolean
  /** 每次工具调用都重新解析，不得传入 episode 权限快照。 */
  readonly resolvePermissions: () => Promise<ResolvedPermissions | null>
  /** 只由当前人类 Master 私聊 episode 捕获；scheduled/system episode 不得提供。 */
  readonly masterAuthorization?: MasterAuthorization
  readonly validateMasterAuthorization?: (auth: MasterAuthorization) => Promise<boolean>
}

export interface CrabotInfoToolsDeps {
  /** 调 admin RPC 的入口(经 RpcClient 调 admin,方法名对应 admin `registerMethod` 注册的方法) */
  readonly callAdmin: <P, R>(method: string, params: P) => Promise<R>
  /** 返回已通过 authenticated pull 安装的本地 runtime config；不得为摘要再次读取 secret RPC。 */
  readonly getRuntimeConfigSummary?: () => unknown
  /** P6-D：worker implementation registry snapshot（本进程内，与 spawn gate 同一真相）。 */
  readonly workerImplSnapshot?: () => {
    default_impl: string
    statuses: Array<{ impl: string; ready: boolean; enabled: boolean; capabilities?: unknown }>
  }
  readonly schedule?: ManagerScheduleToolsContext
}

// --- 掩码:get_config_summary 的责任,防御性做,不依赖 admin 端已掩码 ---

// `auth` 单独加 \b：不加边界会把 `auth_config` 这类"字段名里带 auth 但其实是个混合
// 容器(既有 authorization 也有 endpoint/timeout 等中性字段)"的键也当成整体敏感键，
// 触发下面「整体掩掉不再递归」的兜底逻辑，误伤 auth_config.endpoint 这类中性字段
// (会破坏既有掩码用例的选择性掩码预期)。加 \b 后 `auth`/`Auth` 精确匹配，
// `auth_config` 不再在外层被整体掩码，内部的 authorization/auth/bearer/... 仍会被各自的
// 键名命中掩掉——不依赖外层是否命中。
const SENSITIVE_KEY_PATTERN =
  /key|token|secret|password|credential|authorization|\bauth\b|bearer|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|passwd/i

/** 容器类键名：其内部所有字符串值一律掩码(不论值的键名)。`args` 是 stdio MCP server 的命令行
 *  参数数组，`--api-key sk-xxx` 这类形态常见，元素一律掩(兜底；mcp_servers 主要靠下面的白名单
 *  投影丢弃，这里是即使投影漏了某个来源也不至于原样泄露)。 */
const CONTAINER_KEY_PATTERN = /^(headers|env|environment|args)$/i

/** url 类键名：兜底剥离 query string 与 userinfo 后再输出(见 sanitizeUrlValue)。 */
const URL_KEY_PATTERN = /^url$/i

/** mcp_servers 数组键名(admin `handleGetAgentConfig` / MCPServerConfig 的顶层字段)。 */
const MCP_SERVERS_KEY_PATTERN = /^mcp_servers$/i

/**
 * mcp_servers 白名单投影：只保留 manager 回答"配了哪些 MCP"用得到的展示字段，
 * 显式丢弃 command/args/env/url/headers 等启动参数/凭证原文。
 *
 * 设计取舍：选白名单而不是给 command/args/env/url/headers 逐个字段打掩码补丁——
 * stdio server 常见 `--api-key sk-xxx` 这类凭证直接拼进 args，url 常见
 * `?api_key=...` 查询参数或 `user:pass@host` userinfo，黑名单式掩码总要猜"这个字段
 * 会不会装凭证"，猜漏一个就多一个泄露口子；白名单则是"默认丢弃，明确需要才留"，
 * 上游 MCPServerConfig 以后新增字段，默认就是丢弃，不会重新开口子。
 */
const MCP_SERVER_ALLOWED_KEYS = ['id', 'name', 'transport', 'description'] as const

function projectMcpServer(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    // 非预期形状，防御性兜底：不是对象就没有白名单字段可投影，交给上层继续走通用掩码
    return maskSensitive(entry)
  }
  const src = entry as Record<string, unknown>
  const projected: Record<string, unknown> = {}
  for (const key of MCP_SERVER_ALLOWED_KEYS) {
    if (key in src) projected[key] = src[key]
  }
  return projected
}

/**
 * url 类字段兜底掩码：剥掉 query string(`?api_key=...`)与 userinfo(`user:pass@host`)，
 * 保留 scheme+host+path 便于诊断。不是合法 URL 时无法安全界定边界，整体掩掉更保守。
 */
function sanitizeUrlValue(raw: string): string {
  try {
    const u = new URL(raw)
    u.search = ''
    u.hash = ''
    u.username = ''
    u.password = ''
    return u.toString()
  } catch {
    return '***'
  }
}

/**
 * 递归掩码:
 * 1. 键名命中 MCP_SERVERS_KEY_PATTERN 且值是数组：逐项走白名单投影(见 projectMcpServer)
 * 2. 键名命中 SENSITIVE_KEY_PATTERN 的字段：整体掩掉——字符串直接替换为 '***'，对象/数组
 *    走容器整体掩码(不再递归下去逐键判断，避免"外层键敏感、内层键中性"漏网，例如
 *    `auth: { value: 'Bearer real' }`)
 * 3. 键名命中 CONTAINER_KEY_PATTERN 的容器内，所有字符串值替换为 '***'(非字符串值递归)
 * 4. 键名命中 URL_KEY_PATTERN 的字符串值：剥 query string 与 userinfo
 * 5. 其余值递归处理
 */
function maskSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskSensitive)
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (MCP_SERVERS_KEY_PATTERN.test(key) && Array.isArray(v)) {
        result[key] = v.map(projectMcpServer)
      }
      // 如果键名命中敏感模式：整体掩掉，不论值是标量还是对象/数组
      else if (SENSITIVE_KEY_PATTERN.test(key)) {
        if (typeof v === 'string') {
          result[key] = '***'
        } else if (v !== null && typeof v === 'object') {
          result[key] = maskContainer(v)
        } else {
          result[key] = '***'
        }
      }
      // 如果键名是容器类，内部所有字符串值掩码
      else if (CONTAINER_KEY_PATTERN.test(key)) {
        result[key] = maskContainer(v)
      }
      // url 类字段：剥 query string 与 userinfo
      else if (URL_KEY_PATTERN.test(key) && typeof v === 'string') {
        result[key] = sanitizeUrlValue(v)
      }
      // 其余递归
      else {
        result[key] = maskSensitive(v)
      }
    }
    return result
  }
  return value
}

/** 对容器内所有字符串值掩码，非字符串值递归 */
function maskContainer(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskContainer)
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      // 容器内：字符串值全掩，非字符串值递归
      if (typeof v === 'string') {
        result[key] = '***'
      } else {
        result[key] = maskContainer(v)
      }
    }
    return result
  }
  // 字符串值掩码
  if (typeof value === 'string') {
    return '***'
  }
  return value
}

// --- 分页 list RPC 的最小共享形状(admin PaginatedResult<T>) ---

interface PaginatedResult<T> {
  readonly items: readonly T[]
  readonly pagination: {
    readonly page: number
    readonly page_size: number
    readonly total_items: number
    readonly total_pages: number
  }
}

/** manager 侧只关心「查全量」,固定拉大页,避免默认 page_size=20 截断 */
const FULL_PAGE = { page: 1, page_size: 100 }

function ok(data: unknown): { output: string; isError: boolean } {
  return { output: JSON.stringify(data), isError: false }
}

function fail(error: unknown): { output: string; isError: boolean } {
  const msg = error instanceof Error ? error.message : String(error)
  return { output: msg, isError: true }
}

const LEGACY_SCHEDULE_TARGET: ManagerScheduleTarget = {
  channel_id: 'admin-web',
  session_id: 'system-tasks',
  type: 'private',
}

function hasScheduleAccess(actual: 'none' | 'read' | 'write', required: 'read' | 'write'): boolean {
  return actual === 'write' || (required === 'read' && actual === 'read')
}

function sameScheduleTarget(a: ManagerScheduleTarget, b: ManagerScheduleTarget): boolean {
  return a.channel_id === b.channel_id && a.session_id === b.session_id && a.type === b.type
}

function scheduleVisible(
  schedule: ManagerScheduleView,
  context: ManagerScheduleToolsContext,
  masterAuthorized: boolean,
): boolean {
  if (masterAuthorized) return true
  if (!context.targetSession) return false
  const target = schedule.target_session ?? LEGACY_SCHEDULE_TARGET
  if (!sameScheduleTarget(target, context.targetSession)) return false
  return target.type === 'group' || schedule.creator_friend_id === context.creatorFriendId
}

function contentKind(schedule: ManagerScheduleView): 'instruction' | 'script' {
  return schedule.script ? 'script' : 'instruction'
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
}

function rejectInjectedScheduleFields(input: Record<string, unknown>): void {
  for (const key of ['target_session', 'creator_friend_id', 'is_builtin', 'source_sha256']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) throw new Error(`Schedule 工具不接受 ${key}`)
  }
}

function managerInstruction(value: unknown): {
  title: string
  description?: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  input?: Record<string, unknown>
  tags: string[]
} {
  const instruction = asRecord(value)
  if (typeof instruction.title !== 'string' || !instruction.title.trim()) {
    throw new Error('instruction.title 必填且为非空字符串')
  }
  const priorities = new Set(['low', 'normal', 'high', 'urgent'])
  if (instruction.priority !== undefined && !priorities.has(String(instruction.priority))) {
    throw new Error('instruction.priority 非法')
  }
  if (instruction.tags !== undefined && (!Array.isArray(instruction.tags)
    || !instruction.tags.every((tag) => typeof tag === 'string'))) throw new Error('instruction.tags 必须是字符串数组')
  if (instruction.input !== undefined && (typeof instruction.input !== 'object'
    || instruction.input === null || Array.isArray(instruction.input))) throw new Error('instruction.input 必须是对象')
  return {
    title: instruction.title.trim(),
    ...(typeof instruction.description === 'string' ? { description: instruction.description } : {}),
    priority: (instruction.priority ?? 'normal') as 'low' | 'normal' | 'high' | 'urgent',
    ...(instruction.input ? { input: instruction.input as Record<string, unknown> } : {}),
    tags: instruction.tags ? [...instruction.tags as string[]] : [],
  }
}

function managerScript(value: unknown): { source: string; timeout_seconds?: number; deliver_result?: boolean } {
  const script = asRecord(value)
  if (Object.prototype.hasOwnProperty.call(script, 'source_sha256')) {
    throw new Error('script 不接受 source_sha256')
  }
  if (typeof script.source !== 'string') throw new Error('script.source 必填且为字符串')
  return {
    source: script.source,
    ...(script.timeout_seconds === undefined ? {} : { timeout_seconds: script.timeout_seconds as number }),
    ...(script.deliver_result === undefined ? {} : { deliver_result: script.deliver_result as boolean }),
  }
}

export function buildCrabotInfoTools(deps: CrabotInfoToolsDeps): ToolDefinition[] {
  const { callAdmin } = deps
  const scheduleContext = deps.schedule

  const authorizeSchedule = async (
    required: 'read' | 'write',
    requireShell = false,
  ): Promise<boolean> => {
    if (!scheduleContext) throw new Error('Schedule context is unavailable')
    const permissions = await scheduleContext.resolvePermissions()
    if (!permissions || !hasScheduleAccess(permissions.cli_access.schedule, required)
      || (requireShell && !permissions.tool_access.shell)) throw new Error('Schedule access denied')
    if (!scheduleContext.masterAuthorization || !scheduleContext.validateMasterAuthorization) return false
    try {
      return await scheduleContext.validateMasterAuthorization(scheduleContext.masterAuthorization)
    } catch {
      return false
    }
  }

  const getAuthorizedSchedule = async (scheduleId: string, masterAuthorized: boolean): Promise<ManagerScheduleView> => {
    if (!scheduleContext) throw new Error('Schedule context is unavailable')
    const result = await callAdmin<{ schedule_id: string }, { schedule: ManagerScheduleView }>(
      'get_schedule',
      { schedule_id: scheduleId },
    )
    if (!scheduleVisible(result.schedule, scheduleContext, masterAuthorized)) throw new Error('Schedule not found')
    return result.schedule
  }

  // --- inspect_crabot views ---
  // P6-D：Agent 侧唯一是 exact core `crabot-agent`（静态身份，不再调 list_agent_instances）；
  // channel 实例仍走 admin RPC。三个旧入口共用一个带 view 的可调用工具，避免模型在同一
  // 自省语义下重复选择工具；各 view 的数据源、脱敏和错误语义保持不变。
  interface AgentInstanceLite {
    readonly id: string
    readonly name: string
    readonly implementation_id: string
    readonly module_registered: boolean
    readonly module_port?: number
  }
  interface ChannelInstanceLite {
    readonly id: string
    readonly name: string
    readonly platform: string
    readonly module_registered: boolean
  }
  const getDeploymentInfo = defineTool({
    name: 'get_deployment_info',
    description:
      '查询 crabot 部署拓扑:当前配置了哪些 agent 实例(id/name/实现/是否已注册到 Module ' +
      'Manager/端口)、哪些 channel 实例(id/name/平台)。用于回答"你部署在哪/接了哪些渠道"一类问题。',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    call: async () => {
      try {
        const channelInstances = await callAdmin<typeof FULL_PAGE, PaginatedResult<ChannelInstanceLite>>('list_channel_instances', FULL_PAGE)
        return ok({
          agent_instances: [{ id: 'crabot-agent', name: 'Crabot Agent', implementation_id: 'crabot-agent', module_registered: true }],
          channel_instances: channelInstances.items,
        })
      } catch (error) {
        return fail(error)
      }
    },
  })

  // --- list_schedules ---
  // 直接对应 admin RPC `list_schedules`(registerMethod 原样注册),参数/结果原样透传。
  const listSchedules = defineTool({
    name: 'list_schedules',
    description:
      '列出已配置的定时任务(schedule):名称、启用状态、触发器(cron/interval/once)、上次/下次' +
      '触发时间。用于回答"有哪些定时任务/下次什么时候跑"一类问题。可选按 enabled 过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: '只看启用(true)或禁用(false)的 schedule；缺省不过滤' },
        trigger_type: { type: 'string', enum: ['cron', 'interval', 'once'], description: '按触发类型过滤' },
        page: { type: 'number', description: '页码，默认 1' },
        page_size: { type: 'number', description: '每页数量，默认 20，最大 100' },
      },
    },
    isReadOnly: true,
    call: async (input) => {
      try {
        const { enabled, trigger_type, page, page_size } = input as {
          enabled?: boolean
          trigger_type?: 'cron' | 'interval' | 'once'
          page?: number
          page_size?: number
        }
        const requestedPage = page ?? 1
        const requestedPageSize = page_size ?? 20
        const params = {
          ...(enabled !== undefined || trigger_type !== undefined
            ? { filter: { ...(enabled !== undefined ? { enabled } : {}), ...(trigger_type ? { trigger_type } : {}) } }
            : {}),
          page: requestedPage,
          page_size: requestedPageSize,
        }
        if (!scheduleContext) return ok(await callAdmin<typeof params, unknown>('list_schedules', params))
        const masterAuthorized = await authorizeSchedule('read')
        const query = { ...params, page: 1, page_size: 100 }
        const first = await callAdmin<typeof query, PaginatedResult<ManagerScheduleView>>('list_schedules', query)
        const all = [...first.items]
        for (let currentPage = 2; currentPage <= first.pagination.total_pages; currentPage += 1) {
          const result = await callAdmin<typeof query, PaginatedResult<ManagerScheduleView>>(
            'list_schedules', { ...query, page: currentPage },
          )
          all.push(...result.items)
        }
        const visible = all.filter((schedule) => scheduleVisible(schedule, scheduleContext, masterAuthorized))
        const offset = (requestedPage - 1) * requestedPageSize
        return ok({
          items: visible.slice(offset, offset + requestedPageSize),
          pagination: {
            page: requestedPage,
            page_size: requestedPageSize,
            total_items: visible.length,
            total_pages: Math.ceil(visible.length / requestedPageSize),
          },
        })
      } catch (error) {
        return fail(error)
      }
    },
  })

  const triggerSchema = {
    oneOf: [
      {
        type: 'object', additionalProperties: false,
        properties: { type: { type: 'string', enum: ['cron'] }, expression: { type: 'string' }, timezone: { type: 'string' } },
        required: ['type', 'expression'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: { type: { type: 'string', enum: ['interval'] }, seconds: { type: 'number' } },
        required: ['type', 'seconds'],
      },
      {
        type: 'object', additionalProperties: false,
        properties: { type: { type: 'string', enum: ['once'] }, execute_at: { type: 'string' } },
        required: ['type', 'execute_at'],
      },
    ],
  }
  const instructionSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      input: { type: 'object' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['title'],
  }
  const scriptSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      source: { type: 'string' },
      timeout_seconds: { type: 'number' },
      deliver_result: { type: 'boolean' },
    },
    required: ['source'],
  }

  const createSchedule = scheduleContext ? defineTool({
    name: 'create_schedule',
    description: '为当前会话创建 instruction 或 Bash script Schedule。目标会话与创建者由系统注入。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' }, description: { type: 'string' }, enabled: { type: 'boolean' },
        trigger: triggerSchema, instruction: instructionSchema, script: scriptSchema,
      },
      required: ['name', 'trigger'],
      oneOf: [{ required: ['instruction'] }, { required: ['script'] }],
    },
    isReadOnly: false,
    call: async (rawInput) => {
      try {
        const input = asRecord(rawInput)
        rejectInjectedScheduleFields(input)
        const hasInstruction = Object.prototype.hasOwnProperty.call(input, 'instruction')
        const hasScript = Object.prototype.hasOwnProperty.call(input, 'script')
        if (hasInstruction === hasScript) throw new Error('create_schedule 必须且只能提供 instruction 或 script')
        if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('create_schedule.name 必填')
        await authorizeSchedule('write', hasScript)
        if (!scheduleContext.canCreate || !scheduleContext.targetSession || !scheduleContext.creatorFriendId) {
          throw new Error('当前 episode 没有可信的 Schedule 创建主体')
        }
        const params = {
          name: input.name.trim(),
          ...(typeof input.description === 'string' ? { description: input.description } : {}),
          ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
          trigger: input.trigger,
          ...(hasInstruction
            ? { task_template: managerInstruction(input.instruction) }
            : { script: managerScript(input.script) }),
          target_session: scheduleContext.targetSession,
          creator_friend_id: scheduleContext.creatorFriendId,
        }
        return ok(await callAdmin<typeof params, unknown>('create_schedule', params))
      } catch (error) {
        return fail(error)
      }
    },
  }) : undefined

  const getSchedule = scheduleContext ? defineTool({
    name: 'get_schedule',
    description: '查询一条当前会话可见的 Schedule；仅显式请求且具备 shell 权限时返回脚本 source。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { schedule_id: { type: 'string' }, include_script_source: { type: 'boolean' } },
      required: ['schedule_id'],
    },
    isReadOnly: true,
    call: async (rawInput) => {
      try {
        const input = asRecord(rawInput)
        const scheduleId = input.schedule_id
        if (typeof scheduleId !== 'string' || !scheduleId) throw new Error('get_schedule.schedule_id 必填')
        const includeSource = input.include_script_source === true
        const masterAuthorized = await authorizeSchedule('read', includeSource)
        await getAuthorizedSchedule(scheduleId, masterAuthorized)
        const result = includeSource
          ? await callAdmin<{ schedule_id: string; include_script_source: true }, unknown>(
              'get_schedule', { schedule_id: scheduleId, include_script_source: true },
            )
          : await callAdmin<{ schedule_id: string }, unknown>('get_schedule', { schedule_id: scheduleId })
        return ok(result)
      } catch (error) {
        return fail(error)
      }
    },
  }) : undefined

  const updateSchedule = scheduleContext ? defineTool({
    name: 'update_schedule',
    description: '修改、启用或停用一条可管理的 Schedule；提供 instruction/script 时原子替换完整内容分支。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        schedule_id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
        enabled: { type: 'boolean' }, trigger: triggerSchema,
        instruction: instructionSchema, script: scriptSchema,
      },
      required: ['schedule_id'],
      oneOf: [
        { not: { anyOf: [{ required: ['instruction'] }, { required: ['script'] }] } },
        { required: ['instruction'], not: { required: ['script'] } },
        { required: ['script'], not: { required: ['instruction'] } },
      ],
    },
    isReadOnly: false,
    call: async (rawInput) => {
      try {
        const input = asRecord(rawInput)
        rejectInjectedScheduleFields(input)
        const scheduleId = input.schedule_id
        if (typeof scheduleId !== 'string' || !scheduleId) throw new Error('update_schedule.schedule_id 必填')
        const hasInstruction = Object.prototype.hasOwnProperty.call(input, 'instruction')
        const hasScript = Object.prototype.hasOwnProperty.call(input, 'script')
        if (hasInstruction && hasScript) throw new Error('update_schedule 不能同时提供 instruction 和 script')
        const masterAuthorized = await authorizeSchedule('write')
        const schedule = await getAuthorizedSchedule(scheduleId, masterAuthorized)
        if (schedule.is_builtin) throw new Error('Builtin Schedule is read-only')
        const updateKeys = Object.keys(input).filter((key) => key !== 'schedule_id')
        const pureScriptDisable = !!schedule.script && updateKeys.length === 1 && input.enabled === false
        if ((schedule.script && !pureScriptDisable) || hasScript) await authorizeSchedule('write', true)
        const params = {
          schedule_id: scheduleId,
          expected_content_kind: contentKind(schedule),
          ...(typeof input.name === 'string' ? { name: input.name } : {}),
          ...(typeof input.description === 'string' ? { description: input.description } : {}),
          ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
          ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
          ...(hasInstruction ? { task_template: managerInstruction(input.instruction), script: null } : {}),
          ...(hasScript ? { script: managerScript(input.script), task_template: null } : {}),
        }
        return ok(await callAdmin<typeof params, unknown>('update_schedule', params))
      } catch (error) {
        return fail(error)
      }
    },
  }) : undefined

  const deleteSchedule = scheduleContext ? defineTool({
    name: 'delete_schedule',
    description: '删除一条当前主体可管理的非 builtin Schedule。删除脚本 Schedule 不要求 shell 权限。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { schedule_id: { type: 'string' } }, required: ['schedule_id'],
    },
    isReadOnly: false,
    call: async (rawInput) => {
      try {
        const scheduleId = asRecord(rawInput).schedule_id
        if (typeof scheduleId !== 'string' || !scheduleId) throw new Error('delete_schedule.schedule_id 必填')
        const masterAuthorized = await authorizeSchedule('write')
        const schedule = await getAuthorizedSchedule(scheduleId, masterAuthorized)
        if (schedule.is_builtin) throw new Error('Builtin Schedule is read-only')
        return ok(await callAdmin<{ schedule_id: string }, unknown>('delete_schedule', { schedule_id: scheduleId }))
      } catch (error) {
        return fail(error)
      }
    },
  }) : undefined

  const triggerSchedule = scheduleContext ? defineTool({
    name: 'trigger_schedule',
    description: '立即触发一条当前主体可管理的非 builtin Schedule，不改变其正常调度周期。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { schedule_id: { type: 'string' } }, required: ['schedule_id'],
    },
    isReadOnly: false,
    call: async (rawInput) => {
      try {
        const scheduleId = asRecord(rawInput).schedule_id
        if (typeof scheduleId !== 'string' || !scheduleId) throw new Error('trigger_schedule.schedule_id 必填')
        const masterAuthorized = await authorizeSchedule('write')
        const schedule = await getAuthorizedSchedule(scheduleId, masterAuthorized)
        if (schedule.is_builtin) throw new Error('Builtin Schedule is read-only')
        if (schedule.script) await authorizeSchedule('write', true)
        return ok(await callAdmin<{ schedule_id: string; expected_content_kind: 'instruction' | 'script' }, unknown>(
          'trigger_now',
          { schedule_id: scheduleId, expected_content_kind: contentKind(schedule) },
        ))
      } catch (error) {
        return fail(error)
      }
    },
  }) : undefined

  // --- get_config_summary ---
  // 只投影 Agent 已通过 authenticated startup/invalidation pull 原子安装的本地 runtime
  // config。不得用普通 Admin RPC 再调 secret-bearing get_agent_config。
  const getConfigSummary = defineTool({
    name: 'get_config_summary',
    description:
      '查询当前 agent 实例的已解析配置摘要(各 model slot 的连接信息、memory 配置等)。' +
      '敏感字段(api key/token/secret/password/credential 一类)已掩码为 "***"。' +
      '用于回答"你现在用的什么模型/配置是什么样"一类问题，不会泄露密钥原文。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    isReadOnly: true,
    call: async () => {
      try {
        if (!deps.getRuntimeConfigSummary) throw new Error('Runtime config summary is unavailable')
        return ok({ config: maskSensitive(deps.getRuntimeConfigSummary()) })
      } catch (error) {
        return fail(error)
      }
    },
  })

  // --- list_capabilities ---
  // 组合来源:admin RPC `list_agent_implementations` + `list_channel_implementations`
  // (可用的 agent 实现/引擎、可用的 channel 平台类型)。admin 没有现成的 "能力清单" RPC——
  // mcp/skill 清单只有 HTTP REST 入口(`/api/mcp-servers`、`/api/skills`),manager 的
  // RPC-only 工具面够不着，因此这里只覆盖 agent/channel 两类实现清单。
  interface AgentImplementationLite {
    readonly id: string
    readonly name: string
    readonly type: string
    readonly implementation_type: string
    readonly engine: string
    readonly supported_roles: readonly string[]
  }
  interface ChannelImplementationLite {
    readonly id: string
    readonly name: string
    readonly type: string
    readonly platform: string
    readonly version: string
  }
  const listCapabilities = defineTool({
    name: 'list_capabilities',
    description:
      '列出 crabot 已安装的能力清单:core agent（唯一内置）+ worker implementations(ready/enabled/能力)、可用的 channel 平台类型(id/平台/版本)。legacy archive 不受支持、不在此列。',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    call: async () => {
      try {
        const channelImpls = await callAdmin<typeof FULL_PAGE, PaginatedResult<ChannelImplementationLite>>('list_channel_implementations', FULL_PAGE)
        const workers = deps.workerImplSnapshot?.()
        return ok({
          // core Agent 固定能力（静态定义）；legacy archive 不作为 capability（§3.18）。
          agent_implementations: [{ id: 'crabot-agent', name: 'Crabot Core Agent', type: 'builtin', implementation_type: 'config_only', engine: 'claude-agent-sdk', supported_roles: ['front', 'worker'] }],
          worker_implementations: workers ? workers.statuses : [],
          channel_implementations: channelImpls.items,
        })
      } catch (error) {
        return fail(error)
      }
    },
  })

  const inspectCrabot = defineTool({
    name: 'inspect_crabot',
    description:
      '查询 crabot 的只读自省信息。view=deployment 查看部署拓扑，view=config 查看已脱敏运行配置，' +
      'view=capabilities 查看已安装的 Agent/Worker/Channel 能力清单。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        view: { type: 'string', enum: ['deployment', 'config', 'capabilities'] },
      },
      required: ['view'],
    },
    isReadOnly: true,
    call: async (input, context: ToolCallContext) => {
      const view = input.view
      const target = view === 'deployment'
        ? getDeploymentInfo
        : view === 'config'
          ? getConfigSummary
          : view === 'capabilities' ? listCapabilities : undefined
      if (!target) return fail(new Error('inspect_crabot.view 必须是 deployment、config 或 capabilities'))
      return target.call({}, context)
    },
  })

  // --- get_friend_permissions ---
  // 直接对应 admin RPC `get_friend_permissions`(registerMethod 原样注册),参数/结果原样透传。
  const getFriendPermissions = defineTool({
    name: 'get_friend_permissions',
    description:
      '查询某个 friend 的权限配置(模板 + session 覆盖合并后的最终生效权限:工具访问/CLI 访问/' +
      '存储/记忆作用域)。用于回答"某人权限如何/能不能做 X"一类问题。',
    inputSchema: {
      type: 'object',
      properties: {
        friend_id: { type: 'string', description: '要查询的 friend id' },
      },
      required: ['friend_id'],
    },
    isReadOnly: true,
    call: async (input) => {
      const friendId = (input as { friend_id?: string }).friend_id
      if (!friendId || typeof friendId !== 'string') {
        return { output: 'get_friend_permissions: friend_id 必填且为字符串', isError: true }
      }
      try {
        const result = await callAdmin<{ friend_id: string }, unknown>('get_friend_permissions', {
          friend_id: friendId,
        })
        return ok(result)
      } catch (error) {
        return fail(error)
      }
    },
  })

  return [
    inspectCrabot,
    ...(createSchedule && getSchedule ? [createSchedule, getSchedule] : []),
    listSchedules,
    ...(updateSchedule && deleteSchedule && triggerSchedule
      ? [updateSchedule, deleteSchedule, triggerSchedule]
      : []),
    getFriendPermissions,
  ]
}
