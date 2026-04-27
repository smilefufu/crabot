import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpConnector } from '../../src/agent/mcp-connector.js'
import type { MCPServerConfig } from '../../src/types.js'

// Stub MCP Client to avoid actual server processes
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: {} } }],
    }),
    callTool: vi.fn(),
  })),
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))

const cfgA: MCPServerConfig = { name: 'A', transport: 'stdio', command: 'echo' }
const cfgB: MCPServerConfig = { name: 'B', transport: 'stdio', command: 'echo' }
const cfgC: MCPServerConfig = { name: 'C', transport: 'stdio', command: 'echo' }

describe('McpConnector.reconnect', () => {
  let connector: McpConnector

  beforeEach(() => {
    vi.clearAllMocks()
    connector = new McpConnector()
  })

  it('reconnect 成功路径：cachedTools 含新 server', async () => {
    await connector.connectAll([cfgA, cfgB])
    expect(connector.count).toBe(2)
    expect(connector.getAllTools().some(t => t.name === 'mcp__A__echo')).toBe(true)

    await connector.reconnect([cfgA, cfgB, cfgC])
    expect(connector.count).toBe(3)
    expect(connector.getAllTools().some(t => t.name === 'mcp__C__echo')).toBe(true)
  })

  it('reconnect 后 disconnectAll 清空（清理路径）', async () => {
    await connector.connectAll([cfgA])
    await connector.reconnect([cfgB])
    expect(connector.count).toBe(1)
    expect(connector.getAllTools().some(t => t.name === 'mcp__B__echo')).toBe(true)
    await connector.disconnectAll()
    expect(connector.count).toBe(0)
    expect(connector.getAllTools()).toEqual([])
  })

  it('reconnect 替换：旧 server 不再出现在 cachedTools', async () => {
    await connector.connectAll([cfgA, cfgB])
    await connector.reconnect([cfgC])
    expect(connector.count).toBe(1)
    expect(connector.getAllTools().some(t => t.name === 'mcp__A__echo')).toBe(false)
    expect(connector.getAllTools().some(t => t.name === 'mcp__B__echo')).toBe(false)
    expect(connector.getAllTools().some(t => t.name === 'mcp__C__echo')).toBe(true)
  })
})
