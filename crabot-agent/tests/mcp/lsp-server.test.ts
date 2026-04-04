import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createLspServer } from '../../src/mcp/lsp-server.js'
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
  // For tools with inputSchema, handler is called as handler(args, extra)
  const result = await Promise.resolve(tool.handler(args, {}))
  return result as { content: Array<{ type: string; text: string }> }
}

// ============================================================================
// Tests
// ============================================================================

describe('LSP MCP Server', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = getTempDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // --------------------------------------------------------------------------
  // 1. Server has expected tool names
  // --------------------------------------------------------------------------
  it('should register expected tools', () => {
    const server = createLspServer(tmpDir)
    const toolNames = getToolNames(server)
    expect(toolNames).toContain('get_diagnostics')
    expect(toolNames).toContain('get_hover')
    expect(toolNames).toContain('get_definition')
  })

  // --------------------------------------------------------------------------
  // 2. get_diagnostics finds errors in a TypeScript file with type errors
  // --------------------------------------------------------------------------
  it('get_diagnostics should find errors in a TypeScript file with type errors', async () => {
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

    const server = createLspServer(tmpDir)
    const result = await callTool(server, 'get_diagnostics', { file_path: filePath })

    const parsed = JSON.parse(result.content[0].text)
    expect(Array.isArray(parsed.diagnostics)).toBe(true)
    expect(parsed.diagnostics.length).toBeGreaterThan(0)

    const diag = parsed.diagnostics[0]
    expect(diag).toHaveProperty('file')
    expect(diag).toHaveProperty('line')
    expect(diag).toHaveProperty('column')
    expect(diag).toHaveProperty('severity')
    expect(diag).toHaveProperty('message')
  }, 30_000)

  // --------------------------------------------------------------------------
  // 3. get_diagnostics returns empty array for valid file
  // --------------------------------------------------------------------------
  it('get_diagnostics should return empty array for valid file', async () => {
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

    const server = createLspServer(tmpDir)
    const result = await callTool(server, 'get_diagnostics', { file_path: filePath })

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.diagnostics).toEqual([])
  }, 30_000)

  // --------------------------------------------------------------------------
  // 4. get_diagnostics handles non-existent file
  // --------------------------------------------------------------------------
  it('get_diagnostics should handle non-existent file', async () => {
    const server = createLspServer(tmpDir)
    const fakePath = path.join(tmpDir, 'does-not-exist.ts')
    const result = await callTool(server, 'get_diagnostics', { file_path: fakePath })

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toHaveProperty('error')
  }, 30_000)

  // --------------------------------------------------------------------------
  // 5. get_hover returns info (or stub message)
  // --------------------------------------------------------------------------
  it('get_hover should return info or stub message', async () => {
    const filePath = writeFile(tmpDir, 'hover.ts', `
const greeting: string = "hello"
console.log(greeting)
`)

    const server = createLspServer(tmpDir)
    const result = await callTool(server, 'get_hover', {
      file_path: filePath,
      line: 2,
      column: 7,
    })

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toHaveProperty('hover')
  }, 30_000)

  // --------------------------------------------------------------------------
  // 6. get_definition returns location (or stub message)
  // --------------------------------------------------------------------------
  it('get_definition should return location or stub message', async () => {
    const filePath = writeFile(tmpDir, 'def.ts', `
function greet(name: string) { return name }
greet("world")
`)

    const server = createLspServer(tmpDir)
    const result = await callTool(server, 'get_definition', {
      file_path: filePath,
      line: 3,
      column: 1,
    })

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toHaveProperty('definition')
  }, 30_000)

  // --------------------------------------------------------------------------
  // 7. get_diagnostics returns unsupported for non-TypeScript files
  // --------------------------------------------------------------------------
  it('get_diagnostics should return unsupported for non-TypeScript files', async () => {
    const filePath = writeFile(tmpDir, 'test.py', `
x = "hello" + 42
`)

    const server = createLspServer(tmpDir)
    const result = await callTool(server, 'get_diagnostics', { file_path: filePath })

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toHaveProperty('error')
    expect(parsed.error).toContain('Unsupported language')
  })
})
