import { defineTool } from '../tool-framework'
import { localHostToolExecutor } from '../local-host-tool-executor'
import type { ToolDefinition } from '../types'
import { resolvePath } from './utils'

export function createEditTool(getCwd: () => string): ToolDefinition {
  return defineTool({
    name: 'Edit',
    category: 'file_io',
    description: 'Performs exact string replacements in a file.',
    inputSchema: {
      type: 'object',
      required: ['file_path', 'old_string', 'new_string'],
      properties: {
        file_path: { type: 'string', description: 'Path to the file to edit' },
        old_string: { type: 'string', description: 'The text to replace' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
      },
      additionalProperties: false,
    },
    isReadOnly: false,
    permissionLevel: 'normal',
    async call(input, context) {
      return (await localHostToolExecutor.execute('edit', {
        file_path: resolvePath(getCwd(), input.file_path as string),
        old_string: input.old_string,
        new_string: input.new_string,
        replace_all: input.replace_all === true,
      }, getCwd(), context)).result
    },
  })
}
