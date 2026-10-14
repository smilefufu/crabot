import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const exec = promisify(execFile)
const sources = {
  npm: ['https://registry.npmmirror.com', 'https://registry.npmjs.org', '/corepack/0.31.0'],
  python: ['https://mirrors.aliyun.com/pypi/simple/', 'https://pypi.org/simple', 'hatchling/'],
  standalone: ['https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone/', 'https://github.com/astral-sh/python-build-standalone/releases/download/', ''],
}

export async function uvTransport(uv, directory, env = process.env) {
  // Ask the installed uv to resolve its own configuration; never print the settings dump.
  let stdout
  try {
    ;({ stdout } = await exec(uv, ['--show-settings', 'python', 'list', '--only-downloads', '--output-format', 'json'], { cwd: directory, env, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }))
  } catch (error) { throw new Error(`Cannot inspect uv certificate settings (exit ${error.code ?? 'unknown'})`) }
  const system = stdout.match(/\b(?:system_certs|native_tls): (true|false),/)
  if (!system) throw new Error('uv cannot report its certificate settings; update uv to 0.13.0')
  const certificate = stdout.match(/custom_certificates:\s*Some\(\s*("(?:[^"\\]|\\.)*")/)
  const certEnv = certificate ? { SSL_CERT_FILE: JSON.parse(certificate[1]), SSL_CERT_DIR: '' } : {}
  if (/custom_certificates:\s*Some/.test(stdout) && !certificate) throw new Error('uv certificate settings cannot be preserved safely')
  return { UV_NO_CONFIG: '1', UV_SYSTEM_CERTS: system[1], UV_NATIVE_TLS: system[1], ...certEnv }
}

async function systemProxy(url, env) {
  if (process.platform !== 'win32' || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy) return ''
  const script = '$u=[Uri]$env:CRABOT_NETWORK_PROBE;$p=[Net.WebRequest]::DefaultWebProxy;if($p){$v=$p.GetProxy($u);if($v -ne $u){$v.AbsoluteUri}}'
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...env, CRABOT_NETWORK_PROBE: url }, timeout: 5000, maxBuffer: 4096,
  })
  return stdout.trim()
}

async function probeSource(url, kind, env, proxy) {
  const curl = process.platform === 'win32' ? join(env.WINDIR, 'System32/curl.exe') : 'curl'
  const args = ['--fail', '--silent', '--show-error', '--location', '--proto-redir', '=https', '--connect-timeout', '3', '--max-time', '5', '--write-out', '\n%{url_effective}', url]
  if (proxy) args.push('--proxy', proxy)
  try {
    const { stdout } = await exec(curl, args, { env, timeout: 5000, maxBuffer: 1024 * 1024 })
    const line = stdout.lastIndexOf('\n')
    if (new URL(stdout.slice(line + 1)).hostname !== new URL(url).hostname) return false
    const body = stdout.slice(0, line)
    if (kind === 'npm') { const pkg = JSON.parse(body); return pkg.version === '0.31.0' && Boolean(pkg.dist?.integrity && pkg.dist?.tarball) }
    return /<a\s[^>]*href=[^>]*hatchling[^>]*\.(whl|tar\.gz)/i.test(body)
  } catch { return false }
}

export function packageSource(kind, url) {
  const [domestic, official] = sources[kind] ?? []
  if (!domestic || ![domestic, official].includes(url)) throw new Error('Invalid product package source')
  return { kind, url, domestic, official, proxy: '', systemProxy: process.platform === 'win32' }
}

export async function selectPackageSource(kind, { probe, logger = console, env = process.env } = {}) {
  const [domestic, official, path] = sources[kind] ?? []
  if (!domestic) throw new Error(`Unknown product dependency source: ${kind}`)
  const proxy = probe ? '' : await systemProxy(domestic, env)
  const available = await (probe ? probe(domestic + path) : probeSource(domestic + path, kind, env, proxy))
  const source = { kind, url: available ? domestic : official, domestic, official, proxy, systemProxy: !probe && process.platform === 'win32' }
  logger.info(`Dependency source (${kind}): ${source.url}${available ? '' : ' (domestic unavailable; official fallback)'}`)
  return source
}

export function packageEnvironment(kind, url, parent = process.env) {
  const env = { ...parent }
  if (kind === 'npm') {
    for (const key of Object.keys(env)) {
      if (/^COREPACK_NPM_(TOKEN|USERNAME|PASSWORD)$/.test(key) || /^COREPACK_INTEGRITY_KEYS$/.test(key) || /^npm_config_(_auth|_authtoken|username|password|registry|strict_ssl|better_sqlite3_binary_host)/i.test(key)) delete env[key]
    }
    Object.assign(env, { npm_config_registry: url, npm_config_strict_ssl: 'true', COREPACK_NPM_REGISTRY: url })
    if (url === sources.npm[0]) env.npm_config_better_sqlite3_binary_host = 'https://cdn.npmmirror.com/binaries/better-sqlite3'
  } else if (kind === 'python') {
    for (const key of Object.keys(env)) if (/^UV_(INDEX|DEFAULT_INDEX|EXTRA_INDEX_URL|INDEX_URL|INDEX_STRATEGY|INSECURE_HOST|NO_VERIFY_HASHES)(_|$)/.test(key)) delete env[key]
    Object.assign(env, { UV_INDEX: url, UV_DEFAULT_INDEX: url, UV_INDEX_URL: url })
  } else if (kind === 'standalone') {
    delete env.UV_PYTHON_DOWNLOADS_JSON_URL
    env.UV_PYTHON_INSTALL_MIRROR = url
  } else throw new Error(`Unknown product dependency source: ${kind}`)
  return env
}

function sourceFailure(error) {
  if (error.code === 'CRABOT_PREPARATION_CANCELLED') return false
  const message = `${error.message}\n${error.stderr ?? ''}`
  if (/hash.*mismatch|mismatch.*hash|signature|keyid|integrity|EACCES|EPERM|ENOSPC|permission denied|no space left|cancelled/i.test(message)) return false
  return /HTTP[^\n]*(403|404|408|429|5\d\d)|403 Forbidden|404 Not Found|ERR_PNPM_(FETCH|META_FETCH|NO_MATCHING_VERSION)|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|network.*(failed|unreachable)|connection.*(reset|refused|timed out)|request.*timed out|was not found in the package registry/i.test(message)
}

export async function withPackageSource(source, action, { logger = console, timeout = 20 * 60_000, env = process.env } = {}) {
  const deadline = Date.now() + timeout
  const attempt = async () => {
    if (Date.now() >= deadline) throw new Error('Product dependency preparation timed out')
    const child = packageEnvironment(source.kind, source.url, env)
    const proxy = source.systemProxy ? await systemProxy(source.url, child) : source.proxy
    if (proxy) { child.HTTPS_PROXY = proxy; child.HTTP_PROXY = proxy }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Product dependency preparation timed out')
    return action(source.url, child, remaining)
  }
  try { return await attempt() } catch (domesticError) {
    domesticError.dependencyKind ??= source.kind
    if (domesticError.dependencyKind !== source.kind || source.url !== source.domestic || !sourceFailure(domesticError) || Date.now() >= deadline) throw domesticError
    logger.warn(`Domestic ${source.kind} source failed; retrying official source within remaining budget`)
    source.url = source.official
    try { return await attempt() } catch (officialError) {
      throw Object.assign(new AggregateError([domesticError, officialError], `Domestic and official ${source.kind} preparation failed: ${domesticError.message}; ${officialError.message}`), { dependencyKind: source.kind })
    }
  }
}

export async function selectPythonDownloadSource(uv, request, { cwd, env = process.env, logger = console } = {}) {
  const source = packageSource('standalone', sources.standalone[1])
  const candidateEnv = packageEnvironment('standalone', source.domestic, env)
  const { stdout } = await exec(uv, ['python', 'list', ...(request ? [request] : []), '--only-downloads', '--all-versions', '--output-format', 'json'], { cwd, env: candidateEnv, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
  const records = JSON.parse(stdout).filter(record => record.key.startsWith('cpython-'))
  const record = records.find(record => record.variant === 'default') ?? records[0]
  if (!record?.url) throw new Error('uv cannot identify the required standalone Python download')
  const proxy = await systemProxy(record.url, env)
  const curl = process.platform === 'win32' ? join(env.WINDIR, 'System32/curl.exe') : 'curl'
  try {
    const args = ['--head', '--fail', '--silent', '--show-error', '--location', '--proto-redir', '=https', '--connect-timeout', '3', '--max-time', '5', '--write-out', '\n%{url_effective}', record.url]
    if (proxy) args.push('--proxy', proxy)
    const { stdout: headers } = await exec(curl, args, { env, timeout: 5000, maxBuffer: 65536 })
    const actual = headers.slice(headers.lastIndexOf('\n') + 1)
    if (new URL(actual).hostname === new URL(source.domestic).hostname && /content-type:.*(?:octet-stream|gzip|x-tar)/i.test(headers)) source.url = source.domestic
  } catch {}
  logger.info(`Standalone Python source: ${source.url}${source.url === source.official ? ' (domestic missing/unavailable or redirected to official)' : ''}`)
  return source
}
