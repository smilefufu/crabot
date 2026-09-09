import { AsyncLocalStorage } from 'node:async_hooks'

export const CORE_AGENT_RUNTIME_BEARER_ENV = 'CRABOT_CORE_AGENT_RUNTIME_BEARER'

const executionEnv = new AsyncLocalStorage<Readonly<Record<string, string>>>()

const SCRUBBED_CHILD_ENV_KEYS = new Set([
  CORE_AGENT_RUNTIME_BEARER_ENV,
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
    if (value !== undefined && !SCRUBBED_INHERITED_ENV_KEYS.has(key)) env[key] = value
  }
  for (const [key, value] of Object.entries(executionEnv.getStore() ?? {})) {
    if (!SCRUBBED_CHILD_ENV_KEYS.has(key)) env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (SCRUBBED_CHILD_ENV_KEYS.has(key) || value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

export function scrubChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SCRUBBED_CHILD_ENV_KEYS.has(key)) result[key] = value
  }
  return result
}
