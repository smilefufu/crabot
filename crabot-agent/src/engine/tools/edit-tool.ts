import { readFileSync, writeFileSync } from 'fs'
import { resolve, isAbsolute } from 'path'
import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'

function findOccurrenceLines(content: string, search: string): ReadonlyArray<number> {
  const collect = (from: number, acc: ReadonlyArray<number>): ReadonlyArray<number> => {
    const index = content.indexOf(search, from)
    if (index === -1) {
      return acc
    }
    const lineNumber = content.substring(0, index).split('\n').length
    return collect(index + search.length, [...acc, lineNumber])
  }
  return collect(0, [])
}

export function createEditTool(cwd: string): ToolDefinition {
  return defineTool({
    name: 'Edit',
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
    call: async (input) => {
      const rawPath = input.file_path as string
      const oldString = input.old_string as string
      const newString = input.new_string as string
      const replaceAll = input.replace_all === true

      if (oldString === newString) {
        return { output: 'old_string must differ from new_string', isError: true }
      }

      const filePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)

      let content: string
      try {
        content = readFileSync(filePath, 'utf-8')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { output: `Failed to read file: ${message}`, isError: true }
      }

      const occurrenceLines = findOccurrenceLines(content, oldString)
      const count = occurrenceLines.length

      if (count === 0) {
        return { output: 'old_string not found in file', isError: true }
      }

      if (count > 1 && !replaceAll) {
        return {
          output: `old_string found ${count} times, use replace_all or provide more context`,
          isError: true,
        }
      }

      const modified = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString)

      try {
        writeFileSync(filePath, modified, 'utf-8')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { output: `Failed to write file: ${message}`, isError: true }
      }

      const lineList = occurrenceLines.join(', ')
      return {
        output: `Edited ${filePath}: replaced ${count} occurrence(s) at line(s) ${lineList}`,
        isError: false,
      }
    },
  })
}
