/** Effective user authorization; retired keys are storage compatibility only. */
export const EFFECTIVE_TOOL_CATEGORIES = ['memory', 'messaging', 'file_io', 'shell', 'mcp_skill', 'desktop'] as const
export const RETIRED_TOOL_CATEGORIES = ['task', 'browser', 'remote_exec'] as const
export type EffectiveToolCategory = typeof EFFECTIVE_TOOL_CATEGORIES[number]
export type RetiredToolCategory = typeof RETIRED_TOOL_CATEGORIES[number]
export type EffectiveToolAccessConfig = Record<EffectiveToolCategory, boolean>
export type ToolAccessUpdate = EffectiveToolAccessConfig & Partial<Record<RetiredToolCategory, boolean>>

export const TOOL_ENTRY_EXPLANATIONS: Record<EffectiveToolCategory, string> = {
  memory: '记忆工具入口；配置范围不代表后端数据过滤已核实。',
  messaging: '扩展消息、渠道查询和跨目标投递；当前可信对话的正常答复保留。',
  file_io: '内置文件与项目文档，受 storage 真实目录和读写级别限制；未配置范围不允许访问。',
  shell: '以运行账号执行主机命令，可访问文件、网络和远程机器，不受内置文件范围隔离。',
  mcp_skill: '已启用的外部 MCP 与用户 Skill；服务操作不受内置文件范围隔离，Skill 不增加工具权限。',
  desktop: '仅可信 Master 私聊的桌面控制；子 Agent 不继承。',
}

export function effectiveToolAccess(value: Partial<Record<EffectiveToolCategory | RetiredToolCategory, boolean>>): EffectiveToolAccessConfig {
  return Object.fromEntries(EFFECTIVE_TOOL_CATEGORIES.map(key => [key, value[key] === true])) as EffectiveToolAccessConfig
}

/** API updates retain legacy values; importing historical storage remains separate. */
export function normalizeToolAccessUpdate(
  incoming: object, previous?: Partial<Record<EffectiveToolCategory | RetiredToolCategory, boolean>>, partial = false,
): Record<EffectiveToolCategory | RetiredToolCategory, boolean> {
  const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: 'INVALID_PARAMS' }) }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) invalid('tool_access 必须是对象')
  for (const [key, value] of Object.entries(incoming)) {
    if (![...EFFECTIVE_TOOL_CATEGORIES, ...RETIRED_TOOL_CATEGORIES].includes(key as EffectiveToolCategory)) invalid(`未知权限字段 ${key}`)
    if (typeof value !== 'boolean') invalid(`权限字段 ${key} 必须是 boolean`)
  }
  const values = incoming as Record<string, unknown>
  const result: Record<string, boolean> = {}
  for (const key of EFFECTIVE_TOOL_CATEGORIES) {
    if (values[key] !== undefined) result[key] = values[key] as boolean
    else if (!partial) invalid(`缺少有效权限字段 ${key}`)
  }
  for (const key of RETIRED_TOOL_CATEGORIES) {
    const old = previous?.[key] ?? false
    if (values[key] !== undefined && values[key] !== old) invalid(`权限字段 ${key} 已退役，不允许修改`)
    if (!partial || previous?.[key] !== undefined) result[key] = old
  }
  return result as Record<EffectiveToolCategory | RetiredToolCategory, boolean>
}
