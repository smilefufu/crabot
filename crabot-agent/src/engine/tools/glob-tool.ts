import fg from 'fast-glob'
import { resolve, isAbsolute } from 'path'
import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'

const MAX_RESULTS = 200

export function createGlobTool(cwd: string): ToolDefinition {
  return defineTool({
    name: 'glob',
    description: 'Fast file pattern matching. Returns matching file paths sorted alphabetically.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files (e.g., "**/*.ts")' },
        path: { type: 'string', description: 'Base directory to search in. Defaults to working directory.' },
      },
      required: ['pattern'],
    },
    isReadOnly: true,
    permissionLevel: 'safe',
    call: async (input) => {
      const pattern = input.pattern as string
      const pathInput = input.path as string | undefined

      const resolvedPath = pathInput
        ? (isAbsolute(pathInput) ? pathInput : resolve(cwd, pathInput))
        : cwd

      try {
        const entries = await fg(pattern, {
          cwd: resolvedPath,
          dot: false,
          onlyFiles: true,
          ignore: ['**/node_modules/**', '**/.git/**'],
        })

        const sorted = [...entries].sort()

        if (sorted.length === 0) {
          return { output: `No files found matching pattern: ${pattern}`, isError: false }
        }

        const truncated = sorted.length > MAX_RESULTS
        const displayed = truncated ? sorted.slice(0, MAX_RESULTS) : sorted
        const lines = truncated
          ? [...displayed, `[...${sorted.length - MAX_RESULTS} more results truncated]`]
          : displayed

        return { output: lines.join('\n'), isError: false }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { output: `Glob error: ${message}`, isError: true }
      }
    },
  })
}
