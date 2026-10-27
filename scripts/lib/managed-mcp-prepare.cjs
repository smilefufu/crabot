'use strict'

// Runs only environment preparation, never a user MCP command or package installer.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { loadProductRuntime, productEnvironment } = require('./product-runtime.cjs')
const { ensureProductMcpVenv } = require('./product-python-env.cjs')
const { validateManagedMcp } = require('./managed-mcp-config.cjs')

function prepareManagedMcp(root, dataDir, config) {
  validateManagedMcp(config)
  if (!config.managed_runtime) throw new Error('MCP 环境选择缺失')
  if (typeof config.id !== 'string' || !config.id) throw new Error('MCP 标识缺失')
  const runtime = loadProductRuntime(root, { required: true })
  const id = createHash('sha256').update(config.id).digest('hex').slice(0, 24)
  const directory = path.join(dataDir, 'mcp-envs', id)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const env = productEnvironment(runtime, dataDir, {})
  Object.assign(env, { PYTHONNOUSERSITE: '1', PYTHONPATH: '', PYTHONHOME: '', NODE_PATH: '', NODE_OPTIONS: '' })
  const node = runtime.executables.node
  let command = config.command
  let args = []
  if (config.managed_runtime === 'python') {
    env.PATH = ensureProductMcpVenv(runtime, dataDir, config.id)
    const bin = env.PATH.split(path.delimiter)[0]
    const python = path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python')
    env.VIRTUAL_ENV = path.dirname(bin)
    env.UV_PYTHON = python
    env.UV_PYTHON_DOWNLOADS = 'never'
    env.UV_PYTHON_PREFERENCE = 'only-system'
    env.UV_CACHE_DIR = path.join(directory, 'uv-cache')
    env.UV_TOOL_DIR = path.join(directory, 'uv-tools')
    env.UV_TOOL_BIN_DIR = path.join(directory, 'bin')
    command = ['uv', 'uvx'].includes(command) ? runtime.executables.uv : python
    if (config.command === 'uvx') args = ['tool', 'run']
  } else {
    env.npm_config_cache = path.join(directory, 'npm-cache')
    env.npm_config_prefix = path.join(directory, 'node-tools')
    // User/global npmrc can redirect the cache or prefix outside this MCP.
    env.npm_config_userconfig = path.join(directory, 'npmrc')
    env.npm_config_globalconfig = path.join(directory, 'global-npmrc')
    if (process.platform !== 'win32') {
      env.npm_config_script_shell = runtime.executables.bash
      env.NPM_CONFIG_SCRIPT_SHELL = runtime.executables.bash
    }
    env.NPM_CONFIG_PREFIX = env.npm_config_prefix
    env.NPM_CONFIG_CACHE = env.npm_config_cache
    env.NPM_CONFIG_USERCONFIG = env.npm_config_userconfig
    env.NPM_CONFIG_GLOBALCONFIG = env.npm_config_globalconfig
    env.PATH = [path.join(env.npm_config_prefix, process.platform === 'win32' ? '' : 'bin'), env.PATH].join(path.delimiter)
    if (command !== 'node') {
      const npmRoot = process.platform === 'win32' ? path.join(path.dirname(node), 'node_modules/npm')
        : path.join(path.dirname(node), '../lib/node_modules/npm')
      const cli = path.join(npmRoot, 'bin', command + '-cli.js')
      if (!fs.statSync(cli).isFile()) throw new Error('内置 npm 组件缺失')
      args = [cli]
    }
    command = node
  }
  // Only generated values are returned. MCP credentials never enter this preparation process.
  return { command, args, env }
}

module.exports = { prepareManagedMcp }
if (require.main === module) {
  try {
    const [root, dataDir, id, managed_runtime, command] = process.argv.slice(2)
    process.stdout.write(JSON.stringify(prepareManagedMcp(root, dataDir, { id, managed_runtime, command })))
  } catch {
    process.stderr.write('CRABOT_MCP_ENV_PREPARE_FAILED\n')
    process.exitCode = 1
  }
}
