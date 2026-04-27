// 所有 write 权限的 crabot CLI 子命令。Agent 在非 master 私聊场景遇到这些会被 hook 拦截。
export const CLI_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'provider add', 'provider delete',
  'agent config', 'agent restart', 'agent set-model',
  'mcp add', 'mcp delete', 'mcp toggle', 'mcp import',
  'skill add', 'skill delete',
  'schedule add', 'schedule delete', 'schedule pause', 'schedule resume', 'schedule trigger',
  'channel start', 'channel stop', 'channel restart', 'channel config',
  'friend add', 'friend update', 'friend delete',
  'permission add', 'permission update', 'permission delete',
  'config set', 'config switch-default', 'config proxy',
  'undo',
])

// 必须 confirm 的 7 类命令（CLI 内部 confirm-rules.ts 也维护一份；保持一致）
export const CLI_MUST_CONFIRM_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'provider delete', 'mcp delete', 'skill delete', 'schedule delete',
  'friend delete', 'permission delete', 'schedule trigger',
])
