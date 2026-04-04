/**
 * LSP MCP Server — Code intelligence tools for Agent
 *
 * Phase 5: Pragmatic approach using `tsc --noEmit` for TypeScript diagnostics.
 * Hover and definition tools are stub implementations with TODOs for full LSP
 * integration in Phase 6+.
 *
 * Tools: get_diagnostics, get_hover, get_definition
 */

import { createMcpServer, type McpServer } from './mcp-helpers.js'
import { z } from 'zod/v4'
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

// ============================================================================
// Types
// ============================================================================

interface Diagnostic {
  file: string
  line: number
  column: number
  severity: 'error' | 'warning'
  message: string
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Run tsc --noEmit and parse the output into structured diagnostics.
 * Uses --pretty false for machine-readable output.
 *
 * tsc output format (--pretty false):
 *   file.ts(line,col): error TS1234: message text
 */
function runTscDiagnostics(filePath: string, cwd: string): Promise<Diagnostic[]> {
  return new Promise((resolve, reject) => {
    // Find tsconfig.json — walk up from file dir, falling back to cwd
    const tsconfigDir = findTsconfigDir(path.dirname(filePath), cwd)
    const tscArgs = ['--noEmit', '--pretty', 'false']
    if (tsconfigDir) {
      tscArgs.push('--project', path.join(tsconfigDir, 'tsconfig.json'))
    } else {
      // No tsconfig found; compile just the file
      tscArgs.push(filePath)
    }

    execFile('npx', ['tsc', ...tscArgs], { cwd, timeout: 20_000 }, (err, stdout, stderr) => {
      // tsc exits with code 2 when there are errors — that's expected
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

/**
 * Walk up from startDir looking for tsconfig.json, stopping at stopDir.
 */
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

/**
 * Parse tsc --pretty false output into Diagnostic objects.
 * Only returns diagnostics for the requested file.
 *
 * Format: file.ts(line,col): error TS1234: message text
 */
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

/**
 * Read a token at a given line/column from a file.
 * Returns the word (identifier) at that position.
 */
function readTokenAt(filePath: string, line: number, column: number): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    const targetLine = lines[line - 1]
    if (!targetLine) return null

    // Find word boundaries around the column
    const col = column - 1
    const wordPattern = /[\w$]/
    let start = col
    let end = col

    while (start > 0 && wordPattern.test(targetLine[start - 1])) {
      start--
    }
    while (end < targetLine.length && wordPattern.test(targetLine[end])) {
      end++
    }

    const token = targetLine.slice(start, end)
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

/**
 * Check if a file has a TypeScript extension.
 */
function isTypeScriptFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts'
}

// ============================================================================
// MCP Server Creation
// ============================================================================

/**
 * Create an LSP MCP server that provides code intelligence tools.
 *
 * @param cwd - Working directory for running language tools
 */
export function createLspServer(cwd: string): McpServer {
  const server = createMcpServer({ name: 'lsp', version: '1.0.0' })

  // ================================================================
  // 1. get_diagnostics — TypeScript diagnostics via tsc --noEmit
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
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'Unsupported language: only TypeScript files (.ts, .tsx, .mts, .cts) are supported' }),
          }],
        }
      }

      if (!fs.existsSync(filePath)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `File not found: ${filePath}` }),
          }],
        }
      }

      try {
        const diagnostics = await runTscDiagnostics(filePath, cwd)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ diagnostics }),
          }],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Diagnostics failed: ${message}` }),
          }],
        }
      }
    },
  )

  // ================================================================
  // 2. get_hover — Hover information for a symbol
  // TODO: Phase 6+ — full LSP integration for rich hover info
  // ================================================================
  server.tool(
    'get_hover',
    'Get hover information for a symbol at a given position. Phase 5: returns token and any tsc errors at that location.',
    {
      file_path: z.string().describe('Absolute path to the file'),
      line: z.number().describe('Line number (1-based)'),
      column: z.number().describe('Column number (1-based)'),
    },
    async (args) => {
      const filePath = path.resolve(args.file_path)

      if (!fs.existsSync(filePath)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ hover: 'No information available: file not found' }),
          }],
        }
      }

      const token = readTokenAt(filePath, args.line, args.column)

      if (!token) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ hover: 'No information available' }),
          }],
        }
      }

      // For TypeScript files, check for errors at this location
      if (isTypeScriptFile(filePath)) {
        try {
          const diagnostics = await runTscDiagnostics(filePath, cwd)
          const atLocation = diagnostics.filter(
            d => d.line === args.line,
          )
          if (atLocation.length > 0) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  hover: `Token: ${token}\nDiagnostics at line ${args.line}:\n${atLocation.map(d => `  ${d.severity}: ${d.message}`).join('\n')}`,
                }),
              }],
            }
          }
        } catch {
          // Fall through to basic response
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            hover: `Token: ${token}\n(Full type information requires LSP integration — TODO Phase 6+)`,
          }),
        }],
      }
    },
  )

  // ================================================================
  // 3. get_definition — Go to definition for a symbol
  // TODO: Phase 6+ — full LSP integration for accurate definition lookup
  // ================================================================
  server.tool(
    'get_definition',
    'Find the definition of a symbol at a given position. Phase 5: uses grep-based fallback search.',
    {
      file_path: z.string().describe('Absolute path to the file'),
      line: z.number().describe('Line number (1-based)'),
      column: z.number().describe('Column number (1-based)'),
    },
    async (args) => {
      const filePath = path.resolve(args.file_path)

      if (!fs.existsSync(filePath)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ definition: 'Definition not found: file does not exist' }),
          }],
        }
      }

      const token = readTokenAt(filePath, args.line, args.column)

      if (!token) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ definition: 'Definition not found: no token at position' }),
          }],
        }
      }

      // Search for definition patterns in the same file first
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        // Look for common definition patterns: function/const/let/var/class/interface/type declarations
        const defPatterns = [
          new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(token)}\\b`),
          new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(token)}\\b`),
          new RegExp(`^\\s*(?:export\\s+)?(?:class|interface|type|enum)\\s+${escapeRegExp(token)}\\b`),
        ]

        for (let i = 0; i < lines.length; i++) {
          for (const pattern of defPatterns) {
            if (pattern.test(lines[i])) {
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    definition: {
                      file: filePath,
                      line: i + 1,
                      column: lines[i].indexOf(token) + 1,
                    },
                  }),
                }],
              }
            }
          }
        }
      } catch {
        // Fall through
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            definition: `Definition not found for "${token}" (full LSP integration — TODO Phase 6+)`,
          }),
        }],
      }
    },
  )

  return server
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
