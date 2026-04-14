import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the MCP SDK before importing McpConnector
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(),
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn(),
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpConnector } from '../src/agent/mcp-connector.js'
import type { MCPServerConfig } from '../src/types.js'

function createMockClient(tools: Array<{ name: string; description?: string; inputSchema?: object }>) {
  const callToolSpy = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  })

  const mockClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      })),
    }),
    callTool: callToolSpy,
  }

  vi.mocked(Client).mockImplementation(() => mockClient as unknown as Client)
  return { mockClient, callToolSpy }
}

describe('McpConnector tool_defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('injects tool_defaults when LLM omits the parameter', async () => {
    const { callToolSpy } = createMockClient([
      { name: 'fetch', description: 'Fetch a URL' },
    ])

    const connector = new McpConnector()
    const config: MCPServerConfig = {
      name: 'scrapling',
      command: 'scrapling',
      args: ['mcp'],
      tool_defaults: {
        fetch: { real_chrome: true },
      },
    }

    await connector.connectAll([config])
    const tools = connector.getAllTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('mcp__scrapling__fetch')

    // Simulate LLM calling fetch without real_chrome
    await tools[0].call({ url: 'https://example.com' }, {} as never)

    expect(callToolSpy).toHaveBeenCalledWith({
      name: 'fetch',
      arguments: { real_chrome: true, url: 'https://example.com' },
    })
  })

  it('LLM explicit value takes priority over tool_defaults', async () => {
    const { callToolSpy } = createMockClient([
      { name: 'fetch', description: 'Fetch a URL' },
    ])

    const connector = new McpConnector()
    const config: MCPServerConfig = {
      name: 'scrapling',
      command: 'scrapling',
      args: ['mcp'],
      tool_defaults: {
        fetch: { real_chrome: true, headless: true },
      },
    }

    await connector.connectAll([config])
    const tools = connector.getAllTools()

    // LLM explicitly passes real_chrome=false — should NOT be overridden
    await tools[0].call({ url: 'https://example.com', real_chrome: false }, {} as never)

    expect(callToolSpy).toHaveBeenCalledWith({
      name: 'fetch',
      arguments: { real_chrome: false, headless: true, url: 'https://example.com' },
    })
  })

  it('tools without matching defaults are unaffected', async () => {
    const { callToolSpy } = createMockClient([
      { name: 'get', description: 'HTTP GET' },
    ])

    const connector = new McpConnector()
    const config: MCPServerConfig = {
      name: 'scrapling',
      command: 'scrapling',
      args: ['mcp'],
      tool_defaults: {
        fetch: { real_chrome: true },
      },
    }

    await connector.connectAll([config])
    const tools = connector.getAllTools()

    await tools[0].call({ url: 'https://example.com' }, {} as never)

    // 'get' has no defaults configured — input passed through unchanged
    expect(callToolSpy).toHaveBeenCalledWith({
      name: 'get',
      arguments: { url: 'https://example.com' },
    })
  })

  it('works without tool_defaults configured', async () => {
    const { callToolSpy } = createMockClient([
      { name: 'fetch', description: 'Fetch a URL' },
    ])

    const connector = new McpConnector()
    const config: MCPServerConfig = {
      name: 'scrapling',
      command: 'scrapling',
      args: ['mcp'],
      // no tool_defaults
    }

    await connector.connectAll([config])
    const tools = connector.getAllTools()

    await tools[0].call({ url: 'https://example.com' }, {} as never)

    expect(callToolSpy).toHaveBeenCalledWith({
      name: 'fetch',
      arguments: { url: 'https://example.com' },
    })
  })
})
