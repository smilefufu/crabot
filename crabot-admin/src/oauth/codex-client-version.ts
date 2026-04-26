/**
 * Codex CLI 版本解析
 *
 * ChatGPT 订阅后端的 `/models` 接口要求 query 参数 `client_version`，
 * 上游会据此按每个模型的 `minimal_client_version` 字段进行过滤——
 * 版本越新，能看到的模型越多（例如 gpt-5.5 需要 >= 0.124.0）。
 *
 * 这里从 npm registry 读取 `@openai/codex` 最新版本以持续对齐官方；
 * 网络失败时退回到编写时已知的最新稳定版。
 */

const NPM_LATEST_URL = 'https://registry.npmjs.org/@openai/codex/latest'
const FALLBACK_VERSION = '0.124.0'
const CACHE_TTL_MS = 10 * 60 * 1000

let cached: { version: string; fetched_at: number } | null = null
let inflight: Promise<string> | null = null

function isValidSemverCore(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value)
}

async function fetchLatestFromNpm(): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(NPM_LATEST_URL, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`npm registry returned HTTP ${response.status}`)
    }
    const data = (await response.json()) as { version?: unknown }
    const version = typeof data.version === 'string' ? data.version : ''
    if (!isValidSemverCore(version)) {
      throw new Error(`unexpected version from npm: ${JSON.stringify(data.version)}`)
    }
    return version
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * 解析 codex CLI 当前最新版本号，用作 `/models?client_version=...`。
 */
export async function resolveCodexClientVersion(): Promise<string> {
  const now = Date.now()
  if (cached && now - cached.fetched_at < CACHE_TTL_MS) {
    return cached.version
  }

  if (inflight) {
    return inflight
  }

  inflight = (async () => {
    try {
      const version = await fetchLatestFromNpm()
      cached = { version, fetched_at: Date.now() }
      return version
    } catch (error) {
      console.warn(
        `[codex-client-version] failed to resolve latest from npm, fallback to ${FALLBACK_VERSION}:`,
        error instanceof Error ? error.message : error,
      )
      return FALLBACK_VERSION
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/**
 * 仅供单测重置缓存。
 */
export function __resetCodexClientVersionCacheForTests(): void {
  cached = null
  inflight = null
}
