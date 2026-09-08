import path from 'node:path'
import { promises as fs } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { ToolCallContext } from '../engine/types.js'
import type { WorkerWorkspaceGitContext } from '../workers/types.js'
import { buildScrubbedChildEnv } from '../workers/connections/secret-env.js'
import { createWorkspaceGitTool, WORKSPACE_GIT_CONTEXT_ENV, WORKSPACE_GIT_MCP_SERVER_NAME } from '../workers/workspace-git-capability.js'

export async function workspaceGitContextFromEnv(env: NodeJS.ProcessEnv): Promise<WorkerWorkspaceGitContext> {
  const contextFile = env[WORKSPACE_GIT_CONTEXT_ENV]
  if (!contextFile || !path.isAbsolute(contextFile)) throw new Error('workspace Git bridge requires an assembly-bound execution context')
  const file = await fs.open(contextFile, 'r')
  let binding: WorkerWorkspaceGitContext | null
  try {
    const stat = await file.stat()
    // The Inspector caps raw output at 4 MiB; allow JSON escaping without using an unbounded input file.
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('workspace Git binding exceeds its file limit')
    binding = JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
  if (!binding || typeof binding.worker_id !== 'string' || !binding.worker_id
    || typeof binding.incarnation_id !== 'string' || !binding.incarnation_id
    || typeof binding.workspace_root !== 'string' || !path.isAbsolute(binding.workspace_root)
    || (binding.baseline && (typeof binding.baseline.captured_at !== 'string'
      || typeof binding.baseline.workspace_root !== 'string'
      || !['repository', 'not_repository', 'error'].includes(binding.baseline.state?.status)))) {
    throw new Error('workspace Git bridge requires an assembly-bound execution context')
  }
  return binding
}

export function createWorkspaceGitProtocolServer(binding: WorkerWorkspaceGitContext): Server {
  const tool = createWorkspaceGitTool(binding)
  const server = new Server({ name: WORKSPACE_GIT_MCP_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  }] }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== tool.name) throw new McpError(ErrorCode.MethodNotFound, 'unknown workspace Git operation')
    const result = await tool.call(request.params.arguments ?? {}, {} as ToolCallContext)
    return { content: [{ type: 'text', text: result.output }], isError: result.isError }
  })
  return server
}

export async function startWorkspaceGitStdioServer(): Promise<void> {
  const binding = await workspaceGitContextFromEnv(process.env)
  const clean = buildScrubbedChildEnv()
  for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key]
  await createWorkspaceGitProtocolServer(binding).connect(new StdioServerTransport())
}

if (require.main === module) {
  void startWorkspaceGitStdioServer().catch(() => {
    console.error('workspace Git bridge startup failed')
    process.exitCode = 1
  })
}
