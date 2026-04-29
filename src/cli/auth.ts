import { readFileSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'

export interface AuthConfig {
  readonly endpoint: string
  readonly token: string
}

function getPortOffset(): number {
  const offsetStr = process.env['CRABOT_PORT_OFFSET']
  const offset = offsetStr ? parseInt(offsetStr, 10) : 0
  return isNaN(offset) ? 0 : offset
}

function resolveDataDir(offset: number): string {
  const envDataDir = process.env['DATA_DIR']
  if (envDataDir) {
    return envDataDir
  }
  if (offset > 0) {
    return `data-${offset}/`
  }
  return 'data/'
}

function resolveEndpoint(opts: { endpoint?: string }, offset: number): string {
  if (opts.endpoint) {
    return opts.endpoint
  }

  const envEndpoint = process.env['CRABOT_ENDPOINT']
  if (envEndpoint) {
    return envEndpoint
  }

  const port = 3000 + offset
  return `http://localhost:${port}`
}

function resolveToken(opts: { token?: string; crabotHome?: string }, offset: number): string {
  if (opts.token) {
    return opts.token
  }

  const envToken = process.env['CRABOT_TOKEN']
  if (envToken) {
    return envToken
  }

  // When DATA_DIR is absolute (set by MM to a module-specific path like /path/data/agent),
  // the admin token lives in the sibling admin directory.
  // path.join does NOT reset on absolute mid-segments (unlike path.resolve), so we must
  // handle absolute DATA_DIR separately to avoid doubled paths.
  const envDataDir = process.env['DATA_DIR']
  let tokenPath: string
  if (envDataDir && isAbsolute(envDataDir)) {
    tokenPath = resolve(envDataDir, '..', 'admin', 'internal-token')
  } else {
    const dataDir = resolveDataDir(offset)
    const basePath = opts.crabotHome ?? process.env['CRABOT_HOME'] ?? process.cwd()
    tokenPath = join(basePath, dataDir, 'admin', 'internal-token')
  }

  try {
    return readFileSync(tokenPath, 'utf-8').trim()
  } catch {
    throw new Error(
      `Cannot resolve auth token. Provide via --token, CRABOT_TOKEN env, or ensure ${tokenPath} exists.`
    )
  }
}

export function resolveAuth(opts: {
  endpoint?: string
  token?: string
  crabotHome?: string
}): AuthConfig {
  const offset = getPortOffset()
  const endpoint = resolveEndpoint(opts, offset)
  const token = resolveToken(opts, offset)

  return { endpoint, token }
}
