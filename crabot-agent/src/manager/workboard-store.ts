import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { AsyncMutex } from '../workers/async-mutex.js'
import { decodeSegment, encodeSegment, isManagerKey } from '../workers/harness/ledger-store.js'
import type { ManagerKey } from './types.js'

const WORKBOARD_FILE = 'workboard.json'
const MAX_ENTRY_BYTES = 32 * 1024

export type WorkboardItemStatus = 'ready' | 'in_progress' | 'blocked'
export type WorkboardArchiveOutcome = 'completed' | 'abandoned'
export type WorkboardView = 'active' | 'archive'

export interface WorkboardObjectiveDraft {
  readonly title: string
  readonly completion_criteria: string[]
}

export interface WorkboardItemDraft {
  readonly title: string
  readonly status: WorkboardItemStatus
  readonly project_root?: string
  readonly current_judgement?: string
  readonly next_action: string
  readonly blocker?: string
}

export interface WorkboardItem extends WorkboardItemDraft {
  readonly updated_at: string
}

export interface WorkboardObjective extends WorkboardObjectiveDraft {
  readonly work_items: WorkboardItem[]
  readonly updated_at: string
}

export interface ArchivedWorkboardItem extends WorkboardItem {
  readonly objective: WorkboardObjectiveDraft
  readonly archived_as: WorkboardArchiveOutcome
  readonly archived_at: string
}

export interface ArchivedWorkboardObjective extends WorkboardObjectiveDraft {
  readonly archived_as: WorkboardArchiveOutcome
  readonly archived_at: string
}

export type WorkboardArchiveEntry = ArchivedWorkboardItem | ArchivedWorkboardObjective

/** Manager tools only receive this projection; schema/revision are Store implementation details. */
export interface ManagerWorkboard {
  readonly manager_key: ManagerKey
  readonly objectives: WorkboardObjective[]
  readonly archive: WorkboardArchiveEntry[]
}

export interface ManagerWorkboardAdminView extends ManagerWorkboard {
  readonly revision: number
}

export interface WorkboardCounts {
  readonly current_objectives: number
  readonly current_work_items: number
  readonly blocked_work_items: number
  readonly archive_entries: number
}

export interface PendingAdminWorkboardNotice {
  readonly revision: number
  readonly created_at: string
  readonly attempts: number
  readonly retry_after_at?: string
}

interface WorkboardLocation {
  readonly objective_title: string
  readonly work_item_title?: string
}

interface AdminWorkboardReadFence {
  readonly revision: number
  readonly view: WorkboardView
  readonly locations: WorkboardLocation[]
}

interface InternalBoard extends ManagerWorkboardAdminView {
  readonly schema_version: 3
  readonly pending_admin_notice?: PendingAdminWorkboardNotice
  readonly admin_read_fences?: AdminWorkboardReadFence[]
}

type WorkboardMutationValue = WorkboardObjective | WorkboardItem | WorkboardArchiveEntry

export interface WorkboardMutationResult<T extends WorkboardMutationValue> {
  readonly board: ManagerWorkboard
  readonly value: T
}

export interface AdminWorkboardMutationResult<T extends WorkboardMutationValue> {
  readonly board: ManagerWorkboardAdminView
  readonly value: T
  readonly notice: PendingAdminWorkboardNotice
}

interface BoardChange<T extends WorkboardMutationValue> {
  readonly board: InternalBoard
  readonly value: T
}

interface AdminBoardChange<T extends WorkboardMutationValue> extends BoardChange<T> {
  readonly fence: Omit<AdminWorkboardReadFence, 'revision'>
  readonly merge_fence_from?: WorkboardLocation
}

export class WorkboardRevisionConflictError extends Error {
  readonly code = 'WORKBOARD_REVISION_CONFLICT'

  constructor(readonly currentRevision: number) {
    super(`任务板 revision 已变化（当前为 ${currentRevision}）`)
    this.name = 'WorkboardRevisionConflictError'
  }
}

/** Admin mutation data is syntactically valid but cannot be applied to the current board. */
export class WorkboardValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkboardValidationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new Error(`${label} 包含未定义字段: ${unexpected.join(', ')}`)
}

function normalizedString(value: unknown, field: string, persisted: boolean): string {
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  const result = value.trim()
  if (result.length === 0) throw new Error(`${field} 不得为空`)
  if (persisted && result !== value) throw new Error(`${field} 不是规范化字符串`)
  return result
}

function normalizedTitle(value: unknown, field: string, persisted: boolean): string {
  const result = normalizedString(value, field, persisted)
  if (Array.from(result).length > 200) throw new Error(`${field} 必须为 1 至 200 个 Unicode 字符`)
  return result
}

function normalizedStringList(
  value: unknown,
  field: string,
  persisted: boolean,
  minimum: number,
  maximum: number,
): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`)
  if (value.length < minimum || value.length > maximum) {
    throw new Error(`${field} 必须包含 ${minimum} 至 ${maximum} 项`)
  }
  return value.map((entry, index) => normalizedString(entry, `${field}[${index}]`, persisted))
}

function normalizedProjectRoot(value: unknown, persisted: boolean): string | undefined {
  if (value === undefined) return undefined
  const result = normalizedString(value, 'project_root', persisted)
  if (result.includes('\0') || !path.isAbsolute(result) || path.normalize(result) !== result) {
    throw new Error('project_root 必须是规范化后的绝对路径')
  }
  return result
}

function assertTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} 必须是合法时间戳`)
  }
  return value
}

function assertRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('revision 必须是非负安全整数')
  }
  return value
}

function assertEntrySize(value: unknown, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf-8') > MAX_ENTRY_BYTES) {
    throw new Error(`${label}序列化后不得超过 32 KiB`)
  }
}

function normalizeObjectiveDraft(value: unknown, persisted: boolean): WorkboardObjectiveDraft {
  if (!isRecord(value)) throw new Error('目标必须是对象')
  assertOnlyKeys(value, ['title', 'completion_criteria'], '目标')
  return {
    title: normalizedTitle(value.title, '目标 title', persisted),
    completion_criteria: normalizedStringList(value.completion_criteria, 'completion_criteria', persisted, 1, 5),
  }
}

function normalizeItemDraft(value: unknown, persisted: boolean): WorkboardItemDraft {
  if (!isRecord(value)) throw new Error('事项必须是对象')
  assertOnlyKeys(value, ['title', 'status', 'project_root', 'current_judgement', 'next_action', 'blocker'], '事项')
  if (value.status !== 'ready' && value.status !== 'in_progress' && value.status !== 'blocked') {
    throw new Error('status 必须是 ready、in_progress 或 blocked')
  }

  const currentJudgement = value.current_judgement === undefined
    ? undefined
    : normalizedString(value.current_judgement, 'current_judgement', persisted)
  if (value.status !== 'ready' && currentJudgement === undefined) {
    throw new Error(`${value.status} 事项必须包含 current_judgement`)
  }
  const blocker = value.blocker === undefined ? undefined : normalizedString(value.blocker, 'blocker', persisted)
  if (value.status === 'blocked' && blocker === undefined) throw new Error('blocked 事项必须包含 blocker')
  if (value.status !== 'blocked' && blocker !== undefined) throw new Error('只有 blocked 事项可以包含 blocker')
  const projectRoot = normalizedProjectRoot(value.project_root, persisted)

  return {
    title: normalizedTitle(value.title, '事项 title', persisted),
    status: value.status,
    ...(projectRoot !== undefined ? { project_root: projectRoot } : {}),
    ...(currentJudgement !== undefined ? { current_judgement: currentJudgement } : {}),
    next_action: normalizedString(value.next_action, 'next_action', persisted),
    ...(blocker !== undefined ? { blocker } : {}),
  }
}

function normalizePersistedItem(value: unknown): WorkboardItem {
  if (!isRecord(value)) throw new Error('事项必须是对象')
  const draft = normalizeItemDraft(
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'updated_at')),
    true,
  )
  const expectedKeys = [
    'title', 'status', 'next_action', 'updated_at',
    ...(value.project_root === undefined ? [] : ['project_root']),
    ...(value.current_judgement === undefined ? [] : ['current_judgement']),
    ...(value.blocker === undefined ? [] : ['blocker']),
  ]
  assertOnlyKeys(value, expectedKeys, '当前事项')
  const result = { ...draft, updated_at: assertTimestamp(value.updated_at, 'updated_at') }
  assertEntrySize(result, '事项')
  return result
}

function normalizePersistedObjective(value: unknown): WorkboardObjective {
  if (!isRecord(value)) throw new Error('目标必须是对象')
  const draft = normalizeObjectiveDraft({ title: value.title, completion_criteria: value.completion_criteria }, true)
  assertOnlyKeys(value, ['title', 'completion_criteria', 'work_items', 'updated_at'], '当前目标')
  if (!Array.isArray(value.work_items)) throw new Error('work_items 必须是数组')
  const workItems = value.work_items.map(normalizePersistedItem)
  const titles = new Set<string>()
  for (const item of workItems) {
    if (titles.has(item.title)) throw new Error(`目标内事项标题重复: ${item.title}`)
    titles.add(item.title)
  }
  const result: WorkboardObjective = {
    ...draft,
    work_items: workItems,
    updated_at: assertTimestamp(value.updated_at, 'updated_at'),
  }
  assertEntrySize({ ...draft, updated_at: result.updated_at }, '目标')
  return result
}

function normalizeArchiveOutcome(value: unknown): WorkboardArchiveOutcome {
  if (value !== 'completed' && value !== 'abandoned') {
    throw new Error('archived_as 必须是 completed 或 abandoned')
  }
  return value
}

function normalizeArchivedItem(value: Record<string, unknown>): ArchivedWorkboardItem {
  const draftValue = Object.fromEntries(
    Object.entries(value).filter(([key]) => !['updated_at', 'objective', 'archived_as', 'archived_at'].includes(key)),
  )
  const item = normalizeItemDraft(draftValue, true)
  const expectedKeys = [
    'title', 'status', 'next_action', 'updated_at', 'objective', 'archived_as', 'archived_at',
    ...(value.project_root === undefined ? [] : ['project_root']),
    ...(value.current_judgement === undefined ? [] : ['current_judgement']),
    ...(value.blocker === undefined ? [] : ['blocker']),
  ]
  assertOnlyKeys(value, expectedKeys, '归档事项')
  const result: ArchivedWorkboardItem = {
    ...item,
    updated_at: assertTimestamp(value.updated_at, 'updated_at'),
    objective: normalizeObjectiveDraft(value.objective, true),
    archived_as: normalizeArchiveOutcome(value.archived_as),
    archived_at: assertTimestamp(value.archived_at, 'archived_at'),
  }
  assertEntrySize(result, '归档条目')
  return result
}

function normalizeArchivedObjective(value: Record<string, unknown>): ArchivedWorkboardObjective {
  assertOnlyKeys(value, ['title', 'completion_criteria', 'archived_as', 'archived_at'], '归档目标')
  const result: ArchivedWorkboardObjective = {
    ...normalizeObjectiveDraft({ title: value.title, completion_criteria: value.completion_criteria }, true),
    archived_as: normalizeArchiveOutcome(value.archived_as),
    archived_at: assertTimestamp(value.archived_at, 'archived_at'),
  }
  assertEntrySize(result, '归档条目')
  return result
}

function normalizeArchiveEntry(value: unknown): WorkboardArchiveEntry {
  if (!isRecord(value)) throw new Error('归档条目必须是对象')
  if (value.status !== undefined || value.objective !== undefined) return normalizeArchivedItem(value)
  if (value.completion_criteria !== undefined) return normalizeArchivedObjective(value)
  throw new Error('归档条目类型非法')
}

function normalizeNotice(value: unknown): PendingAdminWorkboardNotice {
  if (!isRecord(value)) throw new Error('pending_admin_notice 非法')
  assertOnlyKeys(value, ['revision', 'created_at', 'attempts', 'retry_after_at'], 'pending_admin_notice')
  if (typeof value.attempts !== 'number' || !Number.isSafeInteger(value.attempts) || value.attempts < 0) {
    throw new Error('pending_admin_notice attempts 非法')
  }
  const retryAfter = value.retry_after_at === undefined ? undefined : assertTimestamp(value.retry_after_at, 'retry_after_at')
  return {
    revision: assertRevision(value.revision),
    created_at: assertTimestamp(value.created_at, 'created_at'),
    attempts: value.attempts,
    ...(retryAfter ? { retry_after_at: retryAfter } : {}),
  }
}

function normalizeLocation(value: unknown): WorkboardLocation {
  if (!isRecord(value)) throw new Error('任务板位置非法')
  assertOnlyKeys(value, ['objective_title', 'work_item_title'], '任务板位置')
  const workItemTitle = value.work_item_title === undefined
    ? undefined
    : normalizedTitle(value.work_item_title, 'work_item_title', true)
  return {
    objective_title: normalizedTitle(value.objective_title, 'objective_title', true),
    ...(workItemTitle !== undefined ? { work_item_title: workItemTitle } : {}),
  }
}

function locationKey(location: WorkboardLocation): string {
  return JSON.stringify([location.objective_title, location.work_item_title ?? null])
}

function normalizeFence(value: unknown): AdminWorkboardReadFence {
  if (!isRecord(value)) throw new Error('admin_read_fence 非法')
  assertOnlyKeys(value, ['revision', 'view', 'locations'], 'admin_read_fence')
  if (value.view !== 'active' && value.view !== 'archive') throw new Error('admin_read_fence view 非法')
  if (!Array.isArray(value.locations) || value.locations.length === 0) {
    throw new Error('admin_read_fence.locations 至少包含一项')
  }
  const locations = value.locations.map(normalizeLocation)
  if (new Set(locations.map(locationKey)).size !== locations.length) {
    throw new Error('admin_read_fence.locations 重复')
  }
  const itemLevel = locations[0].work_item_title !== undefined
  if (locations.some((location) => (location.work_item_title !== undefined) !== itemLevel)) {
    throw new Error('admin_read_fence 不能混合目标和事项位置')
  }
  return { revision: assertRevision(value.revision), view: value.view, locations }
}

function currentFenceLocation(fence: Pick<AdminWorkboardReadFence, 'locations'>): WorkboardLocation {
  return fence.locations[fence.locations.length - 1]
}

function sameFenceRecord(left: AdminWorkboardReadFence, right: AdminWorkboardReadFence): boolean {
  return left.revision === right.revision
    && left.view === right.view
    && left.locations.length === right.locations.length
    && left.locations.every((location, index) => locationKey(location) === locationKey(right.locations[index]))
}

function locationsWithCurrentLast(
  locations: ReadonlyArray<WorkboardLocation>,
  current: WorkboardLocation,
): WorkboardLocation[] {
  const currentKey = locationKey(current)
  const unique = new Map<string, WorkboardLocation>()
  for (const location of locations) {
    const key = locationKey(location)
    if (key !== currentKey) unique.set(key, location)
  }
  return [...unique.values(), current]
}

function emptyBoard(key: ManagerKey): InternalBoard {
  return { schema_version: 3, manager_key: key, revision: 0, objectives: [], archive: [] }
}

function validateBoard(value: unknown, key: ManagerKey): InternalBoard {
  if (!isRecord(value)) throw new Error('任务板 shape 非法')
  if (value.schema_version !== 3) throw new Error(`未知 schema_version: ${String(value.schema_version)}`)
  assertOnlyKeys(
    value,
    ['schema_version', 'manager_key', 'revision', 'objectives', 'archive', 'pending_admin_notice', 'admin_read_fences'],
    '任务板',
  )
  if (value.manager_key !== key) throw new Error(`manager_key 不匹配: ${String(value.manager_key)}`)
  if (!Array.isArray(value.objectives) || !Array.isArray(value.archive)) {
    throw new Error('任务板 objectives/archive 必须是数组')
  }
  const objectives = value.objectives.map(normalizePersistedObjective)
  const titles = new Set<string>()
  for (const objective of objectives) {
    if (titles.has(objective.title)) throw new Error(`当前目标标题重复: ${objective.title}`)
    titles.add(objective.title)
  }
  const notice = value.pending_admin_notice === undefined ? undefined : normalizeNotice(value.pending_admin_notice)
  const fences = value.admin_read_fences === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(value.admin_read_fences)) throw new Error('admin_read_fences 必须是数组')
        const normalized = value.admin_read_fences.map(normalizeFence)
        for (let index = 0; index < normalized.length; index++) {
          if (normalized.slice(0, index).some((candidate) => sameFenceRecord(candidate, normalized[index]))) {
            throw new Error('admin_read_fences 不能有重复记录')
          }
        }
        return normalized
      })()
  const board: InternalBoard = {
    schema_version: 3,
    manager_key: key,
    revision: assertRevision(value.revision),
    objectives,
    archive: value.archive.map(normalizeArchiveEntry),
    ...(notice ? { pending_admin_notice: notice } : {}),
    ...(fences && fences.length > 0 ? { admin_read_fences: fences } : {}),
  }
  for (const fence of fences ?? []) {
    if (fence.revision > board.revision) throw new Error('admin_read_fence revision 超前')
  }
  return board
}

function managerProjection(board: InternalBoard): ManagerWorkboard {
  return { manager_key: board.manager_key, objectives: board.objectives, archive: board.archive }
}

function adminProjection(board: InternalBoard): ManagerWorkboardAdminView {
  return { ...managerProjection(board), revision: board.revision }
}

export function workboardCounts(board: Pick<ManagerWorkboard, 'objectives' | 'archive'>): WorkboardCounts {
  const items = board.objectives.flatMap((objective) => objective.work_items)
  return {
    current_objectives: board.objectives.length,
    current_work_items: items.length,
    blocked_work_items: items.filter((item) => item.status === 'blocked').length,
    archive_entries: board.archive.length,
  }
}

function objectiveLocation(title: string): WorkboardLocation {
  return { objective_title: title }
}

function itemLocation(objectiveTitle: string, itemTitle: string): WorkboardLocation {
  return { objective_title: objectiveTitle, work_item_title: itemTitle }
}

function locationConflicts(left: WorkboardLocation, right: WorkboardLocation): boolean {
  if (left.objective_title !== right.objective_title) return false
  return left.work_item_title === undefined
    || right.work_item_title === undefined
    || left.work_item_title === right.work_item_title
}

function visibleLocations(view: WorkboardView, entries: ReadonlyArray<WorkboardObjective | WorkboardArchiveEntry>): WorkboardLocation[] {
  if (view === 'active') {
    return entries.flatMap((entry) => {
      if (!('work_items' in entry)) return []
      return [
        objectiveLocation(entry.title),
        ...entry.work_items.map((item) => itemLocation(entry.title, item.title)),
      ]
    })
  }
  return entries.flatMap((entry) => (
    'objective' in entry
      ? [itemLocation(entry.objective.title, entry.title)]
      : [objectiveLocation(entry.title)]
  ))
}

function addObjectiveAlias(
  fences: ReadonlyArray<AdminWorkboardReadFence> | undefined,
  currentTitle: string,
  nextTitle: string,
): AdminWorkboardReadFence[] | undefined {
  if (!fences || currentTitle === nextTitle) return fences ? [...fences] : undefined
  return fences.map((fence) => {
    const current = currentFenceLocation(fence)
    if (fence.view !== 'active' || current.objective_title !== currentTitle) return fence
    const additions = fence.locations.flatMap((location) => (
      location.objective_title === currentTitle
        ? [{ ...location, objective_title: nextTitle }]
        : []
    ))
    const nextCurrent = { ...current, objective_title: nextTitle }
    return { ...fence, locations: locationsWithCurrentLast([...fence.locations, ...additions], nextCurrent) }
  })
}

export class ManagerWorkboardStore {
  private readonly mutexes = new Map<ManagerKey, AsyncMutex>()

  constructor(
    private readonly managersDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async load(key: ManagerKey): Promise<ManagerWorkboard> {
    this.assertKey(key)
    return this.mutexFor(key).run(async () => managerProjection(await this.readUnlocked(key)))
  }

  async loadAdmin(key: ManagerKey): Promise<ManagerWorkboardAdminView> {
    this.assertKey(key)
    return this.mutexFor(key).run(async () => adminProjection(await this.readUnlocked(key)))
  }

  async createObjective(key: ManagerKey, value: WorkboardObjectiveDraft): Promise<WorkboardMutationResult<WorkboardObjective>> {
    const draft = normalizeObjectiveDraft(value, false)
    return this.managerMutate(key, (board) => {
      this.assertNoUnreadFence(board, [objectiveLocation(draft.title)])
      return this.createObjectiveChange(board, draft)
    })
  }

  async reviseObjective(
    key: ManagerKey,
    currentTitle: string,
    value: WorkboardObjectiveDraft,
  ): Promise<WorkboardMutationResult<WorkboardObjective>> {
    const target = normalizedTitle(currentTitle, 'current_objective_title', false)
    const draft = normalizeObjectiveDraft(value, false)
    return this.managerMutate(key, (board) => {
      this.assertNoUnreadObjectiveFence(board, [target, draft.title])
      return this.reviseObjectiveChange(board, target, draft)
    })
  }

  async archiveObjective(
    key: ManagerKey,
    currentTitle: string,
    archivedAs: WorkboardArchiveOutcome,
  ): Promise<WorkboardMutationResult<ArchivedWorkboardObjective>> {
    const target = normalizedTitle(currentTitle, 'current_objective_title', false)
    const outcome = normalizeArchiveOutcome(archivedAs)
    return this.managerMutate(key, (board) => {
      this.assertNoUnreadObjectiveFence(board, [target])
      return this.archiveObjectiveChange(board, target, outcome)
    })
  }

  async createWorkItem(
    key: ManagerKey,
    objectiveTitle: string,
    value: WorkboardItemDraft,
  ): Promise<WorkboardMutationResult<WorkboardItem>> {
    const target = normalizedTitle(objectiveTitle, 'objective_title', false)
    const draft = normalizeItemDraft(value, false)
    return this.managerMutate(key, (board) => {
      this.assertNoUnreadFence(board, [itemLocation(target, draft.title)])
      return this.createWorkItemChange(board, target, draft)
    })
  }

  async reviseWorkItem(
    key: ManagerKey,
    currentObjectiveTitle: string,
    currentWorkItemTitle: string,
    targetObjectiveTitle: string,
    value: WorkboardItemDraft,
  ): Promise<WorkboardMutationResult<WorkboardItem>> {
    const currentObjective = normalizedTitle(currentObjectiveTitle, 'current_objective_title', false)
    const currentItem = normalizedTitle(currentWorkItemTitle, 'current_work_item_title', false)
    const targetObjective = normalizedTitle(targetObjectiveTitle, 'target_objective_title', false)
    const draft = normalizeItemDraft(value, false)
    return this.managerMutate(key, (board) => {
      this.assertNoUnreadFence(board, [
        itemLocation(currentObjective, currentItem),
        itemLocation(targetObjective, draft.title),
      ])
      return this.reviseWorkItemChange(board, currentObjective, currentItem, targetObjective, draft)
    })
  }

  async archiveWorkItem(
    key: ManagerKey,
    currentObjectiveTitle: string,
    currentWorkItemTitle: string,
    archivedAs: WorkboardArchiveOutcome,
  ): Promise<WorkboardMutationResult<ArchivedWorkboardItem>> {
    const objectiveTitle = normalizedTitle(currentObjectiveTitle, 'current_objective_title', false)
    const itemTitle = normalizedTitle(currentWorkItemTitle, 'current_work_item_title', false)
    const outcome = normalizeArchiveOutcome(archivedAs)
    return this.managerMutate(key, (board) => {
      this.assertNoUnreadFence(board, [itemLocation(objectiveTitle, itemTitle)])
      return this.archiveWorkItemChange(board, objectiveTitle, itemTitle, outcome)
    })
  }

  async adminCreateObjective(
    key: ManagerKey,
    expectedRevision: number,
    value: WorkboardObjectiveDraft,
  ): Promise<AdminWorkboardMutationResult<WorkboardObjective>> {
    return this.adminMutate(key, expectedRevision, (board) => {
      const draft = normalizeObjectiveDraft(value, false)
      return { ...this.createObjectiveChange(board, draft), fence: { view: 'active', locations: [objectiveLocation(draft.title)] } }
    })
  }

  async adminReviseObjective(
    key: ManagerKey,
    expectedRevision: number,
    currentTitle: string,
    value: WorkboardObjectiveDraft,
  ): Promise<AdminWorkboardMutationResult<WorkboardObjective>> {
    return this.adminMutate(key, expectedRevision, (board) => {
      const target = normalizedTitle(currentTitle, 'current_objective_title', false)
      const draft = normalizeObjectiveDraft(value, false)
      return {
        ...this.reviseObjectiveChange(board, target, draft),
        fence: { view: 'active', locations: [objectiveLocation(target), objectiveLocation(draft.title)] },
        merge_fence_from: objectiveLocation(target),
      }
    })
  }

  async adminArchiveObjective(
    key: ManagerKey,
    expectedRevision: number,
    currentTitle: string,
    archivedAs: WorkboardArchiveOutcome,
  ): Promise<AdminWorkboardMutationResult<ArchivedWorkboardObjective>> {
    return this.adminMutate(key, expectedRevision, (board) => {
      const target = normalizedTitle(currentTitle, 'current_objective_title', false)
      return {
        ...this.archiveObjectiveChange(board, target, normalizeArchiveOutcome(archivedAs)),
        fence: { view: 'archive', locations: [objectiveLocation(target)] },
        merge_fence_from: objectiveLocation(target),
      }
    })
  }

  async adminCreateWorkItem(
    key: ManagerKey,
    expectedRevision: number,
    objectiveTitle: string,
    value: WorkboardItemDraft,
  ): Promise<AdminWorkboardMutationResult<WorkboardItem>> {
    return this.adminMutate(key, expectedRevision, (board) => {
      const target = normalizedTitle(objectiveTitle, 'objective_title', false)
      const draft = normalizeItemDraft(value, false)
      return {
        ...this.createWorkItemChange(board, target, draft),
        fence: { view: 'active', locations: [itemLocation(target, draft.title)] },
      }
    })
  }

  async adminReviseWorkItem(
    key: ManagerKey,
    expectedRevision: number,
    currentObjectiveTitle: string,
    currentWorkItemTitle: string,
    targetObjectiveTitle: string,
    value: WorkboardItemDraft,
  ): Promise<AdminWorkboardMutationResult<WorkboardItem>> {
    return this.adminMutate(key, expectedRevision, (board) => {
      const currentObjective = normalizedTitle(currentObjectiveTitle, 'current_objective_title', false)
      const currentItem = normalizedTitle(currentWorkItemTitle, 'current_work_item_title', false)
      const targetObjective = normalizedTitle(targetObjectiveTitle, 'target_objective_title', false)
      const draft = normalizeItemDraft(value, false)
      return {
        ...this.reviseWorkItemChange(board, currentObjective, currentItem, targetObjective, draft),
        fence: {
          view: 'active',
          locations: [itemLocation(currentObjective, currentItem), itemLocation(targetObjective, draft.title)],
        },
        merge_fence_from: itemLocation(currentObjective, currentItem),
      }
    })
  }

  async adminArchiveWorkItem(
    key: ManagerKey,
    expectedRevision: number,
    currentObjectiveTitle: string,
    currentWorkItemTitle: string,
    archivedAs: WorkboardArchiveOutcome,
  ): Promise<AdminWorkboardMutationResult<ArchivedWorkboardItem>> {
    return this.adminMutate(key, expectedRevision, (board) => {
      const objectiveTitle = normalizedTitle(currentObjectiveTitle, 'current_objective_title', false)
      const itemTitle = normalizedTitle(currentWorkItemTitle, 'current_work_item_title', false)
      return {
        ...this.archiveWorkItemChange(board, objectiveTitle, itemTitle, normalizeArchiveOutcome(archivedAs)),
        fence: { view: 'archive', locations: [itemLocation(objectiveTitle, itemTitle)] },
        merge_fence_from: itemLocation(objectiveTitle, itemTitle),
      }
    })
  }

  /** A Manager can only clear a fence it actually observed in a tool result. */
  async acknowledgeManagerRead(
    key: ManagerKey,
    view: WorkboardView,
    visibleEntries: ReadonlyArray<WorkboardObjective | WorkboardArchiveEntry>,
    observedRevision: number,
  ): Promise<void> {
    this.assertKey(key)
    assertRevision(observedRevision)
    const visible = new Set(visibleLocations(view, visibleEntries).map(locationKey))
    if (visible.size === 0) return
    await this.mutexFor(key).run(async () => {
      const board = await this.readUnlocked(key)
      const fences = board.admin_read_fences ?? []
      let changed = false
      const remaining = fences.flatMap((fence) => {
        if (fence.revision > observedRevision || fence.view !== view) return [fence]
        const current = currentFenceLocation(fence)
        if (visible.has(locationKey(current))) {
          changed = true
          return []
        }
        const locations = fence.locations.filter((location) => !visible.has(locationKey(location)))
        if (locations.length === fence.locations.length) return [fence]
        changed = true
        return [{ ...fence, locations }]
      })
      if (!changed) return
      const { admin_read_fences: _fences, ...withoutFences } = board
      await this.writeUnlocked(key, remaining.length > 0 ? { ...withoutFences, admin_read_fences: remaining } : withoutFences)
    })
  }

  async pendingAdminNotice(key: ManagerKey): Promise<PendingAdminWorkboardNotice | undefined> {
    this.assertKey(key)
    return this.mutexFor(key).run(async () => (await this.readUnlocked(key)).pending_admin_notice)
  }

  async listPendingAdminNotices(): Promise<Array<{ manager_key: ManagerKey; notice: PendingAdminWorkboardNotice }>> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(this.managersDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const keys = entries.flatMap((entry) => {
      if (!entry.isDirectory()) return []
      try {
        const key = decodeSegment(entry.name)
        return isManagerKey(key) && encodeSegment(key) === entry.name ? [key] : []
      } catch {
        return []
      }
    })
    const pending = await Promise.all(keys.map(async (key) => ({ manager_key: key, notice: await this.pendingAdminNotice(key) })))
    return pending.flatMap((entry) => entry.notice ? [{ manager_key: entry.manager_key, notice: entry.notice }] : [])
  }

  async recordAdminNoticeAttempt(key: ManagerKey, revision: number, retryAfterAt?: string): Promise<void> {
    this.assertKey(key)
    await this.mutexFor(key).run(async () => {
      const board = await this.readUnlocked(key)
      const notice = board.pending_admin_notice
      if (!notice || notice.revision !== revision) return
      await this.writeUnlocked(key, {
        ...board,
        pending_admin_notice: {
          ...notice,
          attempts: notice.attempts + 1,
          ...(retryAfterAt ? { retry_after_at: assertTimestamp(retryAfterAt, 'retry_after_at') } : {}),
        },
      })
    })
  }

  async clearAdminNoticeIfCurrent(key: ManagerKey, revision: number): Promise<boolean> {
    this.assertKey(key)
    return this.mutexFor(key).run(async () => {
      const board = await this.readUnlocked(key)
      if (board.pending_admin_notice?.revision !== revision) return false
      const { pending_admin_notice: _notice, ...withoutNotice } = board
      await this.writeUnlocked(key, withoutNotice)
      return true
    })
  }

  private createObjectiveChange(board: InternalBoard, draft: WorkboardObjectiveDraft): BoardChange<WorkboardObjective> {
    if (board.objectives.some((objective) => objective.title === draft.title)) {
      throw new Error(`当前目标标题重复: ${draft.title}`)
    }
    const timestamp = this.now()
    const objective: WorkboardObjective = { ...draft, work_items: [], updated_at: timestamp }
    assertEntrySize({ ...draft, updated_at: timestamp }, '目标')
    return { board: { ...board, objectives: [...board.objectives, objective] }, value: objective }
  }

  private reviseObjectiveChange(
    board: InternalBoard,
    currentTitle: string,
    draft: WorkboardObjectiveDraft,
  ): BoardChange<WorkboardObjective> {
    const index = this.uniqueObjectiveIndex(board, currentTitle)
    if (board.objectives.some((objective, candidateIndex) => candidateIndex !== index && objective.title === draft.title)) {
      throw new Error(`当前目标标题重复: ${draft.title}`)
    }
    const objective: WorkboardObjective = {
      ...draft,
      work_items: board.objectives[index].work_items,
      updated_at: this.now(),
    }
    assertEntrySize({ ...draft, updated_at: objective.updated_at }, '目标')
    const objectives = [...board.objectives]
    objectives[index] = objective
    const fences = addObjectiveAlias(board.admin_read_fences, currentTitle, draft.title)
    const { admin_read_fences: _fences, ...withoutFences } = board
    return {
      board: { ...withoutFences, objectives, ...(fences && fences.length > 0 ? { admin_read_fences: fences } : {}) },
      value: objective,
    }
  }

  private archiveObjectiveChange(
    board: InternalBoard,
    currentTitle: string,
    archivedAs: WorkboardArchiveOutcome,
  ): BoardChange<ArchivedWorkboardObjective> {
    const index = this.uniqueObjectiveIndex(board, currentTitle)
    const current = board.objectives[index]
    if (current.work_items.length > 0) throw new Error(`目标仍有当前事项，不能归档: ${currentTitle}`)
    const objective: ArchivedWorkboardObjective = {
      title: current.title,
      completion_criteria: current.completion_criteria,
      archived_as: archivedAs,
      archived_at: this.now(),
    }
    assertEntrySize(objective, '归档条目')
    return {
      board: {
        ...board,
        objectives: board.objectives.filter((_, candidateIndex) => candidateIndex !== index),
        archive: [...board.archive, objective],
      },
      value: objective,
    }
  }

  private createWorkItemChange(
    board: InternalBoard,
    objectiveTitle: string,
    draft: WorkboardItemDraft,
  ): BoardChange<WorkboardItem> {
    const objectiveIndex = this.uniqueObjectiveIndex(board, objectiveTitle)
    const currentObjective = board.objectives[objectiveIndex]
    if (currentObjective.work_items.some((item) => item.title === draft.title)) {
      throw new Error(`目标内事项标题重复: ${draft.title}`)
    }
    const timestamp = this.now()
    const item: WorkboardItem = { ...draft, updated_at: timestamp }
    assertEntrySize(item, '事项')
    const objectives = [...board.objectives]
    objectives[objectiveIndex] = {
      ...currentObjective,
      work_items: [...currentObjective.work_items, item],
      updated_at: timestamp,
    }
    return { board: { ...board, objectives }, value: item }
  }

  private reviseWorkItemChange(
    board: InternalBoard,
    currentObjectiveTitle: string,
    currentItemTitle: string,
    targetObjectiveTitle: string,
    draft: WorkboardItemDraft,
  ): BoardChange<WorkboardItem> {
    const sourceIndex = this.uniqueObjectiveIndex(board, currentObjectiveTitle)
    const targetIndex = this.uniqueObjectiveIndex(board, targetObjectiveTitle)
    const source = board.objectives[sourceIndex]
    const itemIndex = this.uniqueWorkItemIndex(source, currentItemTitle)
    const target = board.objectives[targetIndex]
    if (target.work_items.some((item, candidateIndex) => (
      item.title === draft.title && (sourceIndex !== targetIndex || candidateIndex !== itemIndex)
    ))) {
      throw new Error(`目标内事项标题重复: ${draft.title}`)
    }

    const timestamp = this.now()
    const item: WorkboardItem = { ...draft, updated_at: timestamp }
    assertEntrySize(item, '事项')
    const objectives = [...board.objectives]
    if (sourceIndex === targetIndex) {
      const workItems = [...source.work_items]
      workItems[itemIndex] = item
      objectives[sourceIndex] = { ...source, work_items: workItems, updated_at: timestamp }
    } else {
      objectives[sourceIndex] = {
        ...source,
        work_items: source.work_items.filter((_, candidateIndex) => candidateIndex !== itemIndex),
        updated_at: timestamp,
      }
      objectives[targetIndex] = { ...target, work_items: [...target.work_items, item], updated_at: timestamp }
    }
    return { board: { ...board, objectives }, value: item }
  }

  private archiveWorkItemChange(
    board: InternalBoard,
    objectiveTitle: string,
    itemTitle: string,
    archivedAs: WorkboardArchiveOutcome,
  ): BoardChange<ArchivedWorkboardItem> {
    const objectiveIndex = this.uniqueObjectiveIndex(board, objectiveTitle)
    const objective = board.objectives[objectiveIndex]
    const itemIndex = this.uniqueWorkItemIndex(objective, itemTitle)
    const timestamp = this.now()
    const item: ArchivedWorkboardItem = {
      ...objective.work_items[itemIndex],
      objective: { title: objective.title, completion_criteria: objective.completion_criteria },
      archived_as: archivedAs,
      archived_at: timestamp,
    }
    assertEntrySize(item, '归档条目')
    const objectives = [...board.objectives]
    objectives[objectiveIndex] = {
      ...objective,
      work_items: objective.work_items.filter((_, candidateIndex) => candidateIndex !== itemIndex),
      updated_at: timestamp,
    }
    return { board: { ...board, objectives, archive: [...board.archive, item] }, value: item }
  }

  private uniqueObjectiveIndex(board: InternalBoard, title: string): number {
    const matches = board.objectives.flatMap((objective, index) => objective.title === title ? [index] : [])
    if (matches.length === 0) throw new Error(`当前目标不存在: ${title}`)
    if (matches.length > 1) throw new Error(`当前目标标题不唯一: ${title}`)
    return matches[0]
  }

  private uniqueWorkItemIndex(objective: WorkboardObjective, title: string): number {
    const matches = objective.work_items.flatMap((item, index) => item.title === title ? [index] : [])
    if (matches.length === 0) throw new Error(`目标内当前事项不存在: ${title}`)
    if (matches.length > 1) throw new Error(`目标内当前事项标题不唯一: ${title}`)
    return matches[0]
  }

  private assertNoUnreadFence(board: InternalBoard, locations: ReadonlyArray<WorkboardLocation>): void {
    if (board.admin_read_fences?.some((fence) => (
      fence.locations.some((protectedLocation) => locations.some((location) => locationConflicts(protectedLocation, location)))
    ))) {
      throw new Error('任务板已被管理员更新，请先使用 inspect_workboard 查阅最新内容后重试。')
    }
  }

  private assertNoUnreadObjectiveFence(board: InternalBoard, titles: ReadonlyArray<string>): void {
    if (board.admin_read_fences?.some((fence) => fence.locations.some((location) => (
      location.work_item_title === undefined && titles.includes(location.objective_title)
    )))) {
      throw new Error('任务板已被管理员更新，请先使用 inspect_workboard 查阅最新内容后重试。')
    }
  }

  private async managerMutate<T extends WorkboardMutationValue>(
    key: ManagerKey,
    change: (board: InternalBoard) => BoardChange<T>,
  ): Promise<WorkboardMutationResult<T>> {
    this.assertKey(key)
    return this.mutexFor(key).run(async () => {
      const before = await this.readUnlocked(key)
      const result = change(before)
      const board: InternalBoard = { ...result.board, schema_version: 3, revision: before.revision + 1 }
      await this.writeUnlocked(key, board)
      return { board: managerProjection(board), value: result.value }
    })
  }

  private async adminMutate<T extends WorkboardMutationValue>(
    key: ManagerKey,
    expectedRevision: number,
    change: (board: InternalBoard) => AdminBoardChange<T>,
  ): Promise<AdminWorkboardMutationResult<T>> {
    this.assertKey(key)
    assertRevision(expectedRevision)
    return this.mutexFor(key).run(async () => {
      const before = await this.readUnlocked(key)
      if (before.revision !== expectedRevision) throw new WorkboardRevisionConflictError(before.revision)
      let result: AdminBoardChange<T>
      try {
        result = change(before)
      } catch (error) {
        if (error instanceof WorkboardValidationError) throw error
        if (error instanceof Error) throw new WorkboardValidationError(error.message)
        throw error
      }
      const revision = before.revision + 1
      const notice: PendingAdminWorkboardNotice = { revision, created_at: this.now(), attempts: 0 }
      const board: InternalBoard = {
        ...result.board,
        schema_version: 3,
        revision,
        pending_admin_notice: notice,
        admin_read_fences: this.mergeFence(
          result.board.admin_read_fences ?? [],
          { ...result.fence, revision },
          result.merge_fence_from,
        ),
      }
      await this.writeUnlocked(key, board)
      return { board: adminProjection(board), value: result.value, notice }
    })
  }

  private mergeFence(
    existing: ReadonlyArray<AdminWorkboardReadFence>,
    next: AdminWorkboardReadFence,
    mergeFrom?: WorkboardLocation,
  ): AdminWorkboardReadFence[] {
    if (!mergeFrom) return [...existing, next]
    const nextCurrent = currentFenceLocation(next)
    const mergeLocations = new Set([locationKey(mergeFrom), locationKey(nextCurrent)])
    const aliases: WorkboardLocation[] = []
    const remaining: AdminWorkboardReadFence[] = []
    for (const fence of existing) {
      const current = currentFenceLocation(fence)
      const sameLevel = (current.work_item_title === undefined) === (nextCurrent.work_item_title === undefined)
      if (fence.view !== 'active' || !sameLevel || !mergeLocations.has(locationKey(current))) {
        remaining.push(fence)
        continue
      }
      aliases.push(...fence.locations)
    }
    return [...remaining, {
      revision: next.revision,
      view: next.view,
      locations: locationsWithCurrentLast([...aliases, ...next.locations], nextCurrent),
    }]
  }

  private async readUnlocked(key: ManagerKey): Promise<InternalBoard> {
    const file = this.pathFor(key)
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyBoard(key)
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`[ManagerWorkboardStore] workboard.json 损坏: ${file}: ${(error as Error).message}`)
    }
    try {
      return validateBoard(parsed, key)
    } catch (error) {
      throw new Error(`[ManagerWorkboardStore] 非法任务板 ${file}: ${(error as Error).message}`)
    }
  }

  private async writeUnlocked(key: ManagerKey, board: InternalBoard): Promise<void> {
    const directory = this.dirFor(key)
    const target = this.pathFor(key)
    const temporary = path.join(directory, `.tmp-${randomUUID()}.json`)
    await fs.mkdir(directory, { recursive: true })
    try {
      await fs.writeFile(temporary, JSON.stringify(board, null, 2), 'utf-8')
      await fs.rename(temporary, target)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private mutexFor(key: ManagerKey): AsyncMutex {
    let mutex = this.mutexes.get(key)
    if (!mutex) {
      mutex = new AsyncMutex()
      this.mutexes.set(key, mutex)
    }
    return mutex
  }

  private assertKey(key: ManagerKey): void {
    if (!isManagerKey(key)) throw new Error(`非法 manager_key: ${key}`)
  }

  private dirFor(key: ManagerKey): string {
    return path.join(this.managersDir, encodeSegment(key))
  }

  private pathFor(key: ManagerKey): string {
    return path.join(this.dirFor(key), WORKBOARD_FILE)
  }
}
