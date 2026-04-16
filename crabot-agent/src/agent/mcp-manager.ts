/**
 * MCP Manager - MCP 服务器生命周期管理
 *
 * 负责启动、连接、管理 MCP Server 子进程
 *
 * @see crabot-docs/protocols/protocol-agent-v2.md
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { MCPServerConfig, ToolDeclaration, ToolHandler } from '../types.js'

/**
 * MCP 工具列表结果
 */
interface MCPToolsResult {
  tools: Array<{
    name: string
    description?: string
    inputSchema: unknown
  }>
}

/**
 * MCP 调用工具结果
 */
interface MCPToolResult {
  content: Array<{
    type: string
    text?: string
  }>
}

/**
 * MCP 客户端连接状态
 */
interface MCPConnection {
  name: string
  client: Client
  transport: Transport
  tools: ToolDeclaration[]
}

/**
 * MCP Manager 配置
 */
export interface MCPManagerConfig {
  /** 获取调用方模块 ID 的函数 */
  getModuleId: () => string
}

/**
 * MCP Manager - 管理多个 MCP Server 连接
 */
export class MCPManager {
  private connections: Map<string, MCPConnection> = new Map()
  private getModuleId: () => string

  constructor(config: MCPManagerConfig) {
    this.getModuleId = config.getModuleId
  }

  /**
   * 启动并连接 MCP Server
   */
  async startServer(config: MCPServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      console.warn(`[${this.getModuleId()}] MCP server "${config.name}" already started`)
      return
    }

    try {
      // 创建 stdio transport
      const envVars: Record<string, string> = {}
      // 合并环境变量
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          envVars[key] = value
        }
      }
      if (config.env) {
        for (const [key, value] of Object.entries(config.env)) {
          envVars[key] = value
        }
      }

      if (!config.command) {
        throw new Error(`MCP server "${config.name}" requires a command for stdio transport`)
      }

      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: envVars,
      })

      // 创建 MCP 客户端
      const client = new Client(
        {
          name: `crabot-mcp-${config.name}`,
          version: '1.0.0',
        },
        {
          capabilities: {},
        }
      )

      // 连接
      await client.connect(transport)

      // 获取可用工具
      const toolsResult = (await client.listTools()) as MCPToolsResult
      const tools: ToolDeclaration[] = toolsResult.tools.map((tool) => ({
        name: `mcp__${config.name}__${tool.name}`,
        description: tool.description ?? '',
        source: 'mcp' as const,
        mcp_server: config.name,
        input_schema: tool.inputSchema as ToolDeclaration['input_schema'],
      }))

      // 存储连接
      this.connections.set(config.name, {
        name: config.name,
        client,
        transport,
        tools,
      })

      console.log(
        `[${this.getModuleId()}] MCP server "${config.name}" started with ${tools.length} tools`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.getModuleId()}] Failed to start MCP server "${config.name}":`, message)
      throw new Error(`Failed to start MCP server "${config.name}": ${message}`)
    }
  }

  /**
   * 启动多个 MCP Server
   */
  async startServers(configs: MCPServerConfig[]): Promise<void> {
    const results = await Promise.allSettled(configs.map((config) => this.startServer(config)))

    const errors: string[] = []
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'rejected') {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
        errors.push(`${configs[i].name}: ${reason}`)
      }
    }

    if (errors.length > 0) {
      console.warn(`[${this.getModuleId()}] Some MCP servers failed to start:`, errors)
    }
  }

  /**
   * 停止 MCP Server
   */
  async stopServer(name: string): Promise<void> {
    const connection = this.connections.get(name)
    if (!connection) {
      return
    }

    try {
      await connection.client.close()
      this.connections.delete(name)
      console.log(`[${this.getModuleId()}] MCP server "${name}" stopped`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.getModuleId()}] Error stopping MCP server "${name}":`, message)
    }
  }

  /**
   * 停止所有 MCP Server
   */
  async stopAll(): Promise<void> {
    const names = Array.from(this.connections.keys())
    await Promise.all(names.map((name) => this.stopServer(name)))
  }

  /**
   * 获取所有 MCP 工具声明
   */
  getToolDeclarations(): ToolDeclaration[] {
    const tools: ToolDeclaration[] = []
    for (const connection of this.connections.values()) {
      tools.push(...connection.tools)
    }
    return tools
  }

  /**
   * 创建工具执行处理器
   *
   * 返回一个函数，可以注册到 ToolRegistry
   */
  createToolHandler(serverName: string, toolName: string): ToolHandler {
    return async (input: unknown) => {
      const connection = this.connections.get(serverName)
      if (!connection) {
        throw new Error(`MCP server "${serverName}" not found`)
      }

      try {
        const result = (await connection.client.callTool({
          name: toolName,
          arguments: input as Record<string, unknown>,
        })) as MCPToolResult

        // 提取文本内容
        if (result.content && Array.isArray(result.content)) {
          const textContents = result.content
            .filter((block) => block.type === 'text' && block.text)
            .map((block) => block.text as string)
            .join('\n')

          if (textContents) {
            return textContents
          }
        }

        return JSON.stringify(result.content)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`MCP tool "${toolName}" execution failed: ${message}`)
      }
    }
  }

  /**
   * 将 MCP 工具注册到 ToolRegistry
   *
   * @param registerFn - 注册函数，接收 (declaration, handler)
   */
  registerToolsToRegistry(
    registerFn: (declaration: ToolDeclaration, handler: ToolHandler) => void
  ): void {
    for (const connection of this.connections.values()) {
      for (const tool of connection.tools) {
        // 从工具名中提取原始工具名 (mcp__servername__toolname -> toolname)
        const originalToolName = tool.name.replace(`mcp__${connection.name}__`, '')
        const handler = this.createToolHandler(connection.name, originalToolName)
        registerFn(tool, handler)
      }
    }
  }

  /**
   * 获取连接数量
   */
  get count(): number {
    return this.connections.size
  }

  /**
   * 检查服务器是否已连接
   */
  isConnected(name: string): boolean {
    return this.connections.has(name)
  }
}
