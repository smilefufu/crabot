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

// 恢复 commit 8d2ac0a 之前已有的 smoke / error-logging 测试。
// 这些测试用 invalid config 触发 resolveTransport 阶段的同步错误，
// 不进入 Client.connect 路径，因此与上方 vi.mock 的 stub 互不影响。
describe('McpConnector — smoke / error logging', () => {
  let connector: McpConnector

  beforeEach(() => {
    connector = new McpConnector()
  })

  it('constructs without errors', () => {
    expect(connector).toBeInstanceOf(McpConnector)
    expect(connector.count).toBe(0)
  })

  it('connectAll with empty config does nothing', async () => {
    await connector.connectAll([])
    expect(connector.count).toBe(0)
  })

  it('disconnectAll with no connections does nothing', async () => {
    await connector.disconnectAll()
    expect(connector.count).toBe(0)
  })

  it('getAllTools returns empty when no connections', async () => {
    const tools = connector.getAllTools()
    expect(tools).toEqual([])
  })

  it('getClient returns undefined for unknown server', () => {
    expect(connector.getClient('nonexistent')).toBeUndefined()
  })

  it('connectAll logs errors for invalid configs without throwing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await connector.connectAll([
      { name: 'bad-server' },
    ])

    expect(connector.count).toBe(0)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to connect MCP server "bad-server"'),
    )

    consoleSpy.mockRestore()
  })

  it('connectAll logs errors for stdio without command', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await connector.connectAll([
      { name: 'no-cmd', transport: 'stdio' },
    ])

    expect(connector.count).toBe(0)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('stdio needs command'),
    )

    consoleSpy.mockRestore()
  })

  it('connectAll logs errors for streamable-http without url', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await connector.connectAll([
      { name: 'no-url', transport: 'streamable-http' },
    ])

    expect(connector.count).toBe(0)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('streamable-http needs url'),
    )

    consoleSpy.mockRestore()
  })

  it('connectAll logs errors for sse without url', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await connector.connectAll([
      { name: 'no-url-sse', transport: 'sse' },
    ])

    expect(connector.count).toBe(0)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('sse needs url'),
    )

    consoleSpy.mockRestore()
  })
})
