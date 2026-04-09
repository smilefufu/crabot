/**
 * MCP Connector - Manages connections to external MCP servers (multi-transport)
 *
 * Supports stdio, streamable-http, and sse transports.
 * Caches tool definitions at connect time to avoid per-task listTools() overhead.
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
  /** Cached tool definitions — populated at connect time, avoids per-task listTools() */
  private cachedTools: ToolDefinition[] = []

  async connectAll(configs: ReadonlyArray<MCPServerConfig>): Promise<void> {
    // Deduplicate by name
    const seen = new Set<string>()
    const unique = configs.filter((c) => {
      if (seen.has(c.name)) return false
      seen.add(c.name)
      return true
    })

    const results = await Promise.allSettled(
      unique.map((config) => this.connectOne(config))
    )

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const reason = (results[i] as PromiseRejectedResult).reason
        const msg = reason instanceof Error ? reason.message : String(reason)
        console.error(`[McpConnector] Failed to connect MCP server "${unique[i].name}": ${msg}`)
      }
    }

    // Cache tools from all connected servers
    await this.refreshToolCache()
  }

  private async connectOne(config: MCPServerConfig): Promise<void> {
    if (this.clients.has(config.name)) return

    const transport = this.resolveTransport(config)
    const client = new Client(
      { name: `crabot-${config.name}`, version: '1.0.0' },
      { capabilities: {} },
    )

    try {
      await client.connect(transport)
      this.clients.set(config.name, client)
      console.log(`[McpConnector] Connected to "${config.name}" (${config.transport ?? 'auto'})`)
    } catch (error) {
      // Clean up on partial failure
      try { await client.close() } catch { /* ignore */ }
      throw error
    }
  }

  private resolveTransport(config: MCPServerConfig) {
    const type = config.transport
      ?? (config.command ? 'stdio' : config.url ? 'streamable-http' : undefined)

    if (!type) {
      throw new Error(`"${config.name}": no transport (need command or url)`)
    }

    switch (type) {
      case 'stdio': {
        if (!config.command) throw new Error(`"${config.name}": stdio needs command`)
        return new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
        })
      }
      case 'streamable-http': {
        if (!config.url) throw new Error(`"${config.name}": streamable-http needs url`)
        return new StreamableHTTPClientTransport(
          new URL(config.url),
          config.headers ? { requestInit: { headers: config.headers } } : undefined,
        )
      }
      case 'sse': {
        if (!config.url) throw new Error(`"${config.name}": sse needs url`)
        return new SSEClientTransport(
          new URL(config.url),
          config.headers ? { requestInit: { headers: config.headers } } : undefined,
        )
      }
      default:
        throw new Error(`"${config.name}": unsupported transport "${type}"`)
    }
  }

  /** Rebuild tool cache from all connected servers */
  private async refreshToolCache(): Promise<void> {
    const tools: ToolDefinition[] = []

    for (const [serverName, client] of this.clients) {
      try {
        const { tools: mcpTools } = await client.listTools()
        for (const mcpTool of mcpTools) {
          tools.push(defineTool({
            name: `mcp__${serverName}__${mcpTool.name}`,
            category: 'mcp_skill',
            description: mcpTool.description ?? '',
            inputSchema: mcpTool.inputSchema as Record<string, unknown>,
            isReadOnly: false,
            call: async (input) => {
              try {
                const result = await client.callTool({
                  name: mcpTool.name,
                  arguments: input,
                })
                const contentArray = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>

                const texts = contentArray
                  .filter(c => c.type === 'text' && c.text)
                  .map(c => c.text!)

                const images = contentArray
                  .filter(c => c.type === 'image' && c.data)
                  .map(c => ({ media_type: c.mimeType ?? 'image/png', data: c.data! }))

                return {
                  output: texts.join('\n') || (images.length > 0 ? '[Image captured]' : '(empty)'),
                  images: images.length > 0 ? images : undefined,
                  isError: !!result.isError,
                }
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)
                return { output: msg, isError: true }
              }
            },
          }))
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[McpConnector] Failed to list tools from "${serverName}": ${msg}`)
      }
    }

    this.cachedTools = tools
  }

  /** Get all tools (cached — no network calls) */
  getAllTools(): ToolDefinition[] {
    return this.cachedTools
  }

  getClient(name: string): Client | undefined {
    return this.clients.get(name)
  }

  get count(): number {
    return this.clients.size
  }

  async disconnectAll(): Promise<void> {
    const entries = Array.from(this.clients.entries())
    this.clients.clear()
    this.cachedTools = []

    await Promise.allSettled(
      entries.map(async ([name, client]) => {
        try { await client.close() } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          console.error(`[McpConnector] Error disconnecting "${name}": ${msg}`)
        }
      })
    )
  }
}
