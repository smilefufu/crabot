'use strict'

// Shared by the standalone Node launcher and the core; never loaded in renderer code.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const COMMANDS = ['node', 'python', 'uv', 'bash', 'git', 'rg']

function invalid(message) {
  const error = new Error('内置运行环境 runtime: ' + message)
  error.code = 'CRABOT_RUNTIME_INVALID'
  throw error
}

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':')
    || value.includes('\0') || path.posix.isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) {
    invalid('清单路径非法: ' + String(value))
  }
  return value
}

function inside(root, relative) {
  const target = path.join(root, relativePath(relative))
  let real
  try { real = fs.realpathSync(target) }
  catch { invalid('组件缺失 missing: ' + relative) }
  const location = path.relative(root, real)
  if (location === '..' || location.startsWith('..' + path.sep) || path.isAbsolute(location)) {
    invalid('组件路径越界 outside: ' + relative)
  }
  return target
}

function verifyFile(root, relative, entry) {
  const target = inside(root, relative)
  const stat = fs.statSync(target)
  if (!stat.isFile() || stat.size !== entry.size
    || crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== entry.sha256) {
    invalid('组件完整性 integrity 校验失败: ' + relative)
  }
  return target
}

function loadProductRuntime(root, { required = false, full = false } = {}) {
  const target = path.join(root, 'product-runtime.json')
  if (!fs.existsSync(target)) {
    if (required || fs.existsSync(path.join(root, '.product-runtime')) || fs.existsSync(path.join(root, 'core-release.json'))) invalid('清单缺失，请修复安装')
    return null
  }
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(target, 'utf8')) }
  catch { invalid('manifest 清单无法读取') }
  if (!manifest || manifest.schema_version !== 1 || typeof manifest.version !== 'string' || !manifest.version) {
    invalid('manifest 清单版本不兼容')
  }
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    invalid('平台 platform/architecture 不匹配')
  }
  if (!manifest.versions || !/^\d+\.\d+\.\d+$/.test(manifest.versions.python)
    || !/^\d+\.\d+\.\d+$/.test(manifest.versions.node)) invalid('manifest 解释器版本清单损坏')
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    invalid('inventory 文件清单缺失')
  }
  root = fs.realpathSync(root)
  for (const [name, entry] of Object.entries(manifest.files)) {
    relativePath(name)
    if (!entry || !Number.isSafeInteger(entry.size) || entry.size < 0
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      invalid('inventory 文件清单损坏: ' + name)
    }
  }
  const executables = {}, verified = new Set()
  for (const name of COMMANDS) {
    const relative = relativePath(manifest.executables?.[name])
    const entry = manifest.files[relative]
    if (!entry) invalid('inventory 未收录必需命令: ' + name)
    executables[name] = verifyFile(root, relative, entry)
    verified.add(relative)
    if (process.platform !== 'win32' && !(fs.statSync(executables[name]).mode & 0o111)) {
      invalid('组件不可执行: ' + name)
    }
  }
  if (!Array.isArray(manifest.path_entries) || !manifest.path_entries.length
    || !Array.isArray(manifest.seed_wheels)) invalid('manifest 环境清单损坏')
  const directories = [...manifest.path_entries, manifest.python_home, manifest.memory_packages]
  for (const relative of directories) {
    if (!fs.statSync(inside(root, relative)).isDirectory()) invalid('组件目录非法: ' + relative)
  }
  for (const relative of manifest.seed_wheels) {
    relativePath(relative)
    if (!manifest.files[relative]) invalid('inventory 未收录 seed wheel')
    verifyFile(root, relative, manifest.files[relative])
    verified.add(relative)
  }
  if (full) {
    // Required commands and seed wheels were fully hashed in this same call.
    for (const [relative, entry] of Object.entries(manifest.files)) if (!verified.has(relative)) verifyFile(root, relative, entry)
  }
  return {
    root, manifest, executables,
    pythonHome: inside(root, manifest.python_home),
    memoryPackages: inside(root, manifest.memory_packages),
    pathEntries: manifest.path_entries.map(relative => inside(root, relative)),
    seedWheels: manifest.seed_wheels.map(relative => inside(root, relative)),
  }
}

function productEnvironment(runtime, dataDir, source = process.env) {
  const env = { ...source }
  const pathKey = process.platform === 'win32'
    ? Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH' : 'PATH'
  const currentPath = env[pathKey]
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  }
  env.PATH = [...runtime.pathEntries, currentPath].filter(Boolean).join(path.delimiter)
  env.CRABOT_PRODUCT_ROOT = runtime.root
  env.CRABOT_BASH_PATH = runtime.executables.bash
  env.npm_config_cache = path.join(dataDir, 'runtime-cache', 'npm')
  env.UV_CACHE_DIR = path.join(dataDir, 'runtime-cache', 'uv')
  env.PYTHONUTF8 ||= '1'
  env.PYTHONIOENCODING ||= 'utf-8'
  // Do not set npm prefix: third-party Worker CLIs retain their user-install policy.
  return env
}

module.exports = { loadProductRuntime, productEnvironment }
