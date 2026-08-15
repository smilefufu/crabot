/**
 * child env 构造（P6-B plan §7 Agent 步骤 4）。
 *
 * worker/setup/installer 的 child env 一律从 allowlist 基础构造并显式 scrub：
 * - CRABOT_CORE_AGENT_RUNTIME_BEARER / cutover token / admin token
 * - 所有 Provider credential 形态 env（ANTHROPIC_、OPENAI_、CODEX_ 等前缀）
 * - assertion / relay lease
 * 之后由当前 translator 注入本次连接字段。
 */

/** 永不继承的前缀/精确名。 */
const SCRUB_EXACT = new Set([
  'CRABOT_CORE_AGENT_RUNTIME_BEARER',
  'CRABOT_ADMIN_CUTOVER_BEARER',
  'CRABOT_ADMIN_STARTUP_MODE',
])

const SCRUB_PREFIXES = [
  'ANTHROPIC_',
  'OPENAI_',
  'CODEX_',
  'CLAUDE_',
  'CRABOT_ADMIN_',
  'CRABOT_WORKER_ADMIN_',
]

/** 精确名（PATH 精确匹配，不放行 PATHEXT 这类形近变体）。 */
const ALLOW_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'SSH_AUTH_SOCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_OPTIONS',
])

/** 家族前缀（带下划线结尾，不会误伤形近词）。 */
const ALLOW_PREFIXES = ['LC_', 'NVM_', 'XDG_']

function isAllowed(key: string): boolean {
  if (SCRUB_EXACT.has(key)) return false
  if (SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix))) return false
  return ALLOW_EXACT.has(key) || ALLOW_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/**
 * 构造 scrub 后的干净 child env。sentinel 测试断言：bearer/Provider credential/
 * 无关 CLI credential 一律不出现。
 */
export function buildScrubbedChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (isAllowed(key)) env[key] = value
  }
  return env
}
