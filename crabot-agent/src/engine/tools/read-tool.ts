import { defineTool } from '../tool-framework'
import { localHostToolExecutor } from '../local-host-tool-executor'
import type { ToolDefinition } from '../types'
import { resolvePath } from './utils'
import type { FileReadState } from './file-read-state'

const DEFAULT_LIMIT = 2000
const SENSITIVE_PATH_PATTERNS = [
  /[/\\]data[/\\]admin[/\\]channel-configs[/\\]/,
  /[/\\]data[/\\]admin[/\\]model_providers[/\\]/,
]

function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(filePath))
}

/** Parent-side Read only owns the task-local dedup ledger. */
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
        file_path: { type: 'string', description: 'Absolute or relative file path to read' },
        offset: { type: 'number', description: 'Start line (0-based, default 0)' },
        limit: { type: 'number', description: 'Max lines to read (default 2000)' },
      },
      required: ['file_path'],
    },
    isReadOnly: true,
    permissionLevel: 'safe',
    async call(input, context) {
      const filePath = resolvePath(getCwd(), input.file_path as string)
      if (isSensitivePath(filePath)) {
        return {
          output: '此路徑包含渠道憑證，禁止直接讀取。要讀取飛書文檔請使用 read_feishu_document 工具；要查看 channel 配置請通過 Admin Web 或 crabot CLI。',
          isError: true,
        }
      }
      const rawOffset = typeof input.offset === 'number' ? input.offset : 0
      const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
      const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(0, Math.floor(input.limit))
        : DEFAULT_LIMIT
      const previous = fileReadState?.get(filePath)
      const execution = await localHostToolExecutor.execute('read', {
        file_path: filePath,
        offset,
        limit,
        previous_read: previous ? { mtime_ms: previous.mtimeMs, offset: previous.offset, limit: previous.limit } : null,
      }, getCwd(), context)
      if (execution.effect) {
        fileReadState?.set(filePath, {
          mtimeMs: execution.effect.mtime_ms,
          offset: execution.effect.offset,
          limit: execution.effect.limit,
        })
      }
      return execution.result
    },
  })
}
