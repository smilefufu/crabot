/**
 * MCP Server → Engine ToolDefinition bridge
 *
 * 把 `@modelcontextprotocol/sdk` 的 McpServer 转成 engine ToolDefinition[]，
 * 工具名带 `mcp__<serverName>__` 前缀。Worker 与 Front 共用同一份转换逻辑，
 * 避免 messaging/memory 等工具在两侧重复实现。
 */

import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { defineTool } from '../engine/index.js'
import type { ToolDefinition } from '../engine/index.js'

interface RegisteredMcpTool {
  description?: string
  inputSchema?: unknown
  enabled?: boolean
  handler: {
    (args: Record<string, unknown>, extra: unknown): Promise<{
      content: Array<{ type: string; text?: string }>
      isError?: boolean
    }>
  }
}

export function mcpServerToToolDefinitions(
  server: McpServer,
  serverName: string,
): ToolDefinition[] {
  const registeredTools = (server as unknown as {
    _registeredTools: Record<string, RegisteredMcpTool>
  })._registeredTools
  if (!registeredTools) return []

  const tools: ToolDefinition[] = []

  for (const [toolName, registeredTool] of Object.entries(registeredTools)) {
    if (registeredTool.enabled === false) continue

    const prefixedName = `mcp__${serverName}__${toolName}`

    let inputSchema: Record<string, unknown> = { type: 'object', properties: {} }
    if (registeredTool.inputSchema) {
      try {
        const zodSchema = registeredTool.inputSchema as { _def?: unknown }
        if (typeof (z as unknown as { toJSONSchema?: unknown }).toJSONSchema === 'function') {
          inputSchema = (z as unknown as {
            toJSONSchema: (s: unknown) => Record<string, unknown>
          }).toJSONSchema(zodSchema)
        }
      } catch {
        // Fallback: empty object schema
      }
    }

    const handler = registeredTool.handler
    tools.push(defineTool({
      name: prefixedName,
      description: registeredTool.description ?? '',
      inputSchema,
      isReadOnly: false,
      call: async (input) => {
        try {
          const result = await handler(input, {})
          const textParts = (result.content ?? [])
            .filter((block) => block.type === 'text' && block.text)
            .map((block) => block.text as string)
          return {
            output: textParts.join('\n') || JSON.stringify(result.content),
            isError: !!result.isError,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { output: message, isError: true }
        }
      },
    }))
  }

  return tools
}

/** 工具名是否由 mcpServerToToolDefinitions 派生（即由 MCP server 提供）。 */
export function isMcpProxyToolName(name: string): boolean {
  return name.startsWith('mcp__')
}
