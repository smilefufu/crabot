import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { ToolCallContext } from '../engine/types.js'
import { createGuidanceTool } from '../guidance/catalog.js'

export function createGuidanceProtocolServer(): Server {
  const tool = createGuidanceTool('worker')
  const server = new Server({ name: 'crabot-guidance', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  }] }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name !== tool.name) throw new McpError(ErrorCode.MethodNotFound, 'unknown guidance operation')
    const result = await tool.call(request.params.arguments ?? {}, {} as ToolCallContext)
    return { content: [{ type: 'text', text: result.output }], isError: result.isError }
  })
  return server
}

export async function startGuidanceStdioServer(): Promise<void> {
  await createGuidanceProtocolServer().connect(new StdioServerTransport())
}
if (require.main === module) void startGuidanceStdioServer().catch(() => { process.exitCode = 1 })
