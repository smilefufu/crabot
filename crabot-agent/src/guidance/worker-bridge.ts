import { existsSync } from 'node:fs'
import path from 'node:path'
import type { MCPServerConfig } from '../types.js'
import { BUILTIN_WORKER_PROMPT } from '../prompts/builtin-worker.js'
import { guidanceCatalog } from './catalog.js'

export const GUIDANCE_MCP_SERVER_NAME = 'crabot-guidance'
export const WORKER_TASK_INSTRUCTIONS = [BUILTIN_WORKER_PROMPT, guidanceCatalog('worker')].join('\n\n')

/** Static product text only: no execution identity, credentials, RPC or workspace access. */
export function createGuidanceMcpServerConfig(): MCPServerConfig {
  const compiled = path.join(__dirname, '..', 'mcp', 'guidance-stdio-server.js')
  let args: string[]
  if (existsSync(compiled)) args = [compiled]
  else {
    const source = path.join(__dirname, '..', 'mcp', 'guidance-stdio-server.ts')
    if (!existsSync(source)) throw new Error('guidance stdio bridge entry is unavailable')
    const project = path.resolve(__dirname, '..', '..', 'tsconfig.json')
    args = ['-e', `require(${JSON.stringify(require.resolve('ts-node'))}).register({transpileOnly:true,experimentalResolver:true,project:${JSON.stringify(project)}});require(${JSON.stringify(source)}).startGuidanceStdioServer().catch(()=>{process.exitCode=1})`]
  }
  return { name: GUIDANCE_MCP_SERVER_NAME, transport: 'stdio', command: process.execPath, args }
}
