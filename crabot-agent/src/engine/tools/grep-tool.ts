import { defineTool } from '../tool-framework'
import { localHostToolExecutor } from '../local-host-tool-executor'
import type { ToolDefinition } from '../types'
import { resolvePath } from './utils'

export function createGrepTool(getCwd: () => string): ToolDefinition {
  return defineTool({
    name: 'Grep',
    category: 'file_io',
    description: 'Search for regex patterns in files recursively (powered by ripgrep). Supports glob filtering, context lines, and multiple output modes.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory to search in (default: working directory)' },
        glob: { type: 'string', description: 'File filter pattern (e.g., "*.ts")' },
        output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'], description: 'Output format (default: files_with_matches)' },
        context: { type: 'number', description: 'Lines of context before/after match (content mode only)' },
        head_limit: { type: 'number', description: 'Maximum number of results (default: 250)' },
      },
      required: ['pattern'],
    },
    isReadOnly: true,
    permissionLevel: 'safe',
    async call(input, context) {
      const cwd = getCwd()
      return (await localHostToolExecutor.execute('grep', {
        pattern: input.pattern,
        path: typeof input.path === 'string' ? resolvePath(cwd, input.path) : cwd,
        glob: input.glob,
        output_mode: input.output_mode,
        context: input.context,
        head_limit: input.head_limit,
        calling_cwd: cwd,
      }, cwd, context)).result
    },
  })
}
