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

  it('replaceWith preserves captured connector identity and its tool path uses candidate clients', async () => {
    const live = new McpConnector()
    await live.connectAll([cfgA])
    const getTools = () => live.getAllTools()
    const candidate = await McpConnector.prepare([cfgB])
    await live.replaceWith(candidate)
    expect(getTools().some((item) => item.name === 'mcp__A__echo')).toBe(false)
    const tool = getTools().find((item) => item.name === 'mcp__B__echo')!
    const client = live.getClient('B') as any
    client.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'from-candidate' }] })
    await expect(tool.call({ value: 'x' })).resolves.toMatchObject({ output: 'from-candidate' })
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'echo', arguments: { value: 'x' } },
      undefined,
      { signal: expect.any(AbortSignal), timeout: 120_000 },
    )
  })

  it('prepare 只发布各 server 的完整目录，失败 server 不抑制其它连接', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js') as any
    Client.mockImplementationOnce(() => ({
      connect: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockRejectedValue(new Error('discovery failed')), callTool: vi.fn(),
    }))
    const candidate = await McpConnector.prepare([cfgA, cfgB])
    expect(candidate.getAllTools().map((tool) => tool.name)).toEqual(['mcp__B__echo'])
    expect(candidate.count).toBe(2)
    await connector.replaceWith(candidate)
    expect(connector.count).toBe(2)
    expect(connector.getAllTools().map((tool) => tool.name)).toEqual(['mcp__B__echo'])
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

  it('candidate prepare 失败时旧连接和旧工具仍可执行', async () => {
    await connector.connectAll([cfgA, cfgB])
    expect(connector.count).toBe(2)
    const oldToolNames = connector.getAllTools().map(t => t.name).sort()

    const oldClient = connector.getClient('A')!
    const spy = vi.spyOn(McpConnector, 'prepare').mockRejectedValueOnce(new Error('boom'))

    await expect(connector.reconnect([cfgC])).rejects.toThrow('boom')

    expect(connector.count).toBe(2)
    expect(connector.getAllTools().map(t => t.name).sort()).toEqual(oldToolNames)
    expect(connector.getClient('A')).toBeDefined()
    expect(connector.getClient('B')).toBeDefined()
    expect(oldClient.close).not.toHaveBeenCalled()
    vi.mocked(oldClient.callTool).mockResolvedValueOnce({ content: [{ type: 'text', text: 'still live' }] })
    await expect(connector.getAllTools()[0].call({}, {})).resolves.toMatchObject({ output: 'still live', isError: false })

    spy.mockRestore()
  })

  it('同 schema 重连仍使旧定义失效，新定义使用 live generation', async () => {
    await connector.connectAll([cfgA])
    const original = connector.getAllTools()[0]
    await connector.reconnect([cfgA])
    const current = connector.getAllTools()[0]
    const client = connector.getClient('A')!
    vi.mocked(client.callTool).mockResolvedValue({ content: [{ type: 'text', text: 'current' }] })
    await expect(original.call({}, {})).resolves.toMatchObject({ output: 'TOOL_CATALOG_CHANGED', isError: true })
    expect(current.traceMetadata?.connector_generation).toBe(connector.generation)
    await expect(current.call({}, {})).resolves.toMatchObject({ output: 'current', isError: false })
    await connector.reconnect([cfgA])
    await expect(current.call({}, {})).resolves.toMatchObject({ output: 'TOOL_CATALOG_CHANGED', isError: true })
    expect(client.callTool).toHaveBeenCalledTimes(1)
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
