import * as fs from 'fs/promises'
import * as path from 'path'
import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'
import { compressImage } from '../image-utils'
import { inferMediaType } from '../../agent/media-resolver'

const MAX_FILE_SIZE = 500 * 1024
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20MB

function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTENSIONS.has(ext)
}
const DEFAULT_LIMIT = 2000
const BINARY_CHECK_SIZE = 8192

function formatLineNumber(lineNum: number, totalDigits: number): string {
  return String(lineNum).padStart(totalDigits, ' ')
}

function formatLinesWithNumbers(lines: ReadonlyArray<string>, startLine: number): string {
  if (lines.length === 0) {
    return ''
  }
  const lastLineNum = startLine + lines.length
  const totalDigits = String(lastLineNum).length
  return lines
    .map((line, i) => `${formatLineNumber(startLine + i, totalDigits)}\t${line}`)
    .join('\n')
}

function containsNullBytes(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, BINARY_CHECK_SIZE)
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0x00) {
      return true
    }
  }
  return false
}

export function createReadTool(cwd: string): ToolDefinition {
  return defineTool({
    name: 'Read',
    category: 'file_io',
    description:
      'Reads a file from the filesystem. Returns content with line numbers. ' +
      'Supports offset (0-based start line) and limit (max lines to read, default 2000).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or relative file path to read',
        },
        offset: {
          type: 'number',
          description: 'Start line (0-based, default 0)',
        },
        limit: {
          type: 'number',
          description: 'Max lines to read (default 2000)',
        },
      },
      required: ['file_path'],
    },
    isReadOnly: true,
    permissionLevel: 'safe',

    async call(input) {
      const filePath = path.isAbsolute(input.file_path as string)
        ? (input.file_path as string)
        : path.resolve(cwd, input.file_path as string)

      const offset = typeof input.offset === 'number' ? input.offset : 0
      const limit = typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT

      try {
        const stat = await fs.stat(filePath)
        const fileSize = stat.size

        if (fileSize === 0) {
          return { output: '', isError: false }
        }

        // Image file detection — return as ImageBlock before text processing
        if (isImageFile(filePath)) {
          if (fileSize > MAX_IMAGE_SIZE) {
            return {
              output: `[Image too large: ${filePath}, ${fileSize} bytes]`,
              isError: false,
            }
          }
          const imageBuffer = await fs.readFile(filePath)
          const rawImageData = {
            media_type: inferMediaType(undefined, filePath),
            data: imageBuffer.toString('base64'),
          }
          const compressed = await compressImage(rawImageData)
          return {
            output: `[Image: ${filePath}, ${fileSize} bytes]`,
            isError: false,
            images: [compressed],
          }
        }

        const truncated = fileSize > MAX_FILE_SIZE
        const bytesToRead = truncated ? MAX_FILE_SIZE : fileSize

        const fileHandle = await fs.open(filePath, 'r')
        try {
          const buffer = Buffer.alloc(bytesToRead)
          await fileHandle.read(buffer, 0, bytesToRead, 0)

          if (containsNullBytes(buffer)) {
            return { output: 'Binary file, cannot display', isError: true }
          }

          const text = buffer.toString('utf-8')
          const allLines = text.split('\n')

          // Remove trailing empty line from split if file ends with newline
          if (allLines.length > 0 && allLines[allLines.length - 1] === '' && text.endsWith('\n')) {
            const sliced = allLines.slice(0, -1)
            const selected = sliced.slice(offset, offset + limit)
            const formatted = formatLinesWithNumbers(selected, offset + 1)

            if (truncated) {
              return {
                output: `${formatted}\n[...truncated, file is ${fileSize} bytes]`,
                isError: false,
              }
            }
            return { output: formatted, isError: false }
          }

          const selected = allLines.slice(offset, offset + limit)
          const formatted = formatLinesWithNumbers(selected, offset + 1)

          if (truncated) {
            return {
              output: `${formatted}\n[...truncated, file is ${fileSize} bytes]`,
              isError: false,
            }
          }
          return { output: formatted, isError: false }
        } finally {
          await fileHandle.close()
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { output: `Error reading file: ${message}`, isError: true }
      }
    },
  })
}
