/**
 * LSP MCP Server -- Code intelligence tools
 *
 * Uses real LSP protocol via LspServerManager for hover, definition, references,
 * symbols, implementation, and call hierarchy. Diagnostics still use tsc --noEmit
 * (reliable and proven).
 *
 * Tools (9):
 *   get_diagnostics    -- tsc --noEmit (TypeScript only)
 *   get_hover          -- textDocument/hover
 *   get_definition     -- textDocument/definition
 *   find_references    -- textDocument/references
 *   document_symbols   -- textDocument/documentSymbol
 *   workspace_symbols  -- workspace/symbol
 *   go_to_implementation -- textDocument/implementation
 *   incoming_calls     -- prepareCallHierarchy + callHierarchy/incomingCalls
 *   outgoing_calls     -- prepareCallHierarchy + callHierarchy/outgoingCalls
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import {
  LspServerManager,
  getDefaultServerConfigs,
} from './lsp-server-manager.js'

// ============================================================================
// Types
// ============================================================================

interface Diagnostic {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly severity: 'error' | 'warning'
  readonly message: string
}

interface LspLocation {
  readonly uri: string
  readonly range: {
    readonly start: { readonly line: number; readonly character: number }
    readonly end: { readonly line: number; readonly character: number }
  }
}

interface LspCallHierarchyItem {
  readonly name: string
  readonly kind: number
  readonly uri: string
  readonly range: {
    readonly start: { readonly line: number; readonly character: number }
    readonly end: { readonly line: number; readonly character: number }
  }
  readonly selectionRange: {
    readonly start: { readonly line: number; readonly character: number }
    readonly end: { readonly line: number; readonly character: number }
  }
}

interface LspDocumentSymbol {
  readonly name: string
  readonly kind: number
  readonly range: {
    readonly start: { readonly line: number; readonly character: number }
    readonly end: { readonly line: number; readonly character: number }
  }
  readonly selectionRange: {
    readonly start: { readonly line: number; readonly character: number }
    readonly end: { readonly line: number; readonly character: number }
  }
  readonly children?: readonly LspDocumentSymbol[]
}

interface LspWorkspaceSymbol {
  readonly name: string
  readonly kind: number
  readonly location: LspLocation
}

// ============================================================================
// Coordinate conversion helpers
// ============================================================================

/** Convert 1-based user input to 0-based LSP position */
function toZeroBased(line: number, character: number): { line: number; character: number } {
  return { line: line - 1, character: character - 1 }
}

/** Convert 0-based LSP position to 1-based user output */
function toOneBased(line: number, character: number): { line: number; column: number } {
  return { line: line + 1, column: character + 1 }
}

/** Convert file:// URI to local file path */
function fileUriToPath(uri: string): string {
  return uri.replace(/^file:\/\//, '')
}

/** Convert local file path to file:// URI */
function pathToFileUri(filePath: string): string {
  return `file://${path.resolve(filePath)}`
}

// ============================================================================
// Result formatting helpers
// ============================================================================

function jsonResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  }
}

function errorResult(message: string): { content: Array<{ type: 'text'; text: string }> } {
  return jsonResult({ error: message })
}

/** Normalize LSP location(s) to a flat array */
function normalizeLocations(result: unknown): readonly LspLocation[] {
  if (!result) {
    return []
  }
  if (Array.isArray(result)) {
    return result as LspLocation[]
  }
  return [result as LspLocation]
}

/** Convert LSP location to user-facing format */
function formatLocation(loc: LspLocation): { file: string; line: number; column: number } {
  const pos = toOneBased(loc.range.start.line, loc.range.start.character)
  return {
    file: fileUriToPath(loc.uri),
    ...pos,
  }
}

/**
 * Extract text from LSP hover contents.
 * Handles: MarkupContent, string, MarkedString, MarkedString[]
 */
function extractHoverText(contents: unknown): string {
  if (!contents) {
    return ''
  }

  // MarkupContent: { kind, value }
  if (typeof contents === 'object' && 'value' in (contents as Record<string, unknown>)) {
    return (contents as { value: string }).value
  }

  // Plain string
  if (typeof contents === 'string') {
    return contents
  }

  // Array of MarkedString
  if (Array.isArray(contents)) {
    return contents
      .map((item) => {
        if (typeof item === 'string') {
          return item
        }
        if (typeof item === 'object' && item !== null && 'value' in item) {
          const lang = (item as { language?: string }).language
          const val = (item as { value: string }).value
          return lang ? `\`\`\`${lang}\n${val}\n\`\`\`` : val
        }
        return String(item)
      })
      .join('\n\n')
  }

  return String(contents)
}

/** Format document symbols (recursive tree) */
function formatDocumentSymbols(
  symbols: readonly LspDocumentSymbol[] | null,
): readonly unknown[] {
  if (!symbols) {
    return []
  }
  return symbols.map((sym) => ({
    name: sym.name,
    kind: sym.kind,
    range: {
      start: toOneBased(sym.range.start.line, sym.range.start.character),
      end: toOneBased(sym.range.end.line, sym.range.end.character),
    },
    ...(sym.children && sym.children.length > 0
      ? { children: formatDocumentSymbols(sym.children) }
      : {}),
  }))
}

// ============================================================================
// tsc --noEmit helpers (kept for diagnostics)
// ============================================================================

function runTscDiagnostics(filePath: string, cwd: string): Promise<Diagnostic[]> {
  return new Promise((resolve, reject) => {
    const tsconfigDir = findTsconfigDir(path.dirname(filePath), cwd)
    const tscArgs = ['--noEmit', '--pretty', 'false']
    if (tsconfigDir) {
      tscArgs.push('--project', path.join(tsconfigDir, 'tsconfig.json'))
    } else {
      tscArgs.push(filePath)
    }

    execFile('npx', ['tsc', ...tscArgs], { cwd, timeout: 20_000 }, (err, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '')
      if (err && !output) {
        reject(new Error(`tsc execution failed: ${err.message}`))
        return
      }
      const diagnostics = parseTscOutput(output, filePath)
      resolve(diagnostics)
    })
  })
}

function findTsconfigDir(startDir: string, stopDir: string): string | null {
  let dir = path.resolve(startDir)
  const stop = path.resolve(stopDir)

  while (true) {
    if (fs.existsSync(path.join(dir, 'tsconfig.json'))) {
      return dir
    }
    if (dir === stop || dir === path.dirname(dir)) {
      break
    }
    dir = path.dirname(dir)
  }
  return null
}

function parseTscOutput(output: string, targetFile: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const normalizedTarget = path.resolve(targetFile)
  const lines = output.split('\n')

  for (const line of lines) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/)
    if (!match) continue

    const [, file, lineStr, colStr, severity, message] = match
    const normalizedFile = path.resolve(file)

    if (normalizedFile !== normalizedTarget) continue

    diagnostics.push({
      file: normalizedFile,
      line: parseInt(lineStr, 10),
      column: parseInt(colStr, 10),
      severity: severity as 'error' | 'warning',
      message: message.trim(),
    })
  }

  return diagnostics
}

function isTypeScriptFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts'
}

// ============================================================================
// MCP Server Creation
// ============================================================================

export interface LspMcpServer {
  readonly server: McpServer
  readonly stopAll: () => Promise<void>
}

/**
 * Create an LSP MCP server that provides code intelligence tools.
 *
 * @param cwd - Working directory for running language tools
 * @returns server instance and stopAll cleanup function
 */
export function createLspServer(cwd: string): LspMcpServer {
  const manager = new LspServerManager(cwd)

  // Register default language server configs
  for (const config of getDefaultServerConfigs()) {
    manager.registerServer(config)
  }

  const server = new McpServer(
    { name: 'lsp', version: '2.0.0' },
  )

  // Sentinel file for workspace-level requests (needs a .ts file to route to TS server)
  const sentinelFile = path.join(cwd, '__lsp_sentinel__.ts')

  // ================================================================
  // 1. get_diagnostics -- TypeScript diagnostics via tsc --noEmit
  // ================================================================
  server.tool(
    'get_diagnostics',
    'Get diagnostics (errors/warnings) for a TypeScript file using tsc --noEmit. Returns structured diagnostic information.',
    {
      file_path: z.string().describe('Absolute path to the file to check'),
    },
    async (args) => {
      const filePath = path.resolve(args.file_path)

      if (!isTypeScriptFile(filePath)) {
        return errorResult(
          'Unsupported language: only TypeScript files (.ts, .tsx, .mts, .cts) are supported',
        )
      }

      if (!fs.existsSync(filePath)) {
        return errorResult(`File not found: ${filePath}`)
      }

      try {
        const diagnostics = await runTscDiagnostics(filePath, cwd)
        return jsonResult({ diagnostics })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`Diagnostics failed: ${message}`)
      }
    },
  )

  // ================================================================
  // 2. get_hover -- LSP textDocument/hover
  // ================================================================
  server.tool(
    'get_hover',
    'Get hover information (type info, documentation) for a symbol at a given position.',
    {
      file_path: z.string().describe('Absolute path to the file'),
      line: z.number().describe('Line number (1-based)'),
      character: z.number().describe('Character/column number (1-based)'),
    },
    async (args) => {
      const filePath = path.resolve(args.file_path)
      const position = toZeroBased(args.line, args.character)

      try {
        const result = await manager.sendRequest<{ contents: unknown } | null>(
          filePath,
          'textDocument/hover',
          {
            textDocument: { uri: pathToFileUri(filePath) },
            position,
          },
        )

        if (!result) {
          return jsonResult({ hover: 'No hover information available' })
        }

        const text = extractHoverText(result.contents)
        return jsonResult({ hover: text || 'No hover information available' })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`Hover failed: ${message}`)
      }
    },
  )

  // ================================================================
  // 3. get_definition -- LSP textDocument/definition
  // ================================================================
  server.tool(
    'get_definition',
    'Find the definition of a symbol at a given position.',
    {
      file_path: z.string().describe('Absolute path to the file'),
      line: z.number().describe('Line number (1-based)'),
      character: z.number().describe('Character/column number (1-based)'),
    },
    async (args) => {
      const filePath = path.resolve(args.file_path)
      const position = toZeroBased(args.line, args.character)

      try {
        const result = await manager.sendRequest<unknown>(
          filePath,
          'textDocument/definition',
          {
            textDocument: { uri: pathToFileUri(filePath) },
            position,
          },
        )

        const locations = normalizeLocations(result)
        return jsonResult({
          definitions: locations.map(formatLocation),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`Definition lookup failed: ${message}`)
      }
    },
  )

  // ================================================================
  // 4. find_references -- LSP textDocument/references
  // ================================================================
  server.tool(
    'find_references',
    'Find all references to a symbol at a given position.',
    {
      file_path: z.string().describe('Absolute path to the file'),
      line: z.number().describe('Line number (1-based)'),
      character: z.number().describe('Character/column number (1-based)'),
      include_declaration: z
        .boolean()
        .optional()
        .describe('Include the declaration in results (default: false)'),
    },
    async (args) => {
      const filePath = path.resolve(args.file_path)
      const position = toZeroBased(args.line, args.character)

      try {
        const result = await manager.sendRequest<LspLocation[] | null>(
          filePath,
          'textDocument/references',
          {
            textDocument: { uri: pathToFileUri(filePath) },
            position,
            context: { includeDeclaration: args.include_declaration ?? false },
          },
        )

        const locations = normalizeLocations(result)
        return jsonResult({
          references: locations.map(formatLocation),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`Find references failed: ${message}`)
      }
    },
  )

  // ================================================================
  // 5. document_symbols -- LSP textDocument/documentSymbol
  // ================================================================
  server.tool(
    'document_symbols',
    'List all symbols (functions, classes, variables, etc.) in a file.',
    {
      file_path: z.string().describe('Absolute path to the file'),
    },
    async (args) => {
      const filePath = path.resolve(args.file_path)

      try {
        const result = await manager.sendRequest<LspDocumentSymbol[] | null>(
          filePath,
          'textDocument/documentSymbol',
          {
            textDocument: { uri: pathToFileUri(filePath) },
          },
        )

        return jsonResult({
          symbols: formatDocumentSymbols(result),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`Document symbols failed: ${message}`)
      }
    },
  )

  // ================================================================
  // 6. workspace_symbols -- LSP workspace/symbol
  // ================================================================
  server.tool(
    'workspace_symbols',
    'Search for symbols across the entire workspace by name pattern.',
    {
      query: z.string().describe('Symbol name or pattern to search for'),
    },
    async (args) => {
      try {
        const result = await manager.sendRequest<LspWorkspaceSymbol[] | null>(
          sentinelFile,
          'workspace/symbol',
          { query: args.query },
        )

        const symbols = (result ?? []).map((sym) => ({
          name: sym.name,
          kind: sym.kind,
          file: fileUriToPath(sym.location.uri),
          range: {
            start: toOneBased(
              sym.location.range.start.line,
              sym.location.range.start.character,
            ),
            end: toOneBased(
              sym.location.range.end.line,
              sym.location.range.end.character,
            ),
          },
        }))

        return jsonResult({ symbols })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`Workspace symbols failed: ${message}`)
      }
    },
  )

  // ================================================================
  // 7. go_to_implementation -- LSP textDocument/implementation
  // ================================================================
  server.tool(
    'go_to_implementation',
    'Find implementations of an interface or abstract method.',
    {
      file_path: z.string().describe('Absolute path to the file'),
      line: z.number().describe('Line number (1-based)'),
      character: z.number().describe('Character/column number (1-based)'),
    },
    async (args) => {
      const filePath = path.resolve(args.file_path)
      const position = toZeroBased(args.line, args.character)

      try {
        const result = await manager.sendRequest<unknown>(
          filePath,
          'textDocument/implementation',
          {
            textDocument: { uri: pathToFileUri(filePath) },
            position,
          },
        )

        const locations = normalizeLocations(result)
        return jsonResult({
          implementations: locations.map(formatLocation),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`Go to implementation failed: ${message}`)
      }
    },
  )

  // ================================================================
  // 8. incoming_calls -- prepareCallHierarchy + callHierarchy/incomingCalls
  // ================================================================
  server.tool(
    'incoming_calls',
    'Find all callers of a function/method at a given position.',
    {
      file_path: z.string().describe('Absolute path to the file'),
      line: z.number().describe('Line number (1-based)'),
      character: z.number().describe('Character/column number (1-based)'),
    },
    async (args) => {
      const filePath = path.resolve(args.file_path)
      const position = toZeroBased(args.line, args.character)

      try {
        const prepareResult = await manager.sendRequest<LspCallHierarchyItem[] | null>(
          filePath,
          'textDocument/prepareCallHierarchy',
          {
            textDocument: { uri: pathToFileUri(filePath) },
            position,
          },
        )

        if (!prepareResult || prepareResult.length === 0) {
          return jsonResult({ callers: [] })
        }

        const incomingResult = await manager.sendRequest<
          Array<{ from: LspCallHierarchyItem; fromRanges: unknown[] }> | null
        >(
          filePath,
          'callHierarchy/incomingCalls',
          { item: prepareResult[0] },
        )

        const callers = (incomingResult ?? []).map((call) => ({
          name: call.from.name,
          kind: call.from.kind,
          file: fileUriToPath(call.from.uri),
          range: {
            start: toOneBased(
              call.from.range.start.line,
              call.from.range.start.character,
            ),
            end: toOneBased(
              call.from.range.end.line,
              call.from.range.end.character,
            ),
          },
        }))

        return jsonResult({ callers })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`Incoming calls failed: ${message}`)
      }
    },
  )

  // ================================================================
  // 9. outgoing_calls -- prepareCallHierarchy + callHierarchy/outgoingCalls
  // ================================================================
  server.tool(
    'outgoing_calls',
    'Find all functions/methods called by the function at a given position.',
    {
      file_path: z.string().describe('Absolute path to the file'),
      line: z.number().describe('Line number (1-based)'),
      character: z.number().describe('Character/column number (1-based)'),
    },
    async (args) => {
      const filePath = path.resolve(args.file_path)
      const position = toZeroBased(args.line, args.character)

      try {
        const prepareResult = await manager.sendRequest<LspCallHierarchyItem[] | null>(
          filePath,
          'textDocument/prepareCallHierarchy',
          {
            textDocument: { uri: pathToFileUri(filePath) },
            position,
          },
        )

        if (!prepareResult || prepareResult.length === 0) {
          return jsonResult({ callees: [] })
        }

        const outgoingResult = await manager.sendRequest<
          Array<{ to: LspCallHierarchyItem; fromRanges: unknown[] }> | null
        >(
          filePath,
          'callHierarchy/outgoingCalls',
          { item: prepareResult[0] },
        )

        const callees = (outgoingResult ?? []).map((call) => ({
          name: call.to.name,
          kind: call.to.kind,
          file: fileUriToPath(call.to.uri),
          range: {
            start: toOneBased(
              call.to.range.start.line,
              call.to.range.start.character,
            ),
            end: toOneBased(
              call.to.range.end.line,
              call.to.range.end.character,
            ),
          },
        }))

        return jsonResult({ callees })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`Outgoing calls failed: ${message}`)
      }
    },
  )

  return {
    server,
    stopAll: () => manager.stopAll(),
  }
}
