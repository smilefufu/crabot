import * as fs from 'fs/promises'
import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'
import { compressImage } from '../image-utils'
import { resolvePath } from './utils'
import { inferMediaType } from '../../agent/media-resolver'
import { FILE_UNCHANGED_STUB } from './file-read-state'
import type { FileReadState } from './file-read-state'

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

const SENSITIVE_PATH_PATTERNS = [
  /[/\\]data[/\\]admin[/\\]channel-configs[/\\]/,
  /[/\\]data[/\\]admin[/\\]model_providers[/\\]/,
]

function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some(p => p.test(filePath))
}

/**
 * @param fileReadState 可选的 task 级去重缓存。提供时启用 read dedup（见 file-read-state.ts）；
 *   不提供时退化为普通无状态 Read。仅 main worker 传入，subagent 不传。
 */
export function createReadTool(getCwd: () => string, fileReadState?: FileReadState): ToolDefinition {
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
      const filePath = resolvePath(getCwd(), input.file_path as string)

      // 敏感路徑守衛：禁止直接讀取渠道憑證文件
      if (isSensitivePath(filePath)) {
        return {
          output: '此路徑包含渠道憑證，禁止直接讀取。要讀取飛書文檔請使用 read_feishu_document 工具；要查看 channel 配置請通過 Admin Web 或 crabot CLI。',
          isError: true,
        }
      }

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

        // Read dedup：相同范围 + 磁盘 mtime 未变 → 返回 stub，不把整文件重复回灌进 context。
        // 截断读（truncated）不参与：是部分视图，全量读才安全。mtime 为准，文件被改过会自动失效。
        if (fileReadState && !truncated) {
          const prev = fileReadState.get(filePath)
          if (prev && prev.offset === offset && prev.limit === limit && prev.mtimeMs === stat.mtimeMs) {
            return { output: FILE_UNCHANGED_STUB, isError: false }
          }
        }

        const bytesToRead = truncated ? MAX_FILE_SIZE : fileSize

        const fileHandle = await fs.open(filePath, 'r')
        try {
          const buffer = Buffer.alloc(bytesToRead)
          await fileHandle.read(buffer, 0, bytesToRead, 0)

          if (containsNullBytes(buffer)) {
            return { output: 'Binary file, cannot display', isError: false }
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
            fileReadState?.set(filePath, { mtimeMs: stat.mtimeMs, offset, limit })
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
