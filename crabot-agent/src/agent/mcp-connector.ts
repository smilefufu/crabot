/**
 * MCP Connector - Manages connections to external MCP servers (multi-transport)
 *
 * Supports stdio, streamable-http, and sse transports.
 * Converts remote MCP tools into engine ToolDefinition[] for use by WorkerHandler.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { defineTool } from '../engine/tool-framework.js'
import type { ToolDefinition } from '../engine/types.js'
import type { MCPServerConfig } from '../types.js'

export class McpConnector {
  private readonly clients: Map<string, Client> = new Map()

  /**
   * Connect to all configured MCP servers.
   * Errors on individual servers are logged but do not prevent other servers from connecting.
   */
  async connectAll(configs: ReadonlyArray<MCPServerConfig>): Promise<void> {
    const results = await Promise.allSettled(
      configs.map((config) => this.connectOne(config))
    )

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'rejected') {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
        console.error(`[McpConnector] Failed to connect MCP server "${configs[i].name}": ${reason}`)
      }
    }
  }

  /**
   * Connect to a single MCP server based on its transport type.
   */
  private async connectOne(config: MCPServerConfig): Promise<void> {
    if (this.clients.has(config.name)) {
      console.warn(`[McpConnector] MCP server "${config.name}" already connected, skipping`)
      return
    }

    const transport = this.resolveTransport(config)
    const client = new Client(
      { name: `crabot-${config.name}`, version: '1.0.0' },
      { capabilities: {} },
    )

    await client.connect(transport)
    this.clients.set(config.name, client)

    console.log(`[McpConnector] Connected to MCP server "${config.name}" (${transport.constructor.name})`)
  }

  /**
   * Infer transport type and create the appropriate transport instance.
   * - If config.transport is set, use it directly.
   * - If config.command is set, default to stdio.
   * - If config.url is set, default to streamable-http.
   */
  private resolveTransport(config: MCPServerConfig): InstanceType<typeof StdioClientTransport> | InstanceType<typeof SSEClientTransport> | InstanceType<typeof StreamableHTTPClientTransport> {
    const transportType = config.transport
      ?? (config.command ? 'stdio' : config.url ? 'streamable-http' : undefined)

    if (!transportType) {
      throw new Error(`MCP server "${config.name}": cannot determine transport type (no command or url provided)`)
    }

    switch (transportType) {
      case 'stdio': {
        if (!config.command) {
          throw new Error(`MCP server "${config.name}": stdio transport requires "command"`)
        }
        return new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: { ...process.env, ...config.env } as Record<string, string>,
        })
      }
      case 'streamable-http': {
        if (!config.url) {
          throw new Error(`MCP server "${config.name}": streamable-http transport requires "url"`)
        }
        return new StreamableHTTPClientTransport(
          new URL(config.url),
          { requestInit: { headers: config.headers } },
        )
      }
      case 'sse': {
        if (!config.url) {
          throw new Error(`MCP server "${config.name}": sse transport requires "url"`)
        }
        return new SSEClientTransport(
          new URL(config.url),
          { requestInit: { headers: config.headers } },
        )
      }
      default:
        throw new Error(`MCP server "${config.name}": unsupported transport type "${transportType}"`)
    }
  }

  /** Get a connected client by server name */
  getClient(name: string): Client | undefined {
    return this.clients.get(name)
  }

  /** Number of connected servers */
  get count(): number {
    return this.clients.size
  }

  /**
   * List all tools from all connected servers as ToolDefinition[].
   * Tool names are prefixed with `mcp__<serverName>__<toolName>`.
   */
  async getAllTools(): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = []

    for (const [serverName, client] of this.clients) {
      try {
        const { tools: mcpTools } = await client.listTools()
        for (const mcpTool of mcpTools) {
          tools.push(defineTool({
            name: `mcp__${serverName}__${mcpTool.name}`,
            description: mcpTool.description ?? '',
            inputSchema: mcpTool.inputSchema as Record<string, unknown>,
            isReadOnly: false,
            call: async (input) => {
              try {
                const result = await client.callTool({
                  name: mcpTool.name,
                  arguments: input,
                })
                const text = (result.content as Array<{ type: string; text?: string }>)
                  .filter(c => c.type === 'text' && c.text)
                  .map(c => c.text!)
                  .join('\n')
                return {
                  output: text || JSON.stringify(result.content),
                  isError: !!result.isError,
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { output: message, isError: true }
              }
            },
          }))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[McpConnector] Failed to list tools from "${serverName}": ${message}`)
      }
    }

    return tools
  }

  /** Disconnect all connected MCP servers */
  async disconnectAll(): Promise<void> {
    const entries = Array.from(this.clients.entries())
    this.clients.clear()

    for (const [name, client] of entries) {
      try {
        await client.close()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[McpConnector] Error disconnecting "${name}": ${message}`)
      }
    }
  }
}
