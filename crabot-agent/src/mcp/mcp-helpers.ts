/**
 * MCP Server helpers — standard @modelcontextprotocol/sdk replacement
 * for createSdkMcpServer + tool from claude-agent-sdk.
 *
 * Re-exports McpServer for convenience. Tool registration is done
 * directly via McpServer.tool() which preserves zod type inference.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// Re-export McpServer for convenience
export { McpServer }

/**
 * Create a standard McpServer instance.
 *
 * Callers register tools directly via `server.tool(name, desc, schema, handler)`.
 */
export function createMcpServer(
  config: { name: string; version: string },
): McpServer {
  return new McpServer(
    { name: config.name, version: config.version },
  )
}
