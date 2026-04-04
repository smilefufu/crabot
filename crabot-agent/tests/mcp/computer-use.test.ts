/**
 * Tests for Computer Use MCP Server
 *
 * Mocks child_process.execFile to avoid actual screen capture / input events.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}))

// Mock fs for screenshot file reading
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    unlinkSync: vi.fn(),
  }
})

import { execFile } from 'child_process'
import * as fs from 'fs'
import { createComputerUseServer } from '../../src/mcp/computer-use'

// Helper: extract tool handler from McpServer internals
// McpServer stores tools in a plain object _registeredTools[name].handler
async function callTool(
  server: ReturnType<typeof createComputerUseServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }> {
  const registeredTools = (server as any)._registeredTools as Record<
    string,
    { handler: (args: Record<string, unknown>, extra: unknown) => Promise<any> }
  >
  const tool = registeredTools[toolName]
  if (!tool) {
    throw new Error(`Tool "${toolName}" not found. Registered: ${Object.keys(registeredTools).join(', ')}`)
  }
  return tool.handler(args, {})
}

describe('Computer Use MCP Server', () => {
  const mockedExecFile = vi.mocked(execFile)
  const mockedReadFileSync = vi.mocked(fs.readFileSync)
  const mockedUnlinkSync = vi.mocked(fs.unlinkSync)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ================================================================
  // 1. Server has correct tool names registered
  // ================================================================
  it('registers all 4 tools', () => {
    const server = createComputerUseServer()
    const registeredTools = (server as any)._registeredTools as Record<string, unknown>
    const toolNames = Object.keys(registeredTools)

    expect(toolNames).toContain('screenshot')
    expect(toolNames).toContain('mouse_click')
    expect(toolNames).toContain('keyboard_type')
    expect(toolNames).toContain('keyboard_key')
    expect(toolNames).toHaveLength(4)
  })

  // ================================================================
  // 2. screenshot tool calls screencapture command
  // ================================================================
  describe('screenshot', () => {
    it('calls screencapture and returns base64 image', async () => {
      const server = createComputerUseServer()
      const fakeBase64 = Buffer.from('fake-png-data').toString('base64')

      mockedExecFile.mockImplementation((_cmd: any, _args: any, callback: any) => {
        // Simulate screencapture success
        callback(null, '', '')
        return undefined as any
      })
      mockedReadFileSync.mockReturnValue(Buffer.from('fake-png-data'))

      const result = await callTool(server, 'screenshot', {})

      expect(mockedExecFile).toHaveBeenCalledTimes(1)
      const callArgs = mockedExecFile.mock.calls[0]
      expect(callArgs[0]).toBe('screencapture')
      expect(callArgs[1]).toEqual(expect.arrayContaining(['-x', '-t', 'png']))

      expect(result.content).toHaveLength(1)
      expect(result.content[0].type).toBe('image')
      expect(result.content[0].mimeType).toBe('image/png')
      expect(result.content[0].data).toBe(fakeBase64)

      // Cleanup: tmp file should be deleted
      expect(mockedUnlinkSync).toHaveBeenCalledTimes(1)
    })

    it('uses display parameter for multi-display', async () => {
      const server = createComputerUseServer()

      mockedExecFile.mockImplementation((_cmd: any, _args: any, callback: any) => {
        callback(null, '', '')
        return undefined as any
      })
      mockedReadFileSync.mockReturnValue(Buffer.from('fake'))

      await callTool(server, 'screenshot', { display: 2 })

      const callArgs = mockedExecFile.mock.calls[0]
      expect(callArgs[1]).toEqual(expect.arrayContaining(['-D', '2']))
    })

    it('returns text error when screencapture fails', async () => {
      const server = createComputerUseServer()

      mockedExecFile.mockImplementation((_cmd: any, _args: any, callback: any) => {
        callback(new Error('screencapture failed'), '', 'permission denied')
        return undefined as any
      })

      const result = await callTool(server, 'screenshot', {})

      expect(result.content).toHaveLength(1)
      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text).toContain('screencapture failed')
    })
  })

  // ================================================================
  // 3. mouse_click builds correct AppleScript
  // ================================================================
  describe('mouse_click', () => {
    it('builds correct AppleScript for left click', async () => {
      const server = createComputerUseServer()

      mockedExecFile.mockImplementation((_cmd: any, _args: any, callback: any) => {
        callback(null, '', '')
        return undefined as any
      })

      const result = await callTool(server, 'mouse_click', { x: 100, y: 200 })

      expect(mockedExecFile).toHaveBeenCalled()
      const callArgs = mockedExecFile.mock.calls[0]
      expect(callArgs[0]).toBe('osascript')
      const script = callArgs[1]![1] as string
      expect(script).toContain('100')
      expect(script).toContain('200')
      expect(script).toContain('click')

      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text).toContain('success')
    })

    it('builds correct AppleScript for right click', async () => {
      const server = createComputerUseServer()

      mockedExecFile.mockImplementation((_cmd: any, _args: any, callback: any) => {
        callback(null, '', '')
        return undefined as any
      })

      await callTool(server, 'mouse_click', { x: 50, y: 75, button: 'right' })

      const script = mockedExecFile.mock.calls[0][1]![1] as string
      // cliclick uses 'rc' for right click
      expect(script).toContain('rc:')
    })

    it('builds correct AppleScript for double click', async () => {
      const server = createComputerUseServer()

      mockedExecFile.mockImplementation((_cmd: any, _args: any, callback: any) => {
        callback(null, '', '')
        return undefined as any
      })

      await callTool(server, 'mouse_click', { x: 50, y: 75, double_click: true })

      const script = mockedExecFile.mock.calls[0][1]![1] as string
      // cliclick uses 'dc' for double click
      expect(script).toContain('dc:')
    })
  })

  // ================================================================
  // 4. keyboard_type builds correct AppleScript
  // ================================================================
  describe('keyboard_type', () => {
    it('builds correct AppleScript for typing text', async () => {
      const server = createComputerUseServer()

      mockedExecFile.mockImplementation((_cmd: any, _args: any, callback: any) => {
        callback(null, '', '')
        return undefined as any
      })

      const result = await callTool(server, 'keyboard_type', { text: 'hello world' })

      expect(mockedExecFile).toHaveBeenCalled()
      const callArgs = mockedExecFile.mock.calls[0]
      expect(callArgs[0]).toBe('osascript')
      const script = callArgs[1]![1] as string
      expect(script).toContain('keystroke')
      expect(script).toContain('hello world')

      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text).toContain('success')
    })
  })

  // ================================================================
  // 5. keyboard_key with modifiers builds correct command
  // ================================================================
  describe('keyboard_key', () => {
    it('builds correct AppleScript for key press without modifiers', async () => {
      const server = createComputerUseServer()

      mockedExecFile.mockImplementation((_cmd: any, _args: any, callback: any) => {
        callback(null, '', '')
        return undefined as any
      })

      const result = await callTool(server, 'keyboard_key', { key: 'return' })

      expect(mockedExecFile).toHaveBeenCalled()
      const callArgs = mockedExecFile.mock.calls[0]
      expect(callArgs[0]).toBe('osascript')
      const script = callArgs[1]![1] as string
      // 'return' maps to key code 36
      expect(script).toContain('key code 36')

      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text).toContain('success')
    })

    it('builds correct AppleScript for key press with modifiers', async () => {
      const server = createComputerUseServer()

      mockedExecFile.mockImplementation((_cmd: any, _args: any, callback: any) => {
        callback(null, '', '')
        return undefined as any
      })

      await callTool(server, 'keyboard_key', { key: 'c', modifiers: ['command'] })

      const script = mockedExecFile.mock.calls[0][1]![1] as string
      expect(script).toContain('command down')
    })

    it('builds correct AppleScript for key press with multiple modifiers', async () => {
      const server = createComputerUseServer()

      mockedExecFile.mockImplementation((_cmd: any, _args: any, callback: any) => {
        callback(null, '', '')
        return undefined as any
      })

      await callTool(server, 'keyboard_key', { key: 'z', modifiers: ['command', 'shift'] })

      const script = mockedExecFile.mock.calls[0][1]![1] as string
      expect(script).toContain('command down')
      expect(script).toContain('shift down')
    })

    it('returns error on failure', async () => {
      const server = createComputerUseServer()

      mockedExecFile.mockImplementation((_cmd: any, _args: any, callback: any) => {
        callback(new Error('AppleScript failed'), '', '')
        return undefined as any
      })

      const result = await callTool(server, 'keyboard_key', { key: 'return' })

      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text).toContain('AppleScript failed')
    })
  })
})
