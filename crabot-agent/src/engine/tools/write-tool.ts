import * as fs from 'fs/promises'
import * as path from 'path'
import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'

export function createWriteTool(cwd: string): ToolDefinition {
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
    call: async (input) => {
      const filePath = input.file_path as string
      const content = input.content as string

      const resolvedPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(cwd, filePath)

      try {
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
        await fs.writeFile(resolvedPath, content, 'utf-8')

        const byteCount = Buffer.byteLength(content, 'utf-8')
        return {
          output: `Successfully wrote ${byteCount} bytes to ${resolvedPath}`,
          isError: false,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: `Failed to write file: ${message}`,
          isError: true,
        }
      }
    },
  })
}
