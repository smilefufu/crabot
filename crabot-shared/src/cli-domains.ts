/**
 * Crabot CLI 子命令分类
 *
 * 把 subcommand 字符串（如 "provider add" / "schedule list"）映射到：
 *   - domain：10 个 CLI 命令组之一（与 PermissionTemplate.cli_access 的 keys 对齐）
 *   - kind：'read' (list/show/doctor) 或 'write'（add/delete/update/restart/toggle/...）
 *
 * Hook 层用 classifyCliSubcommand 决定该命令需要 cli_access[domain] 至少 'read' 还是 'write'。
 *
 * 同时维护 REQUIRES_CONTENT_REVIEW —— 需要 LLM 内容审核的命令（仅 schedule add）。
 *
 * 注意：domain 名必须与 crabot-admin 的 CliDomain 类型严格对齐（10 个），但本模块不 import
 * admin 类型以保持 shared 独立。修改任一侧时确保两侧同步。
 */

export type CliDomain =
  | 'provider'
  | 'agent'
  | 'mcp'
  | 'skill'
  | 'schedule'
  | 'channel'
  | 'friend'
  | 'permission'
  | 'config'
  | 'undo'

export type CliKind = 'read' | 'write'

export interface CliClassification {
  readonly domain: CliDomain
  readonly kind: CliKind
}

const SUBCOMMAND_TO_CLASSIFICATION: ReadonlyMap<string, CliClassification> = new Map([
  // provider
  ['provider list',         { domain: 'provider',   kind: 'read'  }],
  ['provider show',         { domain: 'provider',   kind: 'read'  }],
  ['provider add',          { domain: 'provider',   kind: 'write' }],
  ['provider test',         { domain: 'provider',   kind: 'write' }],
  ['provider refresh',      { domain: 'provider',   kind: 'write' }],
  ['provider delete',       { domain: 'provider',   kind: 'write' }],
  // agent
  ['agent list',            { domain: 'agent',      kind: 'read'  }],
  ['agent show',            { domain: 'agent',      kind: 'read'  }],
  ['agent doctor',          { domain: 'agent',      kind: 'read'  }],
  ['agent config',          { domain: 'agent',      kind: 'write' }],
  ['agent restart',         { domain: 'agent',      kind: 'write' }],
  ['agent set-model',       { domain: 'agent',      kind: 'write' }],
  // mcp
  ['mcp list',              { domain: 'mcp',        kind: 'read'  }],
  ['mcp show',              { domain: 'mcp',        kind: 'read'  }],
  ['mcp add',               { domain: 'mcp',        kind: 'write' }],
  ['mcp delete',            { domain: 'mcp',        kind: 'write' }],
  ['mcp toggle',            { domain: 'mcp',        kind: 'write' }],
  ['mcp import',            { domain: 'mcp',        kind: 'write' }],
  // skill
  ['skill list',            { domain: 'skill',      kind: 'read'  }],
  ['skill show',            { domain: 'skill',      kind: 'read'  }],
  ['skill add',             { domain: 'skill',      kind: 'write' }],
  ['skill update',          { domain: 'skill',      kind: 'write' }],
  ['skill restore',         { domain: 'skill',      kind: 'write' }],
  ['skill delete',          { domain: 'skill',      kind: 'write' }],
  // schedule
  ['schedule list',         { domain: 'schedule',   kind: 'read'  }],
  ['schedule show',         { domain: 'schedule',   kind: 'read'  }],
  ['schedule add',          { domain: 'schedule',   kind: 'write' }],
  ['schedule update',       { domain: 'schedule',   kind: 'write' }],
  ['schedule delete',       { domain: 'schedule',   kind: 'write' }],
  ['schedule pause',        { domain: 'schedule',   kind: 'write' }],
  ['schedule resume',       { domain: 'schedule',   kind: 'write' }],
  ['schedule trigger',      { domain: 'schedule',   kind: 'write' }],
  // channel
  ['channel list',          { domain: 'channel',    kind: 'read'  }],
  ['channel show',          { domain: 'channel',    kind: 'read'  }],
  ['channel start',         { domain: 'channel',    kind: 'write' }],
  ['channel stop',          { domain: 'channel',    kind: 'write' }],
  ['channel restart',       { domain: 'channel',    kind: 'write' }],
  ['channel config',        { domain: 'channel',    kind: 'write' }],
  // friend
  ['friend list',           { domain: 'friend',     kind: 'read'  }],
  ['friend show',           { domain: 'friend',     kind: 'read'  }],
  ['friend add',            { domain: 'friend',     kind: 'write' }],
  ['friend update',         { domain: 'friend',     kind: 'write' }],
  ['friend delete',         { domain: 'friend',     kind: 'write' }],
  // permission
  ['permission list',       { domain: 'permission', kind: 'read'  }],
  ['permission show',       { domain: 'permission', kind: 'read'  }],
  ['permission add',        { domain: 'permission', kind: 'write' }],
  ['permission update',     { domain: 'permission', kind: 'write' }],
  ['permission delete',     { domain: 'permission', kind: 'write' }],
  // config
  ['config show',           { domain: 'config',     kind: 'read'  }],
  ['config set',            { domain: 'config',     kind: 'write' }],
  ['config switch-default', { domain: 'config',     kind: 'write' }],
  ['config proxy',          { domain: 'config',     kind: 'write' }],
  // undo（单 token 子命令）
  ['undo',                  { domain: 'undo',       kind: 'write' }],
])

/**
 * 把 subcommand 字符串映射到 (domain, kind)。
 *
 * **输入约定**：subcommand 应已被上游（`parseCrabotInvocation`）规整过——大小写敏感、
 * 单空格分隔、无前后空白。本函数不做规整。
 *
 * **null 返回的语义**：未识别的 subcommand。**调用方（cli-permission-gate hook）必须 fail-closed**——
 * 一律 deny，避免新加的 CLI 命令在分类表更新前默认放行。这是用 null 而不是 throw 的语义前提。
 */
export function classifyCliSubcommand(subcommand: string): CliClassification | null {
  return SUBCOMMAND_TO_CLASSIFICATION.get(subcommand) ?? null
}

/**
 * 需要 LLM 内容审核的命令。
 * 目前只有 schedule add——它推迟到未来执行，命令字面合法不代表 worker 跑起来时不越权。
 * 其他写命令的破坏面在执行当下完结，硬闸 cli_access 已足够。
 */
export const REQUIRES_CONTENT_REVIEW: ReadonlySet<string> = new Set(['schedule add'])
