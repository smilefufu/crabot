// 只读产品资源解析；Admin 和 CLI 共用，不能在 MCP 握手中安装依赖。
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const INPUTS = ['runtime.json', 'requirements.lock', 'linux-resources.json', 'server.py', 'build.py']
function fingerprint(root) {
  const hash = createHash('sha256')
  for (const file of INPUTS) {
    hash.update(file).update(fs.readFileSync(path.join(root, 'scripts', 'scrapling', file)))
  }
  hash.update(fs.readFileSync(path.join(root, 'scripts', 'lib', 'scrapling-runtime.cjs')))
  hash.update(fs.readFileSync(path.join(root, 'scripts', 'lib', 'scrapling-prepare.mjs')))
  return hash.digest('hex').slice(0, 16)
}
function inside(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('invalid Scrapling resource path')
  const full = path.resolve(root, relative)
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('invalid Scrapling resource path')
  return full
}
function isStandardScrapling(entry) {
  return entry.is_builtin === true && entry.name === 'scrapling'
    && (entry.transport ?? 'stdio') === 'stdio' && entry.command === 'scrapling'
    && JSON.stringify(entry.args) === '["mcp"]'
}
function runtimeRequired(dataDir) {
  const registry = path.join(dataDir, 'admin', 'mcp-servers.json')
  if (!fs.existsSync(registry)) return true // Admin 将注册默认启用的 builtin。
  const entries = JSON.parse(fs.readFileSync(registry, 'utf8'))
  if (!Array.isArray(entries)) throw new Error('invalid MCP registry')
  if (!entries.some(s => s.name === 'scrapling')) return true
  return entries.some(s => isStandardScrapling(s) && s.enabled)
}
function validateDirectory(root, directory, { full = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'ready.json'), 'utf8'))
  if (manifest.fingerprint !== fingerprint(root)) throw new Error('dependency fingerprint mismatch')
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('platform mismatch')
  if (!manifest.files || !manifest.command || !manifest.browser || !manifest.node) throw new Error('incomplete ready manifest')
  const required = ['server.py', manifest.command, manifest.browser, manifest.node]
  if (required.some(file => !manifest.files[file])) throw new Error('incomplete resource inventory')
  const files = full ? Object.entries(manifest.files) : required.map(p => [p, manifest.files[p]])
  for (const [relative, record] of files) {
    const file = inside(directory, relative)
    if (!record || !fs.statSync(file).isFile() || fs.statSync(file).size !== record.size) throw new Error(`missing or damaged resource: ${relative}`)
    if ((full || relative === 'server.py') && createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== record.sha256) throw new Error(`resource checksum mismatch: ${relative}`)
  }
  return { directory, manifest }
}
function loadRuntime(root, options = {}) {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(root, 'scrapling-runtime.json'), 'utf8'))
    const directory = inside(root, index.directory)
    if (!index.directory.startsWith('.scrapling-runtime-')) throw new Error('invalid runtime directory')
    return validateDirectory(root, directory, options)
  } catch (err) {
    throw new Error(`Scrapling runtime unavailable: ${err.message}. Ask the administrator to run crabot upgrade (source installs: git pull first); use node scripts/prepare-scrapling.mjs to repair a writable installation.`)
  }
}
function resolveScraplingConfig(root, dataDir, entry, config) {
  if (!isStandardScrapling(entry)) return config
  const { directory, manifest } = loadRuntime(root)
  return { ...config, command: inside(directory, manifest.command), args: ['-I', '-B', inside(directory, 'server.py')], env: {
    ...config.env,
    CRABOT_SCRAPLING_DATA_DIR: path.resolve(dataDir),
    CRABOT_SCRAPLING_SYSTEM: fs.existsSync('/etc/crabot/cluster.version') ? '1' : '0',
    PLAYWRIGHT_BROWSERS_PATH: inside(directory, 'browsers'),
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
  } }
}
exports.fingerprint = fingerprint
exports.isStandardScrapling = isStandardScrapling
exports.runtimeRequired = runtimeRequired
exports.loadRuntime = loadRuntime
exports.resolveScraplingConfig = resolveScraplingConfig
exports.validateDirectory = validateDirectory
