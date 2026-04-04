import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { promisify } from 'util'
import { execFile } from 'child_process'

export const execFileAsync = promisify(execFile)

export function jsonResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

export function errorResponse(message: string) {
  return jsonResponse({ error: message })
}

export async function runStdioServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
