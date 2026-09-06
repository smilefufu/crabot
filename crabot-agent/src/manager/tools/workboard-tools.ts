import { defineTool } from '../../engine/index.js'
import type { ToolCallResult, ToolDefinition } from '../../engine/index.js'
import type { ManagerKey } from '../types.js'
import {
  ManagerWorkboardStore,
  workboardCounts,
  type ArchivedWorkboardItem,
  type WorkboardArchiveEntry,
  type WorkboardArchiveOutcome,
  type WorkboardItem,
  type WorkboardItemDraft,
  type WorkboardObjective,
  type WorkboardObjectiveDraft,
} from '../workboard-store.js'

const OBJECTIVE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200, description: '人类希望最终得到的结果' },
    completion_criteria: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'string', minLength: 1 },
      description: '用于判断目标是否达成的可观察结果',
    },
  },
  required: ['title', 'completion_criteria'],
  additionalProperties: false,
} as const

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200, description: '为所属目标推进的一件独立管理事项' },
    status: { type: 'string', enum: ['ready', 'in_progress', 'blocked'] },
    project_root: { type: 'string', description: '供编排执行器参考的规范化项目根绝对路径；可以省略' },
    current_judgement: { type: 'string', minLength: 1, description: '当前已确认的管理结论；待开始时可以省略' },
    next_action: { type: 'string', minLength: 1, description: '主控下一步要协调、判断或确认的动作' },
    blocker: { type: 'string', minLength: 1, description: '仅已阻塞时填写一个需要介入的主要阻塞' },
  },
  required: ['title', 'status', 'next_action'],
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortItems(items: ReadonlyArray<WorkboardItem>): WorkboardItem[] {
  const statusOrder = { ready: 0, in_progress: 1, blocked: 2 } as const
  return [...items].sort((left, right) => (
    statusOrder[left.status] - statusOrder[right.status] || compareText(left.title, right.title)
  ))
}

function sortObjectives(objectives: ReadonlyArray<WorkboardObjective>): WorkboardObjective[] {
  return [...objectives]
    .sort((left, right) => compareText(left.title, right.title))
    .map((objective) => ({ ...objective, work_items: sortItems(objective.work_items) }))
}

function sortArchive(entries: ReadonlyArray<WorkboardArchiveEntry>): WorkboardArchiveEntry[] {
  return [...entries].sort((left, right) => (
    compareText(right.archived_at, left.archived_at) || compareText(left.title, right.title)
  ))
}

function itemText(item: WorkboardItem): string[] {
  return [
    item.title,
    ...(item.project_root ? [item.project_root] : []),
    ...(item.current_judgement ? [item.current_judgement] : []),
    item.next_action,
    ...(item.blocker ? [item.blocker] : []),
  ]
}

function matchesObjective(objective: WorkboardObjective, needle: string): boolean {
  return [objective.title, ...objective.completion_criteria, ...objective.work_items.flatMap(itemText)]
    .some((value) => value.toLowerCase().includes(needle))
}

function matchesArchive(entry: WorkboardArchiveEntry, needle: string): boolean {
  const values = 'objective' in entry
    ? [...itemText(entry), entry.objective.title, ...entry.objective.completion_criteria]
    : [entry.title, ...entry.completion_criteria]
  return values.some((value) => value.toLowerCase().includes(needle))
}

function objectiveHeader(objective: WorkboardObjective): Omit<WorkboardObjective, 'work_items'> {
  const { work_items: _items, ...header } = objective
  return header
}

function pagination(page: number, pageSize: number, totalItems: number) {
  return {
    page,
    page_size: pageSize,
    total_items: totalItems,
    total_pages: Math.ceil(totalItems / pageSize),
  }
}

export function buildWorkboardTools(deps: {
  readonly store: ManagerWorkboardStore
  readonly managerKey: ManagerKey
}): ToolDefinition[] {
  const inspect = defineTool({
    name: 'inspect_workboard',
    description: '按需查看本会话的当前目标及其事项，或查看目标和事项的归档快照。字面过滤只缩小候选，不判断语义归属。',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['active', 'archive'], description: '默认 active；归档必须显式选择 archive' },
        query: { type: 'string', description: '在目标、完成条件和事项管理摘要中做不区分大小写的字面过滤' },
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
        const board = await deps.store.loadAdmin(deps.managerKey)
        const needle = typeof input.query === 'string' ? input.query.toLowerCase() : undefined
        const counts = workboardCounts(board)
        const offset = (page - 1) * pageSize

        if (view === 'active') {
          const filtered = needle === undefined
            ? board.objectives
            : board.objectives.filter((objective) => matchesObjective(objective, needle))
          const sorted = sortObjectives(filtered)
          const objectives = sorted.slice(offset, offset + pageSize)
          await deps.store.acknowledgeManagerRead(deps.managerKey, view, objectives, board.revision)
          return output({ view, objectives, counts, pagination: pagination(page, pageSize, sorted.length) })
        }

        const filtered = needle === undefined
          ? board.archive
          : board.archive.filter((entry) => matchesArchive(entry, needle))
        const sorted = sortArchive(filtered)
        const entries = sorted.slice(offset, offset + pageSize)
        await deps.store.acknowledgeManagerRead(deps.managerKey, view, entries, board.revision)
        return output({ view, entries, counts, pagination: pagination(page, pageSize, sorted.length) })
      } catch (error) {
        return failure('inspect_workboard', error)
      }
    },
  })

  const change = defineTool({
    name: 'change_workboard',
    description: '维护本会话需要持续共管的目标和事项。目标记录结果与完成条件，事项记录当前推进状态；修改不会自动操作 Worker，派发 Worker 不要求建项。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'create_objective', 'revise_objective', 'archive_objective',
            'create_work_item', 'revise_work_item', 'archive_work_item',
          ],
        },
        current_objective_title: { type: 'string', description: '用当前目标标题精确定位' },
        objective_title: { type: 'string', description: '新事项所属的当前目标标题' },
        current_work_item_title: { type: 'string', description: '用当前事项标题在所属目标内精确定位' },
        target_objective_title: { type: 'string', description: '修订后所属目标；不移动时仍填写当前目标标题' },
        objective: OBJECTIVE_SCHEMA,
        work_item: ITEM_SCHEMA,
        archived_as: { type: 'string', enum: ['completed', 'abandoned'] },
      },
      required: ['action'],
      additionalProperties: false,
      oneOf: [
        {
          type: 'object',
          properties: { action: { const: 'create_objective' }, objective: OBJECTIVE_SCHEMA },
          required: ['action', 'objective'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            action: { const: 'revise_objective' },
            current_objective_title: { type: 'string' },
            objective: OBJECTIVE_SCHEMA,
          },
          required: ['action', 'current_objective_title', 'objective'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            action: { const: 'archive_objective' },
            current_objective_title: { type: 'string' },
            archived_as: { type: 'string', enum: ['completed', 'abandoned'] },
          },
          required: ['action', 'current_objective_title', 'archived_as'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            action: { const: 'create_work_item' },
            objective_title: { type: 'string' },
            work_item: ITEM_SCHEMA,
          },
          required: ['action', 'objective_title', 'work_item'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            action: { const: 'revise_work_item' },
            current_objective_title: { type: 'string' },
            current_work_item_title: { type: 'string' },
            target_objective_title: { type: 'string' },
            work_item: ITEM_SCHEMA,
          },
          required: [
            'action', 'current_objective_title', 'current_work_item_title', 'target_objective_title', 'work_item',
          ],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            action: { const: 'archive_work_item' },
            current_objective_title: { type: 'string' },
            current_work_item_title: { type: 'string' },
            archived_as: { type: 'string', enum: ['completed', 'abandoned'] },
          },
          required: ['action', 'current_objective_title', 'current_work_item_title', 'archived_as'],
          additionalProperties: false,
        },
      ],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      try {
        if (input.action === 'create_objective') {
          if (!hasOnlyKeys(input, ['action', 'objective']) || input.objective === undefined) {
            throw new Error('create_objective 参数不完整或含未定义字段')
          }
          const result = await deps.store.createObjective(deps.managerKey, input.objective as WorkboardObjectiveDraft)
          return output({ action: 'objective_created', objective: objectiveHeader(result.value), counts: workboardCounts(result.board) })
        }
        if (input.action === 'revise_objective') {
          if (!hasOnlyKeys(input, ['action', 'current_objective_title', 'objective'])
            || typeof input.current_objective_title !== 'string' || input.objective === undefined) {
            throw new Error('revise_objective 参数不完整或含未定义字段')
          }
          const result = await deps.store.reviseObjective(
            deps.managerKey,
            input.current_objective_title,
            input.objective as WorkboardObjectiveDraft,
          )
          return output({ action: 'objective_revised', objective: objectiveHeader(result.value), counts: workboardCounts(result.board) })
        }
        if (input.action === 'archive_objective') {
          if (!hasOnlyKeys(input, ['action', 'current_objective_title', 'archived_as'])
            || typeof input.current_objective_title !== 'string') {
            throw new Error('archive_objective 参数不完整或含未定义字段')
          }
          const result = await deps.store.archiveObjective(
            deps.managerKey,
            input.current_objective_title,
            input.archived_as as WorkboardArchiveOutcome,
          )
          return output({ action: 'objective_archived', objective: result.value, counts: workboardCounts(result.board) })
        }
        if (input.action === 'create_work_item') {
          if (!hasOnlyKeys(input, ['action', 'objective_title', 'work_item'])
            || typeof input.objective_title !== 'string' || input.work_item === undefined) {
            throw new Error('create_work_item 参数不完整或含未定义字段')
          }
          const result = await deps.store.createWorkItem(
            deps.managerKey,
            input.objective_title,
            input.work_item as WorkboardItemDraft,
          )
          return output({
            action: 'work_item_created',
            objective_title: input.objective_title.trim(),
            work_item: result.value,
            counts: workboardCounts(result.board),
          })
        }
        if (input.action === 'revise_work_item') {
          if (!hasOnlyKeys(input, [
            'action', 'current_objective_title', 'current_work_item_title', 'target_objective_title', 'work_item',
          ]) || typeof input.current_objective_title !== 'string'
            || typeof input.current_work_item_title !== 'string'
            || typeof input.target_objective_title !== 'string'
            || input.work_item === undefined) {
            throw new Error('revise_work_item 参数不完整或含未定义字段')
          }
          const result = await deps.store.reviseWorkItem(
            deps.managerKey,
            input.current_objective_title,
            input.current_work_item_title,
            input.target_objective_title,
            input.work_item as WorkboardItemDraft,
          )
          return output({
            action: 'work_item_revised',
            objective_title: input.target_objective_title.trim(),
            work_item: result.value,
            counts: workboardCounts(result.board),
          })
        }
        if (input.action === 'archive_work_item') {
          if (!hasOnlyKeys(input, ['action', 'current_objective_title', 'current_work_item_title', 'archived_as'])
            || typeof input.current_objective_title !== 'string'
            || typeof input.current_work_item_title !== 'string') {
            throw new Error('archive_work_item 参数不完整或含未定义字段')
          }
          const result = await deps.store.archiveWorkItem(
            deps.managerKey,
            input.current_objective_title,
            input.current_work_item_title,
            input.archived_as as WorkboardArchiveOutcome,
          )
          return output({ action: 'work_item_archived', work_item: result.value, counts: workboardCounts(result.board) })
        }
        throw new Error('action 必须是六种目标或事项操作之一')
      } catch (error) {
        return failure('change_workboard', error)
      }
    },
  })

  return [inspect, change]
}
