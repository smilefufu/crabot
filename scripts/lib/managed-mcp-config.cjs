'use strict'

const COMMANDS = { node: ['node', 'npm', 'npx'], python: ['python', 'python3', 'uv', 'uvx'] }
const RESERVED_ENV = /^(path|pythonhome|pythonpath|virtual_env|node_path|node_options|npm_config_(prefix|cache|userconfig|globalconfig|script_shell)|uv_(python.*|cache_dir|tool_dir|tool_bin_dir|system_python|managed_python|no_managed_python))$/i

function validateManagedMcp(config) {
  const runtime = config.managed_runtime
  if (runtime === undefined || runtime === null) return
  if (!Object.hasOwn(COMMANDS, runtime) || (config.transport ?? 'stdio') !== 'stdio'
    || !COMMANDS[runtime].includes(config.command)) {
    throw new Error('受管 MCP 需要匹配的裸 Node/Python 命令；自定义路径或远程连接请选择自定义环境')
  }
  if (config.env !== undefined && (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)
    || Object.values(config.env).some(value => typeof value !== 'string'))
    || config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string'))) {
    throw new Error('MCP 参数或环境变量格式无效')
  }
  if (Object.keys(config.env ?? {}).some(key => RESERVED_ENV.test(key))) {
    throw new Error('MCP 的自定义解释器或包目录与受管环境冲突，请选择自定义环境')
  }
  // Preserve project arguments and locks; never override an explicit interpreter/cache target.
  const reserved = runtime === 'python'
    ? /^(--python(?:=|$)|--python-preference(?:=|$)|--python-downloads(?:=|$)|--managed-python$|--system$|--cache-dir(?:=|$)|-p$)/
    : /^(--prefix(?:=|$)|--cache(?:=|$)|--userconfig(?:=|$)|--globalconfig(?:=|$))/
  if (['uv', 'uvx', 'npm', 'npx'].includes(config.command)) {
    const args = config.args ?? []
    const valueOptions = new Set(['--from', '--package', '-p', '--with', '--with-editable', '--with-requirements', '--directory', '--project', '--config-file'])
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '--') break
      if (['npx', 'uvx'].includes(config.command) && !arg.startsWith('-')) break
      if (reserved.test(arg)) throw new Error('MCP 参数指定了自定义解释器或包目录，请选择自定义环境')
      if (valueOptions.has(arg)) i++
    }
  }
}

function managedMcpSelection(config, bundled) {
  let selection = config.managed_runtime
  if (selection === undefined && bundled && (config.transport ?? 'stdio') === 'stdio'
    && Object.keys(config.env ?? {}).length === 0) {
    selection = config.command === 'npx' ? 'node' : config.command === 'uvx' ? 'python' : undefined
  }
  validateManagedMcp({ ...config, managed_runtime: selection })
  return selection ?? undefined
}

module.exports = { managedMcpSelection, validateManagedMcp }
