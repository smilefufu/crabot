import { defineTool } from '../../engine/index.js'
import type { ToolCallResult, ToolDefinition } from '../../engine/index.js'
import type { ManagerKey } from '../types.js'
import {
  ManagerWorkboardStore,
  type ArchivedWorkboardItem,
  type WorkboardArchiveOutcome,
  type WorkboardItem,
  type WorkboardItemDraft,
} from '../workboard-store.js'

const ITEM_PROPERTIES = {
  title: { type: 'string', minLength: 1, maxLength: 200, description: '脱离当前对话也能独立理解的任务标题' },
  status: { type: 'string', enum: ['ready', 'in_progress', 'blocked'] },
  project_root: { type: 'string', description: '规范化后的项目根绝对路径；纯对话或跨项目事项可省略' },
  objective: { type: 'string', minLength: 1 },
  acceptance: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
  current_state: { type: 'string', minLength: 1, description: '面向人类和主控的当前结论，不是执行日志' },
  next_action: { type: 'string', minLength: 1 },
  blockers: { type: 'array', items: { type: 'string', minLength: 1 }, description: '只记录需要管理判断的阻塞' },
} as const

const ITEM_SCHEMA = {
  type: 'object',
  properties: ITEM_PROPERTIES,
  required: ['title', 'status', 'objective', 'acceptance', 'current_state', 'next_action', 'blockers'],
  additionalProperties: false,
} as const

function output(value: unknown): ToolCallResult {
  return { output: JSON.stringify(value), isError: false }
}

function failure(prefix: string, error: unknown): ToolCallResult {
  const message = error instanceof Error ? error.message : String(error)
  return { output: `${prefix} 失败: ${message}`, isError: true }
}

function positiveInteger(value: unknown, fallback: number, maximum: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${field} 必须是 1 至 ${maximum} 的整数`)
  }
  return value as number
}

function hasOnlyKeys(input: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key))
}

function stableSort(items: Array<WorkboardItem | ArchivedWorkboardItem>): Array<WorkboardItem | ArchivedWorkboardItem> {
  const statusOrder = { ready: 0, in_progress: 1, blocked: 2 } as const
  return [...items].sort((left, right) => {
    const statusDifference = statusOrder[left.status] - statusOrder[right.status]
    if (statusDifference !== 0) return statusDifference
    return left.title < right.title ? -1 : left.title > right.title ? 1 : 0
  })
}

function matchesQuery(item: WorkboardItem | ArchivedWorkboardItem, query: string): boolean {
  const needle = query.toLowerCase()
  return [item.title, item.objective, item.current_state, item.next_action, ...item.blockers]
    .some((value) => value.toLowerCase().includes(needle))
}

export function buildWorkboardTools(deps: {
  readonly store: ManagerWorkboardStore
  readonly managerKey: ManagerKey
}): ToolDefinition[] {
  const inspect = defineTool({
    name: 'inspect_workboard',
    description: '按需查看本会话任务板的当前任务项或归档终态快照。字面过滤只用于缩小候选，不判断任务是否相同。',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['active', 'archive'], description: '默认 active；归档必须显式选择 archive' },
        query: { type: 'string', description: '在标题、目标、当前状态、下一步和阻塞中做不区分大小写的字面过滤' },
        page: { type: 'integer', minimum: 1, description: '默认 1' },
        page_size: { type: 'integer', minimum: 1, maximum: 100, description: '默认 20，最大 100' },
      },
      additionalProperties: false,
    },
    isReadOnly: true,
    call: async (input): Promise<ToolCallResult> => {
      try {
        if (!hasOnlyKeys(input, ['view', 'query', 'page', 'page_size'])) throw new Error('包含未定义字段')
        const view = input.view ?? 'active'
        if (view !== 'active' && view !== 'archive') throw new Error('view 必须是 active 或 archive')
        if (input.query !== undefined && typeof input.query !== 'string') throw new Error('query 必须是字符串')
        const page = positiveInteger(input.page, 1, Number.MAX_SAFE_INTEGER, 'page')
        const pageSize = positiveInteger(input.page_size, 20, 100, 'page_size')
        const board = await deps.store.load(deps.managerKey)
        const source = view === 'active' ? board.active : board.archive
        const filtered = input.query === undefined
          ? source
          : source.filter((item) => matchesQuery(item, input.query as string))
        const sorted = stableSort(filtered)
        const offset = (page - 1) * pageSize
        const totalItems = sorted.length
        return output({
          view,
          items: sorted.slice(offset, offset + pageSize),
          active_count: board.active.length,
          archive_count: board.archive.length,
          pagination: {
            page,
            page_size: pageSize,
            total_items: totalItems,
            total_pages: Math.ceil(totalItems / pageSize),
          },
        })
      } catch (error) {
        return failure('inspect_workboard', error)
      }
    },
  })

  const change = defineTool({
    name: 'change_workboard',
    description: '创建、完整替换或归档本会话的任务项。创建前先查看当前任务板，根据标题和正文判断是否已有同一事项；已有时完整更新原任务项，只有确属新事项时才创建。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'revise', 'archive'] },
        current_title: { type: 'string', description: 'revise/archive 用当前标题精确定位' },
        item: ITEM_SCHEMA,
        archived_as: { type: 'string', enum: ['completed', 'abandoned'] },
      },
      required: ['action'],
      additionalProperties: false,
      oneOf: [
        {
          type: 'object',
          properties: { action: { const: 'create' }, item: ITEM_SCHEMA },
          required: ['action', 'item'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { action: { const: 'revise' }, current_title: { type: 'string' }, item: ITEM_SCHEMA },
          required: ['action', 'current_title', 'item'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            action: { const: 'archive' },
            current_title: { type: 'string' },
            archived_as: { type: 'string', enum: ['completed', 'abandoned'] },
          },
          required: ['action', 'current_title', 'archived_as'],
          additionalProperties: false,
        },
      ],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      try {
        if (input.action === 'create') {
          if (!hasOnlyKeys(input, ['action', 'item']) || input.item === undefined) throw new Error('create 参数不完整或含未定义字段')
          const result = await deps.store.create(deps.managerKey, input.item as WorkboardItemDraft)
          return output({ action: 'created', item: result.item, active_count: result.board.active.length, archive_count: result.board.archive.length })
        }
        if (input.action === 'revise') {
          if (!hasOnlyKeys(input, ['action', 'current_title', 'item']) || typeof input.current_title !== 'string' || input.item === undefined) {
            throw new Error('revise 参数不完整或含未定义字段')
          }
          const result = await deps.store.revise(deps.managerKey, input.current_title, input.item as WorkboardItemDraft)
          return output({ action: 'revised', item: result.item, active_count: result.board.active.length, archive_count: result.board.archive.length })
        }
        if (input.action === 'archive') {
          if (!hasOnlyKeys(input, ['action', 'current_title', 'archived_as']) || typeof input.current_title !== 'string') {
            throw new Error('archive 参数不完整或含未定义字段')
          }
          const result = await deps.store.archive(
            deps.managerKey,
            input.current_title,
            input.archived_as as WorkboardArchiveOutcome,
          )
          return output({ action: 'archived', item: result.item, active_count: result.board.active.length, archive_count: result.board.archive.length })
        }
        throw new Error('action 必须是 create、revise 或 archive')
      } catch (error) {
        return failure('change_workboard', error)
      }
    },
  })

  return [inspect, change]
}
