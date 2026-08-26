import { defineTool } from '../tool-framework'
import { localHostToolExecutor } from '../local-host-tool-executor'
import type { ToolDefinition } from '../types'
import { resolvePath } from './utils'

export function createGlobTool(getCwd: () => string): ToolDefinition {
  return defineTool({
    name: 'Glob',
    category: 'file_io',
    description: 'Fast file pattern matching (powered by ripgrep). Returns matching file paths sorted alphabetically.',
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
    async call(input, context) {
      const cwd = getCwd()
      return (await localHostToolExecutor.execute('glob', {
        pattern: input.pattern,
        path: typeof input.path === 'string' ? resolvePath(cwd, input.path) : cwd,
      }, cwd, context)).result
    },
  })
}
