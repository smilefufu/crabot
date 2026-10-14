import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

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
      if (/^COREPACK_NPM_(TOKEN|USERNAME|PASSWORD)$/.test(key) || /^COREPACK_INTEGRITY_KEYS$/.test(key) || /^npm_config_(.*(?:_auth|token|username|password)|registry|strict_ssl|better_sqlite3_binary_host)/i.test(key)) delete env[key]
    }
    Object.assign(env, { npm_config_registry: url, npm_config_strict_ssl: 'true', COREPACK_NPM_REGISTRY: url, COREPACK_DEFAULT_TO_LATEST: '0', npm_config_update_notifier: 'false', SHARP_IGNORE_GLOBAL_LIBVIPS: '1' })
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
  if (/gyp ERR!|ELIFECYCLE|hash.*mismatch|mismatch.*hash|signature|keyid|integrity|EACCES|EPERM|ENOSPC|permission denied|no space left|cancelled/i.test(message)) return false
  return /HTTP[^\n]*(403|404|408|429|5\d\d)|403 Forbidden|404 Not Found|ERR_PNPM_(FETCH|META_FETCH|NO_MATCHING_VERSION)|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|network.*(failed|unreachable)|connection.*(reset|refused|timed out)|request.*timed out|was not found in the package registry|there (?:is no version|are no versions) of/i.test(message)
}

async function npmTransport(env) {
  const windows = process.platform === 'win32'
  const npm = windows ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : 'npm'
  if (windows && !existsSync(npm)) return {}
  let stdout
  try {
    ;({ stdout } = await exec(windows ? process.execPath : npm, [...(windows ? [npm] : []), 'config', 'list', '--json', '--no-update-notifier'], { env, timeout: 5000, maxBuffer: 1024 * 1024 }))
  } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error(`Cannot inspect npm transport settings (exit ${error.code ?? 'unknown'})`) }
  const config = JSON.parse(stdout)
  const transport = {}
  for (const key of ['proxy', 'https-proxy', 'noproxy', 'cafile', 'ca']) {
    const value = config[key]
    if (value != null && value !== '') transport[`npm_config_${key.replaceAll('-', '_')}`] = Array.isArray(value) ? value.join('\n') : String(value)
  }
  return transport
}

export async function withPackageSource(source, action, { logger = console, timeout = 20 * 60_000, env = process.env } = {}) {
  const deadline = Date.now() + timeout
  let configDirectory
  if (source.kind === 'npm') {
    const transport = await npmTransport(env)
    configDirectory = await mkdtemp(join(tmpdir(), 'crabot-npm-config-'))
    try {
      await writeFile(join(configDirectory, 'user.npmrc'), '')
      await writeFile(join(configDirectory, 'global.npmrc'), '')
    } catch (error) { await rm(configDirectory, { recursive: true, force: true }); throw error }
    env = { ...env }
    for (const key of Object.keys(env)) if (/^npm_config_(userconfig|globalconfig)$/i.test(key)) delete env[key]
    env = { ...env, ...transport, npm_config_userconfig: join(configDirectory, 'user.npmrc'), npm_config_globalconfig: join(configDirectory, 'global.npmrc') }
  }
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
  } finally { if (configDirectory) await rm(configDirectory, { recursive: true, force: true }) }
}

async function probeBinaryDownload(url, env, expectedHost, proxy = '') {
  const curl = process.platform === 'win32' ? join(env.WINDIR, 'System32/curl.exe') : 'curl'
  const args = ['--head', '--fail', '--silent', '--show-error', '--location', '--proto-redir', '=https', '--connect-timeout', '3', '--max-time', '5', '--write-out', '\n%{url_effective}', url]
  if (proxy) args.push('--proxy', proxy)
  try {
    const { stdout } = await exec(curl, args, { env, timeout: 5000, maxBuffer: 65536 })
    const actual = stdout.slice(stdout.lastIndexOf('\n') + 1)
    return new URL(actual).hostname === expectedHost && /content-type:.*(?:octet-stream|gzip|x-tar)/i.test(stdout)
  } catch { return false }
}

export async function selectPythonDownloadSource(uv, request, { cwd, env = process.env, logger = console } = {}) {
  const source = packageSource('standalone', sources.standalone[1])
  const candidateEnv = packageEnvironment('standalone', source.domestic, env)
  const { stdout } = await exec(uv, ['python', 'list', ...(request ? [request] : []), '--only-downloads', '--all-versions', '--output-format', 'json'], { cwd, env: candidateEnv, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
  const records = JSON.parse(stdout).filter(record => record.key.startsWith('cpython-'))
  const record = records.find(record => record.variant === 'default') ?? records[0]
  if (!record?.url) throw new Error('uv cannot identify the required standalone Python download')
  const proxy = await systemProxy(record.url, env)
  if (await probeBinaryDownload(record.url, env, new URL(source.domestic).hostname, proxy)) source.url = source.domestic
  logger.info(`Standalone Python source: ${source.url}${source.url === source.official ? ' (domestic missing/unavailable or redirected to official)' : ''}`)
  return source
}

export async function nativePackageEnvironment(directory, source, env, logger = console) {
  if (source.url !== source.domestic) return env
  let manifest, lock
  try {
    manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (!manifest.dependencies?.['better-sqlite3']) return env
    lock = await readFile(join(directory, 'pnpm-lock.yaml'), 'utf8')
  } catch (error) { if (error.code === 'ENOENT') return env; throw error }
  const versions = [...new Set([...lock.matchAll(/^  better-sqlite3@(\d+\.\d+\.\d+):/gm)].map(match => match[1]))]
  const child = { ...env }
  const filename = `better-sqlite3-v${versions[0]}-node-v${process.versions.modules}-${process.platform}-${process.arch}.tar.gz`
  const url = `${child.npm_config_better_sqlite3_binary_host}/v${versions[0]}/${filename}`
  const available = versions.length === 1 && await probeBinaryDownload(url, env, 'cdn.npmmirror.com')
  if (available) logger.info(`SQLite prebuild source: ${url}`)
  else {
    delete child.npm_config_better_sqlite3_binary_host
    logger.warn('SQLite mirror does not provide a verified transport for this locked version/ABI; using its official prebuild source')
  }
  return child
}
