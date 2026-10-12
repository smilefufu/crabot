import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { MCPServerConfig } from '../types.js'
import { BUILTIN_WORKER_PROMPT } from '../prompts/builtin-worker.js'
import { guidanceCatalog } from './catalog.js'

export const GUIDANCE_MCP_SERVER_NAME = 'crabot-guidance'
export const WORKER_TASK_INSTRUCTIONS = [BUILTIN_WORKER_PROMPT, guidanceCatalog('worker')].join('\n\n')

/** Static product text only: no execution identity, credentials, RPC or workspace access. */
export function createGuidanceMcpServerConfig(computerUse = false): MCPServerConfig {
  const compiled = path.join(__dirname, '..', 'mcp', 'guidance-stdio-server.js')
  let args: string[]
  if (existsSync(compiled)) args = [compiled]
  else {
    const source = path.join(__dirname, '..', 'mcp', 'guidance-stdio-server.ts')
    if (!existsSync(source)) throw new Error('guidance stdio bridge entry is unavailable')
    const project = path.resolve(__dirname, '..', '..', 'tsconfig.json')
    args = ['-e', `require(${JSON.stringify(require.resolve('ts-node'))}).register({transpileOnly:true,experimentalResolver:true,project:${JSON.stringify(project)}});require(${JSON.stringify(source)}).startGuidanceStdioServer().catch(()=>{process.exitCode=1})`]
  }
  return { name: GUIDANCE_MCP_SERVER_NAME, transport: 'stdio', command: process.execPath, args, ...(computerUse ? { env: { CRABOT_COMPUTER_USE_GUIDANCE: '1' } } : {}) }
}

export function workerTaskInstructions(computerUse: boolean): string {
  return [BUILTIN_WORKER_PROMPT, guidanceCatalog('worker', { computerUse })].join('\n\n')
}

export function workspaceWorkerTaskInstructions(root: string): string {
  try {
    const config = JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8'))
    return workerTaskInstructions(config.mcpServers?.[GUIDANCE_MCP_SERVER_NAME]?.env?.CRABOT_COMPUTER_USE_GUIDANCE === '1')
  } catch { return WORKER_TASK_INSTRUCTIONS }
}
