import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// ============================================================================
// Helpers
// ============================================================================

function getTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-server-test-'))
}

function writeFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

/**
 * List registered tool names from the McpServer internal registry.
 */
function getToolNames(server: McpServer): string[] {
  const tools = (server as any)._registeredTools as Record<string, unknown>
  return Object.keys(tools)
}

/**
 * Call a tool on the McpServer by directly invoking the registered callback.
 * This avoids needing a transport connection for unit tests.
 */
async function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const tools = (server as any)._registeredTools as Record<string, { handler: Function }>
  const tool = tools[toolName]
  if (!tool) {
    throw new Error(`Tool "${toolName}" not registered`)
  }
  const result = await Promise.resolve(tool.handler(args, {}))
  return result as { content: Array<{ type: string; text: string }> }
}

function parseToolResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text)
}

// ============================================================================
// Mock setup for LspServerManager
// ============================================================================

const mockSendRequest = vi.fn()
const mockStopAll = vi.fn().mockResolvedValue(undefined)
const mockRegisterServer = vi.fn()

vi.mock('../../src/lsp/lsp-server-manager.js', () => ({
  LspServerManager: vi.fn().mockImplementation(() => ({
    sendRequest: mockSendRequest,
    stopAll: mockStopAll,
    registerServer: mockRegisterServer,
  })),
  getDefaultServerConfigs: vi.fn().mockReturnValue([
    {
      name: 'typescript-language-server',
      command: 'npx',
      args: ['typescript-language-server', '--stdio'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
      languageIds: {
        '.ts': 'typescript',
        '.tsx': 'typescriptreact',
        '.js': 'javascript',
        '.jsx': 'javascriptreact',
        '.mjs': 'javascript',
        '.cjs': 'javascript',
      },
    },
  ]),
}))

// ============================================================================
// Tests
// ============================================================================

describe('LSP MCP Server', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = getTempDir()
    vi.clearAllMocks()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // --------------------------------------------------------------------------
  // 1. Server registers all 9 tools + returns stopAll
  // --------------------------------------------------------------------------
  describe('server creation', () => {
    it('should register all 9 tools', async () => {
      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const toolNames = getToolNames(server)

      expect(toolNames).toContain('get_diagnostics')
      expect(toolNames).toContain('get_hover')
      expect(toolNames).toContain('get_definition')
      expect(toolNames).toContain('find_references')
      expect(toolNames).toContain('document_symbols')
      expect(toolNames).toContain('workspace_symbols')
      expect(toolNames).toContain('go_to_implementation')
      expect(toolNames).toContain('incoming_calls')
      expect(toolNames).toContain('outgoing_calls')
      expect(toolNames.length).toBe(9)
    })

    it('should return a stopAll function', async () => {
      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { stopAll } = createLspServer(tmpDir)
      expect(typeof stopAll).toBe('function')

      await stopAll()
      expect(mockStopAll).toHaveBeenCalledOnce()
    })

    it('should register default server configs', async () => {
      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      createLspServer(tmpDir)
      expect(mockRegisterServer).toHaveBeenCalledOnce()
    })
  })

  // --------------------------------------------------------------------------
  // 2. get_diagnostics — kept as tsc --noEmit (real integration test)
  // --------------------------------------------------------------------------
  describe('get_diagnostics (tsc --noEmit)', () => {
    it('should find errors in a TypeScript file with type errors', async () => {
      writeFile(tmpDir, 'tsconfig.json', JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2020',
          module: 'ES2020',
          moduleResolution: 'node',
        },
        include: ['*.ts'],
      }))

      const filePath = writeFile(tmpDir, 'bad.ts', `
const x: number = "this is not a number"
`)

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'get_diagnostics', { file_path: filePath })

      const parsed = parseToolResult(result) as any
      expect(Array.isArray(parsed.diagnostics)).toBe(true)
      expect(parsed.diagnostics.length).toBeGreaterThan(0)

      const diag = parsed.diagnostics[0]
      expect(diag).toHaveProperty('file')
      expect(diag).toHaveProperty('line')
      expect(diag).toHaveProperty('column')
      expect(diag).toHaveProperty('severity')
      expect(diag).toHaveProperty('message')
    }, 30_000)

    it('should return empty array for valid file', async () => {
      writeFile(tmpDir, 'tsconfig.json', JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2020',
          module: 'ES2020',
          moduleResolution: 'node',
        },
        include: ['*.ts'],
      }))

      const filePath = writeFile(tmpDir, 'good.ts', `
const x: number = 42
export { x }
`)

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'get_diagnostics', { file_path: filePath })

      const parsed = parseToolResult(result) as any
      expect(parsed.diagnostics).toEqual([])
    }, 30_000)

    it('should handle non-existent file', async () => {
      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const fakePath = path.join(tmpDir, 'does-not-exist.ts')
      const result = await callTool(server, 'get_diagnostics', { file_path: fakePath })

      const parsed = parseToolResult(result) as any
      expect(parsed).toHaveProperty('error')
    }, 30_000)

    it('should return unsupported for non-TypeScript files', async () => {
      const filePath = writeFile(tmpDir, 'test.py', `x = "hello" + 42\n`)

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'get_diagnostics', { file_path: filePath })

      const parsed = parseToolResult(result) as any
      expect(parsed).toHaveProperty('error')
      expect(parsed.error).toContain('Unsupported language')
    })
  })

  // --------------------------------------------------------------------------
  // 3. get_hover — LSP textDocument/hover
  // --------------------------------------------------------------------------
  describe('get_hover', () => {
    it('should call LSP hover with correct params (1-based to 0-based conversion)', async () => {
      const filePath = writeFile(tmpDir, 'hover.ts', 'const x = 1')
      mockSendRequest.mockResolvedValueOnce({
        contents: { kind: 'markdown', value: 'const x: number' },
      })

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'get_hover', {
        file_path: filePath,
        line: 1,
        character: 7,
      })

      expect(mockSendRequest).toHaveBeenCalledWith(
        filePath,
        'textDocument/hover',
        {
          textDocument: { uri: `file://${filePath}` },
          position: { line: 0, character: 6 },
        },
      )

      const parsed = parseToolResult(result) as any
      expect(parsed.hover).toContain('const x: number')
    })

    it('should handle null hover result', async () => {
      const filePath = writeFile(tmpDir, 'empty.ts', '// just a comment')
      mockSendRequest.mockResolvedValueOnce(null)

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'get_hover', {
        file_path: filePath,
        line: 1,
        character: 1,
      })

      const parsed = parseToolResult(result) as any
      expect(parsed.hover).toBe('No hover information available')
    })

    it('should handle string hover contents', async () => {
      const filePath = writeFile(tmpDir, 'str.ts', 'const x = 1')
      mockSendRequest.mockResolvedValueOnce({
        contents: 'string content',
      })

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'get_hover', {
        file_path: filePath,
        line: 1,
        character: 7,
      })

      const parsed = parseToolResult(result) as any
      expect(parsed.hover).toContain('string content')
    })

    it('should handle array hover contents (MarkedString[])', async () => {
      const filePath = writeFile(tmpDir, 'arr.ts', 'const x = 1')
      mockSendRequest.mockResolvedValueOnce({
        contents: [
          { language: 'typescript', value: 'const x: number' },
          'A number variable',
        ],
      })

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'get_hover', {
        file_path: filePath,
        line: 1,
        character: 7,
      })

      const parsed = parseToolResult(result) as any
      expect(parsed.hover).toContain('const x: number')
      expect(parsed.hover).toContain('A number variable')
    })

    it('should handle LSP errors gracefully', async () => {
      const filePath = writeFile(tmpDir, 'err.ts', 'const x = 1')
      mockSendRequest.mockRejectedValueOnce(new Error('Server crashed'))

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'get_hover', {
        file_path: filePath,
        line: 1,
        character: 7,
      })

      const parsed = parseToolResult(result) as any
      expect(parsed).toHaveProperty('error')
      expect(parsed.error).toContain('Server crashed')
    })
  })

  // --------------------------------------------------------------------------
  // 4. get_definition — LSP textDocument/definition
  // --------------------------------------------------------------------------
  describe('get_definition', () => {
    it('should call LSP definition with correct params', async () => {
      const filePath = writeFile(tmpDir, 'def.ts', 'const x = 1\nx')
      mockSendRequest.mockResolvedValueOnce({
        uri: `file://${filePath}`,
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
      })

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'get_definition', {
        file_path: filePath,
        line: 2,
        character: 1,
      })

      expect(mockSendRequest).toHaveBeenCalledWith(
        filePath,
        'textDocument/definition',
        {
          textDocument: { uri: `file://${filePath}` },
          position: { line: 1, character: 0 },
        },
      )

      const parsed = parseToolResult(result) as any
      expect(parsed.definitions).toHaveLength(1)
      expect(parsed.definitions[0].file).toBe(filePath)
      expect(parsed.definitions[0].line).toBe(1)
      expect(parsed.definitions[0].column).toBe(7)
    })

    it('should handle array of locations', async () => {
      const filePath = writeFile(tmpDir, 'multi.ts', 'x')
      const otherFile = path.join(tmpDir, 'other.ts')
      mockSendRequest.mockResolvedValueOnce([
        {
          uri: `file://${filePath}`,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
        {
          uri: `file://${otherFile}`,
          range: { start: { line: 5, character: 10 }, end: { line: 5, character: 11 } },
        },
      ])

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'get_definition', {
        file_path: filePath,
        line: 1,
        character: 1,
      })

      const parsed = parseToolResult(result) as any
      expect(parsed.definitions).toHaveLength(2)
      expect(parsed.definitions[1].file).toBe(otherFile)
      expect(parsed.definitions[1].line).toBe(6)
      expect(parsed.definitions[1].column).toBe(11)
    })

    it('should handle null result', async () => {
      const filePath = writeFile(tmpDir, 'null.ts', 'x')
      mockSendRequest.mockResolvedValueOnce(null)

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'get_definition', {
        file_path: filePath,
        line: 1,
        character: 1,
      })

      const parsed = parseToolResult(result) as any
      expect(parsed.definitions).toEqual([])
    })
  })

  // --------------------------------------------------------------------------
  // 5. find_references — LSP textDocument/references
  // --------------------------------------------------------------------------
  describe('find_references', () => {
    it('should call LSP references with correct params', async () => {
      const filePath = writeFile(tmpDir, 'refs.ts', 'const x = 1\nx\nx')
      mockSendRequest.mockResolvedValueOnce([
        {
          uri: `file://${filePath}`,
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
        },
        {
          uri: `file://${filePath}`,
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
        },
      ])

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'find_references', {
        file_path: filePath,
        line: 1,
        character: 7,
        include_declaration: true,
      })

      expect(mockSendRequest).toHaveBeenCalledWith(
        filePath,
        'textDocument/references',
        {
          textDocument: { uri: `file://${filePath}` },
          position: { line: 0, character: 6 },
          context: { includeDeclaration: true },
        },
      )

      const parsed = parseToolResult(result) as any
      expect(parsed.references).toHaveLength(2)
    })

    it('should default include_declaration to false', async () => {
      const filePath = writeFile(tmpDir, 'refs2.ts', 'x')
      mockSendRequest.mockResolvedValueOnce([])

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      await callTool(server, 'find_references', {
        file_path: filePath,
        line: 1,
        character: 1,
      })

      expect(mockSendRequest).toHaveBeenCalledWith(
        filePath,
        'textDocument/references',
        expect.objectContaining({
          context: { includeDeclaration: false },
        }),
      )
    })
  })

  // --------------------------------------------------------------------------
  // 6. document_symbols — LSP textDocument/documentSymbol
  // --------------------------------------------------------------------------
  describe('document_symbols', () => {
    it('should call LSP documentSymbol and return symbols', async () => {
      const filePath = writeFile(tmpDir, 'syms.ts', 'function foo() {}')
      mockSendRequest.mockResolvedValueOnce([
        {
          name: 'foo',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 17 } },
          selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
          children: [],
        },
      ])

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'document_symbols', {
        file_path: filePath,
      })

      expect(mockSendRequest).toHaveBeenCalledWith(
        filePath,
        'textDocument/documentSymbol',
        {
          textDocument: { uri: `file://${filePath}` },
        },
      )

      const parsed = parseToolResult(result) as any
      expect(parsed.symbols).toHaveLength(1)
      expect(parsed.symbols[0].name).toBe('foo')
      expect(parsed.symbols[0].kind).toBe(12)
    })

    it('should handle null result', async () => {
      const filePath = writeFile(tmpDir, 'empty.ts', '')
      mockSendRequest.mockResolvedValueOnce(null)

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'document_symbols', {
        file_path: filePath,
      })

      const parsed = parseToolResult(result) as any
      expect(parsed.symbols).toEqual([])
    })
  })

  // --------------------------------------------------------------------------
  // 7. workspace_symbols — LSP workspace/symbol
  // --------------------------------------------------------------------------
  describe('workspace_symbols', () => {
    it('should call LSP workspace/symbol with query', async () => {
      mockSendRequest.mockResolvedValueOnce([
        {
          name: 'MyClass',
          kind: 5,
          location: {
            uri: `file://${tmpDir}/my-class.ts`,
            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
          },
        },
      ])

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'workspace_symbols', {
        query: 'MyClass',
      })

      // workspace_symbols uses a sentinel .ts file for routing
      expect(mockSendRequest).toHaveBeenCalledWith(
        expect.stringContaining('.ts'),
        'workspace/symbol',
        { query: 'MyClass' },
      )

      const parsed = parseToolResult(result) as any
      expect(parsed.symbols).toHaveLength(1)
      expect(parsed.symbols[0].name).toBe('MyClass')
      expect(parsed.symbols[0].kind).toBe(5)
      expect(parsed.symbols[0].file).toBe(`${tmpDir}/my-class.ts`)
    })
  })

  // --------------------------------------------------------------------------
  // 8. go_to_implementation — LSP textDocument/implementation
  // --------------------------------------------------------------------------
  describe('go_to_implementation', () => {
    it('should call LSP implementation with correct params', async () => {
      const filePath = writeFile(tmpDir, 'impl.ts', 'interface Foo {}\nclass Bar implements Foo {}')
      mockSendRequest.mockResolvedValueOnce([
        {
          uri: `file://${filePath}`,
          range: { start: { line: 1, character: 6 }, end: { line: 1, character: 9 } },
        },
      ])

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'go_to_implementation', {
        file_path: filePath,
        line: 1,
        character: 11,
      })

      expect(mockSendRequest).toHaveBeenCalledWith(
        filePath,
        'textDocument/implementation',
        {
          textDocument: { uri: `file://${filePath}` },
          position: { line: 0, character: 10 },
        },
      )

      const parsed = parseToolResult(result) as any
      expect(parsed.implementations).toHaveLength(1)
      expect(parsed.implementations[0].line).toBe(2)
      expect(parsed.implementations[0].column).toBe(7)
    })
  })

  // --------------------------------------------------------------------------
  // 9. incoming_calls — LSP prepareCallHierarchy + callHierarchy/incomingCalls
  // --------------------------------------------------------------------------
  describe('incoming_calls', () => {
    it('should call prepareCallHierarchy then incomingCalls', async () => {
      const filePath = writeFile(tmpDir, 'calls.ts', 'function foo() {}\nfunction bar() { foo() }')

      const prepareItem = {
        name: 'foo',
        kind: 12,
        uri: `file://${filePath}`,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 17 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
      }

      mockSendRequest
        .mockResolvedValueOnce([prepareItem])
        .mockResolvedValueOnce([
          {
            from: {
              name: 'bar',
              kind: 12,
              uri: `file://${filePath}`,
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 24 } },
              selectionRange: { start: { line: 1, character: 9 }, end: { line: 1, character: 12 } },
            },
            fromRanges: [
              { start: { line: 1, character: 17 }, end: { line: 1, character: 20 } },
            ],
          },
        ])

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'incoming_calls', {
        file_path: filePath,
        line: 1,
        character: 10,
      })

      // First call: prepareCallHierarchy
      expect(mockSendRequest).toHaveBeenNthCalledWith(
        1,
        filePath,
        'textDocument/prepareCallHierarchy',
        {
          textDocument: { uri: `file://${filePath}` },
          position: { line: 0, character: 9 },
        },
      )

      // Second call: incomingCalls with the prepared item
      expect(mockSendRequest).toHaveBeenNthCalledWith(
        2,
        filePath,
        'callHierarchy/incomingCalls',
        { item: prepareItem },
      )

      const parsed = parseToolResult(result) as any
      expect(parsed.callers).toHaveLength(1)
      expect(parsed.callers[0].name).toBe('bar')
      expect(parsed.callers[0].file).toBe(filePath)
    })

    it('should handle empty prepareCallHierarchy result', async () => {
      const filePath = writeFile(tmpDir, 'no-calls.ts', '// nothing')
      mockSendRequest.mockResolvedValueOnce(null)

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'incoming_calls', {
        file_path: filePath,
        line: 1,
        character: 1,
      })

      const parsed = parseToolResult(result) as any
      expect(parsed.callers).toEqual([])
    })
  })

  // --------------------------------------------------------------------------
  // 10. outgoing_calls — LSP prepareCallHierarchy + callHierarchy/outgoingCalls
  // --------------------------------------------------------------------------
  describe('outgoing_calls', () => {
    it('should call prepareCallHierarchy then outgoingCalls', async () => {
      const filePath = writeFile(tmpDir, 'out.ts', 'function foo() {}\nfunction bar() { foo() }')

      const prepareItem = {
        name: 'bar',
        kind: 12,
        uri: `file://${filePath}`,
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 24 } },
        selectionRange: { start: { line: 1, character: 9 }, end: { line: 1, character: 12 } },
      }

      mockSendRequest
        .mockResolvedValueOnce([prepareItem])
        .mockResolvedValueOnce([
          {
            to: {
              name: 'foo',
              kind: 12,
              uri: `file://${filePath}`,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 17 } },
              selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
            },
            fromRanges: [
              { start: { line: 1, character: 17 }, end: { line: 1, character: 20 } },
            ],
          },
        ])

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'outgoing_calls', {
        file_path: filePath,
        line: 2,
        character: 10,
      })

      expect(mockSendRequest).toHaveBeenNthCalledWith(
        2,
        filePath,
        'callHierarchy/outgoingCalls',
        { item: prepareItem },
      )

      const parsed = parseToolResult(result) as any
      expect(parsed.callees).toHaveLength(1)
      expect(parsed.callees[0].name).toBe('foo')
    })

    it('should handle empty prepareCallHierarchy result', async () => {
      const filePath = writeFile(tmpDir, 'no-out.ts', '// nothing')
      mockSendRequest.mockResolvedValueOnce([])

      const { createLspServer } = await import('../../src/mcp/lsp-server.js')
      const { server } = createLspServer(tmpDir)
      const result = await callTool(server, 'outgoing_calls', {
        file_path: filePath,
        line: 1,
        character: 1,
      })

      const parsed = parseToolResult(result) as any
      expect(parsed.callees).toEqual([])
    })
  })
})
