import path from 'node:path'
import { execFile } from 'node:child_process'
import type { MCPServerManager, MCPServerRegistryEntry } from './mcp-skill-manager.js'

type AgentMcpConfig = ReturnType<MCPServerManager['toAgentConfig']>
type PreparedEnvironment = { command: string; args: string[]; env: Record<string, string> }
const { validateManagedMcp } = require('../../scripts/lib/managed-mcp-config.cjs')
const inFlight = new Map<string, Promise<PreparedEnvironment>>()
// Python base publication is shared. Serialize bounded offline preparation to avoid two initial publishers.
let prepareTail: Promise<unknown> = Promise.resolve()

function prepare(root: string, dataDir: string, entry: MCPServerRegistryEntry): Promise<PreparedEnvironment> {
  const key = JSON.stringify([root, dataDir, entry.id, entry.managed_runtime, entry.command])
  const pending = inFlight.get(key)
  if (pending) return pending
  const operation = prepareTail.catch(() => {}).then(() => new Promise<PreparedEnvironment>((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|HOME|USER|LOGNAME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_.*)$/i.test(key)))
    execFile(process.execPath, [path.join(root, 'scripts/lib/managed-mcp-prepare.cjs'),
      root, dataDir, entry.id, entry.managed_runtime!, entry.command!],
    { env, encoding: 'utf8', timeout: 130_000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return reject(new Error('CRABOT_MCP_ENV_PREPARE_FAILED：请检查或修复内置环境，现有依赖已保留'))
      try { resolve(JSON.parse(stdout) as PreparedEnvironment) }
      catch { reject(new Error('CRABOT_MCP_ENV_PREPARE_FAILED：环境准备结果无效')) }
    })
  }))
  inFlight.set(key, operation)
  prepareTail = operation
  void operation.finally(() => { inFlight.delete(key) }).catch(() => {})
  return operation
}

export async function resolveManagedMcpConfig(
  root: string, dataDir: string, entry: MCPServerRegistryEntry, config: AgentMcpConfig,
): Promise<AgentMcpConfig> {
  if (!entry.managed_runtime) return config
  validateManagedMcp(entry)
  const prepared = await prepare(root, dataDir, entry)
  return { ...config, command: prepared.command, args: [...prepared.args, ...(config.args ?? [])],
    env: { ...config.env, ...prepared.env } }
}
