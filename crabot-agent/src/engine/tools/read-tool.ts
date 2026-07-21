import * as fs from 'fs/promises'
import { createReadStream } from 'fs'
import * as readline from 'readline'
import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'
import { compressImage } from '../image-utils'
import { resolvePath } from './utils'
import { inferMediaType } from '../../agent/media-resolver'
import { FILE_UNCHANGED_STUB } from './file-read-state'
import type { FileReadState } from './file-read-state'

/** 单次返回字节上限（与 2000 行上限先到先截），超出部分用 offset 分页续读。 */
const MAX_OUTPUT_BYTES = 50 * 1024
/** 超过该大小的文件流式按行定位读取，不整文件入内存。 */
const STREAM_READ_THRESHOLD = 10 * 1024 * 1024
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

/**
 * 逐行累加格式化，累计字节超 MAX_OUTPUT_BYTES 即截断（不切断行）。
 * 未截断时产物与 formatLinesWithNumbers 完全一致。
 */
function formatLinesWithByteCap(
  lines: ReadonlyArray<string>,
  startLine: number,
): { text: string; truncated: boolean } {
  if (lines.length === 0) {
    return { text: '', truncated: false }
  }
  const totalDigits = String(startLine + lines.length).length
  const parts: string[] = []
  let bytes = 0
  for (let i = 0; i < lines.length; i++) {
    const part = `${formatLineNumber(startLine + i, totalDigits)}\t${lines[i]}`
    const partBytes = Buffer.byteLength(part, 'utf8') + 1 // + '\n'
    if (bytes + partBytes > MAX_OUTPUT_BYTES) {
      return { text: parts.join('\n'), truncated: true }
    }
    parts.push(part)
    bytes += partBytes
  }
  return { text: parts.join('\n'), truncated: false }
}

/** 字节截断提示：引导用 offset 分页续读。 */
function byteCapTruncatedMarker(fileSize: number): string {
  return `\n[...truncated: output capped at ${MAX_OUTPUT_BYTES} bytes (file is ${fileSize} bytes total). Use offset to continue reading.]`
}

/** 读取文件头部 n 字节（用于大文件的 binary 探测，不整文件入内存）。 */
async function readHeadBytes(filePath: string, n: number): Promise<Buffer> {
  const fileHandle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(n)
    const { bytesRead } = await fileHandle.read(buffer, 0, n, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await fileHandle.close()
  }
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

      // offset 归一化为非负整数：负数/小数/NaN 在流式（lineIdx < offset）与非流式
      //（lines.slice(offset)）两条路径下行为不一致（slice 负数会从尾部数），统一在入口收敛。
      const rawOffset = typeof input.offset === 'number' ? input.offset : 0
      const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
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

        // >10MB 大文件：流式按行定位读取，不整文件入内存。
        // 大文件必为部分视图（50KB 上限），不参与 read dedup。
        if (fileSize > STREAM_READ_THRESHOLD) {
          const head = await readHeadBytes(filePath, BINARY_CHECK_SIZE)
          if (containsNullBytes(head)) {
            return { output: 'Binary file, cannot display', isError: false }
          }

          const stream = createReadStream(filePath)
          const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
          const collected: string[] = []
          let bytes = 0
          let lineIdx = 0
          let byteTruncated = false
          try {
            for await (const line of rl) {
              if (lineIdx < offset) {
                lineIdx++
                continue
              }
              if (collected.length >= limit) {
                break
              }
              const lineBytes = Buffer.byteLength(line, 'utf8') + 16 // 行号前缀 + 换行余量
              if (bytes + lineBytes > MAX_OUTPUT_BYTES) {
                byteTruncated = true
                break
              }
              collected.push(line)
              bytes += lineBytes
              lineIdx++
            }
          } finally {
            rl.close()
            stream.destroy()
          }

          const formatted = formatLinesWithNumbers(collected, offset + 1)
          if (byteTruncated) {
            return { output: `${formatted}${byteCapTruncatedMarker(fileSize)}`, isError: false }
          }
          return { output: formatted, isError: false }
        }

        // Read dedup：相同范围 + 磁盘 mtime 未变 → 返回 stub，不把整文件重复回灌进 context。
        // mtime 为准，文件被改过会自动失效。字节截断读是部分视图，不进缓存（下方 set 处判断）。
        if (fileReadState) {
          const prev = fileReadState.get(filePath)
          if (prev && prev.offset === offset && prev.limit === limit && prev.mtimeMs === stat.mtimeMs) {
            return { output: FILE_UNCHANGED_STUB, isError: false }
          }
        }

        const fileHandle = await fs.open(filePath, 'r')
        try {
          const buffer = Buffer.alloc(fileSize)
          await fileHandle.read(buffer, 0, fileSize, 0)

          if (containsNullBytes(buffer)) {
            return { output: 'Binary file, cannot display', isError: false }
          }

          const text = buffer.toString('utf-8')
          const allLines = text.split('\n')
          const endsWithNewline =
            allLines.length > 0 && allLines[allLines.length - 1] === '' && text.endsWith('\n')
          const lines = endsWithNewline ? allLines.slice(0, -1) : allLines
          const selected = lines.slice(offset, offset + limit)
          const { text: formatted, truncated: byteTruncated } = formatLinesWithByteCap(selected, offset + 1)

          if (byteTruncated) {
            return { output: `${formatted}${byteCapTruncatedMarker(fileSize)}`, isError: false }
          }
          if (endsWithNewline) {
            fileReadState?.set(filePath, { mtimeMs: stat.mtimeMs, offset, limit })
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
