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
import type { ToolDefinition } from '../../engine/index.js'

export interface CrabotInfoToolsDeps {
  /** 调 admin RPC 的入口(经 RpcClient 调 admin,方法名对应 admin `registerMethod` 注册的方法) */
  readonly callAdmin: <P, R>(method: string, params: P) => Promise<R>
  /** 返回已通过 authenticated pull 安装的本地 runtime config；不得为摘要再次读取 secret RPC。 */
  readonly getRuntimeConfigSummary?: () => unknown
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
  readonly pagination: { readonly total_items: number }
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

export function buildCrabotInfoTools(deps: CrabotInfoToolsDeps): ToolDefinition[] {
  const { callAdmin } = deps

  // --- get_system_status ---
  // 组合来源:admin RPC `get_task_stats`(任务积压快照) + `list_agent_instances` /
  // `list_channel_instances` 的 pagination.total_items(实例数量)。admin 没有现成的
  // "系统整体状态" RPC,这里只取数量级摘要;完整拓扑详情见 get_deployment_info。
  const getSystemStatus = defineTool({
    name: 'get_system_status',
    description:
      '查询 crabot 系统整体运行状态摘要:worker 任务积压情况(按 status/priority 计数)、' +
      '已配置的 agent 实例数与 channel 实例数。用于回答"系统现在忙不忙/有多少任务在跑"一类问题。',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    call: async () => {
      try {
        const [taskStats, agentInstances, channelInstances] = await Promise.all([
          callAdmin<Record<string, never>, unknown>('get_task_stats', {}),
          callAdmin<typeof FULL_PAGE, PaginatedResult<unknown>>('list_agent_instances', FULL_PAGE),
          callAdmin<typeof FULL_PAGE, PaginatedResult<unknown>>('list_channel_instances', FULL_PAGE),
        ])
        return ok({
          task_stats: taskStats,
          agent_instance_count: agentInstances.pagination.total_items,
          channel_instance_count: channelInstances.pagination.total_items,
        })
      } catch (error) {
        return fail(error)
      }
    },
  })

  // --- get_deployment_info ---
  // 组合来源:admin RPC `list_agent_instances` + `list_channel_instances`(拓扑详情:
  // 实例 id/name/是否已注册到 Module Manager/端口/平台)。admin 没有现成的 "部署信息" RPC,
  // 这里给出详细条目;数量级摘要见 get_system_status。
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
        const [agentInstances, channelInstances] = await Promise.all([
          callAdmin<typeof FULL_PAGE, PaginatedResult<AgentInstanceLite>>('list_agent_instances', FULL_PAGE),
          callAdmin<typeof FULL_PAGE, PaginatedResult<ChannelInstanceLite>>('list_channel_instances', FULL_PAGE),
        ])
        return ok({
          agent_instances: agentInstances.items,
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
        page: { type: 'number', description: '页码，默认 1' },
        page_size: { type: 'number', description: '每页数量，默认 20，最大 100' },
      },
    },
    isReadOnly: true,
    call: async (input) => {
      try {
        const { enabled, page, page_size } = input as {
          enabled?: boolean
          page?: number
          page_size?: number
        }
        const params = {
          ...(enabled !== undefined ? { filter: { enabled } } : {}),
          page: page ?? 1,
          page_size: page_size ?? 20,
        }
        const result = await callAdmin<typeof params, unknown>('list_schedules', params)
        return ok(result)
      } catch (error) {
        return fail(error)
      }
    },
  })

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
      '列出 crabot 已安装的能力清单:可用的 agent 实现(id/引擎/支持角色)、可用的 channel 平台' +
      '类型(id/平台/版本)。用于回答"你都会什么/支持接哪些渠道"一类问题。',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    call: async () => {
      try {
        const [agentImpls, channelImpls] = await Promise.all([
          callAdmin<typeof FULL_PAGE, PaginatedResult<AgentImplementationLite>>('list_agent_implementations', FULL_PAGE),
          callAdmin<typeof FULL_PAGE, PaginatedResult<ChannelImplementationLite>>('list_channel_implementations', FULL_PAGE),
        ])
        return ok({
          agent_implementations: agentImpls.items,
          channel_implementations: channelImpls.items,
        })
      } catch (error) {
        return fail(error)
      }
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
    getSystemStatus,
    getDeploymentInfo,
    listSchedules,
    getConfigSummary,
    listCapabilities,
    getFriendPermissions,
  ]
}
