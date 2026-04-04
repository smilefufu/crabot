import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpConnector } from '../../src/agent/mcp-connector'

describe('McpConnector', () => {
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
    const tools = await connector.getAllTools()
    expect(tools).toEqual([])
  })

  it('getClient returns undefined for unknown server', () => {
    expect(connector.getClient('nonexistent')).toBeUndefined()
  })

  it('connectAll logs errors for invalid configs without throwing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Missing both command and url — should fail but not throw
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
