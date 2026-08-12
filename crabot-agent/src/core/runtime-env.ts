export const CORE_AGENT_RUNTIME_BEARER_ENV = 'CRABOT_CORE_AGENT_RUNTIME_BEARER'

const SCRUBBED_CHILD_ENV_KEYS = new Set([
  CORE_AGENT_RUNTIME_BEARER_ENV,
])

/** Build an Agent-owned child environment without inheriting runtime credentials. */
export function buildChildEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SCRUBBED_CHILD_ENV_KEYS.has(key)) env[key] = value
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
