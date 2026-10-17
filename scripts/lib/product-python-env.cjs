'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { productEnvironment } = require('./product-runtime.cjs')

const windows = process.platform === 'win32'

function environmentError(message, code = 'CRABOT_PYTHON_ENV_INVALID') {
  return Object.assign(new Error(message), { code })
}

function ensurePythonAliases(binary) {
  const alias = path.join(path.dirname(binary), 'python3.exe')
  if (windows && !fs.existsSync(alias)) fs.copyFileSync(binary, alias)
}

function ensureProductPythonEnvironment(runtime, dataDir, directory, spawn) {
  const location = path.relative(dataDir, directory)
  if (!location || location === '..' || location.startsWith('..' + path.sep) || path.isAbsolute(location)) {
    throw environmentError('Python 环境路径越界')
  }
  const marker = path.join(directory, '.crabot-runtime.json')
  const installing = path.join(directory, '.crabot-installing.json')
  const binary = path.join(directory, windows ? 'Scripts/python.exe' : 'bin/python')
  const version = runtime.manifest.versions.python
  const compatible = value => typeof value === 'string' && value.split('.').slice(0, 2).join('.') === version.split('.').slice(0, 2).join('.')
  const prefix = runtime.manifest.python_home + '/'
  const entries = Object.entries(runtime.manifest.files).filter(([name]) => name.startsWith(prefix)).sort()
  if (!entries.length) throw environmentError('内置 Python 基底清单不完整')
  const id = crypto.createHash('sha256').update(JSON.stringify(entries.map(([name, record]) => [name.slice(prefix.length), record.sha256]))).digest('hex').slice(0, 24)
  const bases = path.join(dataDir, 'runtime-bases')
  const base = path.join(bases, 'python-' + id)
  // Existing pip is task-owned code too: bootstrap/probes inherit OS paths, never host credentials.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USER|LOGNAME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_.*)$/i.test(key)))
  const env = productEnvironment(runtime, dataDir, inherited)
  env.UV_OFFLINE = '1'
  env.UV_PYTHON_DOWNLOADS = 'never'
  delete env.PYTHONHOME
  delete env.PYTHONPATH
  const run = (command, args) => {
    const result = spawn(command, args, { env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
    if (result.error || result.status !== 0) {
      throw environmentError('内置 Python 环境初始化失败: ' + (result.error?.message ?? result.stderr ?? 'unknown'))
    }
  }

  // A previously owned environment remains tied to its stable interpreter across app updates.
  if (fs.existsSync(marker)) {
    let owned
    try { owned = JSON.parse(fs.readFileSync(marker, 'utf8')) }
    catch { throw environmentError('Python 环境标记损坏，请从诊断修复') }
    if (!owned || owned.schema_version !== 1 || !/^[a-f0-9]{24}$/.test(owned.base_id) || !compatible(owned.python_version)) {
      throw environmentError('Python 环境需要保留依赖后重建', 'CRABOT_PYTHON_ENV_MIGRATION_REQUIRED')
    }
    if (!fs.existsSync(binary) || !fs.existsSync(path.join(bases, 'python-' + owned.base_id))) {
      throw environmentError('Python 环境损坏，请从诊断修复；现有依赖已保留')
    }
    ensurePythonAliases(binary)
    run(binary, ['-I', '-c', 'import sys, pip; assert sys.prefix != sys.base_prefix'])
    return path.dirname(binary) + path.delimiter + (env.PATH ?? env.Path ?? '')
  }

  if (fs.existsSync(directory)) {
    let partial
    try { partial = JSON.parse(fs.readFileSync(installing, 'utf8')) } catch {}
    if (!partial || partial.schema_version !== 1 || !Number.isSafeInteger(partial.pid) || partial.pid <= 0) {
      throw environmentError('现有 Python 环境需要显式迁移，未覆盖原依赖', 'CRABOT_PYTHON_ENV_MIGRATION_REQUIRED')
    }
    try { process.kill(partial.pid, 0); throw environmentError('Python 环境正在由另一进程初始化') }
    catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    fs.rmSync(directory, { recursive: true })
  }

  fs.mkdirSync(bases, { recursive: true })
  if (!fs.existsSync(base)) {
    const pending = base + '.building-' + crypto.randomUUID()
    try {
      // Node 22's C++ directory fast path mishandles Unicode Windows paths
      // (nodejs/node#61950). A filter selects its Unicode-safe JS traversal.
      fs.cpSync(runtime.pythonHome, pending, { recursive: true, verbatimSymlinks: true, ...(windows ? { filter: () => true } : {}) })
      for (const [name, record] of entries) {
        const relative = name.slice(prefix.length)
        const actual = fs.readFileSync(path.join(pending, relative))
        if (crypto.createHash('sha256').update(actual).digest('hex') !== record.sha256) {
          throw environmentError('Python 基底复制校验失败')
        }
      }
      fs.renameSync(pending, base)
    } finally { fs.rmSync(pending, { recursive: true, force: true }) }
  }

  const python = path.join(base, windows ? 'python.exe' : 'bin/python' + version.split('.').slice(0, 2).join('.'))
  fs.mkdirSync(path.dirname(directory), { recursive: true })
  fs.mkdirSync(directory, { mode: 0o700 })
  try {
    fs.writeFileSync(installing, JSON.stringify({ schema_version: 1, pid: process.pid }), { mode: 0o600 })
    run(runtime.executables.uv, ['venv', '--offline', '--no-python-downloads', '--python', python, '--allow-existing', directory])
    run(runtime.executables.uv, ['pip', 'install', '--offline', '--no-index', '--python', binary, ...runtime.seedWheels])
    ensurePythonAliases(binary)
    run(binary, ['-I', '-c', 'import sys, pip; assert sys.prefix != sys.base_prefix'])
    fs.writeFileSync(marker, JSON.stringify({ schema_version: 1, base_id: id, python_version: version }) + '\n', { mode: 0o600 })
    fs.unlinkSync(installing)
  } catch (error) {
    // This directory was created by this operation; no preexisting user environment is removed.
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
  return path.dirname(binary) + path.delimiter + (env.PATH ?? env.Path ?? '')
}

function ensureProductAgentVenv(runtime, dataDir, spawn = spawnSync) {
  return ensureProductPythonEnvironment(runtime, dataDir, path.join(dataDir, 'agent-venv'), spawn)
}

function ensureProductMcpVenv(runtime, dataDir, serverId, spawn = spawnSync) {
  if (typeof serverId !== 'string' || !serverId) throw environmentError('MCP 标识缺失')
  const id = crypto.createHash('sha256').update(serverId).digest('hex').slice(0, 24)
  return ensureProductPythonEnvironment(runtime, dataDir, path.join(dataDir, 'mcp-envs', id, 'python'), spawn)
}

module.exports = { ensureProductAgentVenv, ensureProductMcpVenv }
