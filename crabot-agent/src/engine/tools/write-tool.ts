import { defineTool } from '../tool-framework'
import { localHostToolExecutor } from '../local-host-tool-executor'
import type { ToolDefinition } from '../types'
import { resolvePath } from './utils'

export function createWriteTool(getCwd: () => string): ToolDefinition {
  return defineTool({
    name: 'Write',
    category: 'file_io',
    description: 'Writes content to a file. Creates parent directories if they do not exist. Overwrites the file if it already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The file path to write to (absolute or relative to working directory)' },
        content: { type: 'string', description: 'The content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
    isReadOnly: false,
    permissionLevel: 'normal',
    async call(input, context) {
      return (await localHostToolExecutor.execute('write', {
        file_path: resolvePath(getCwd(), input.file_path as string),
        content: input.content,
      }, getCwd(), context)).result
    },
  })
}
