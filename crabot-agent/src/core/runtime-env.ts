import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'

export const CORE_AGENT_RUNTIME_BEARER_ENV = 'CRABOT_CORE_AGENT_RUNTIME_BEARER'

const executionEnv = new AsyncLocalStorage<Readonly<Record<string, string>>>()
const envKey = (key: string): string => process.platform === 'win32' && key.toLowerCase() === 'path' ? 'PATH' : key

const SCRUBBED_CHILD_ENV_KEYS = new Set([
  CORE_AGENT_RUNTIME_BEARER_ENV,
  'CRABOT_VOICE_RUNTIME_BEARER',
  'CRABOT_JWT_SECRET',
  'CRABOT_ADMIN_PASSWORD',
  'CRABOT_INTERNAL_TOKEN',
])

const SCRUBBED_INHERITED_ENV_KEYS = new Set([
  ...SCRUBBED_CHILD_ENV_KEYS,
  'CRABOT_TOKEN',
  'CRABOT_TASK_FRIEND_ID',
])

/** Bind credentials to one in-process Engine execution without mutating process.env. */
export function withChildExecutionEnv<T>(
  env: Readonly<Record<string, string>> | undefined,
  run: () => T,
): T {
  return env ? executionEnv.run(env, run) : run()
}

/** Build an Agent-owned child environment without inheriting runtime credentials. */
export function buildChildEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SCRUBBED_INHERITED_ENV_KEYS.has(key.toUpperCase())) env[envKey(key)] = value
  }
  for (const [key, value] of Object.entries(executionEnv.getStore() ?? {})) {
    if (!SCRUBBED_CHILD_ENV_KEYS.has(key.toUpperCase())) env[envKey(key)] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (SCRUBBED_CHILD_ENV_KEYS.has(key.toUpperCase()) || value === undefined) delete env[envKey(key)]
    else env[envKey(key)] = value
  }
  if (env.CRABOT_PRODUCT_ROOT && env.DATA_DIR && !env.npm_config_prefix && !env.NPM_CONFIG_PREFIX) {
    const prefix = path.join(env.DATA_DIR, 'agent-tools', 'node')
    env.npm_config_prefix = prefix
    env.PATH = [process.platform === 'win32' ? prefix : path.join(prefix, 'bin'), env.PATH].filter(Boolean).join(path.delimiter)
  }
  return env
}

/** Keep SDK defaults for source installs; sealed MCPs get only non-secret runtime paths/caches. */
export function buildMcpChildEnv(overrides?: Record<string, string>): Record<string, string> | undefined {
  if (overrides) return buildChildEnv(overrides)
  if (!process.env.CRABOT_PRODUCT_ROOT) return undefined
  const env = buildChildEnv()
  const keys = ['PATH', 'Path', 'CRABOT_BASH_PATH', 'CRABOT_PRODUCT_ROOT', 'UV_CACHE_DIR', 'npm_config_cache', 'npm_config_prefix', 'PYTHONNOUSERSITE', 'PYTHONUTF8', 'PYTHONIOENCODING']
  return Object.fromEntries(keys.flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]))
}

export function scrubChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SCRUBBED_CHILD_ENV_KEYS.has(key.toUpperCase())) result[envKey(key)] = value
  }
  return result
}
