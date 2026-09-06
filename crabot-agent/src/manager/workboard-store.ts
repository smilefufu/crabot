import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { AsyncMutex } from '../workers/async-mutex.js'
import { decodeSegment, encodeSegment, isManagerKey } from '../workers/harness/ledger-store.js'
import type { ManagerKey } from './types.js'

const WORKBOARD_FILE = 'workboard.json'
const MAX_ITEM_BYTES = 32 * 1024

export type WorkboardItemStatus = 'ready' | 'in_progress' | 'blocked'
export type WorkboardArchiveOutcome = 'completed' | 'abandoned'
export type WorkboardView = 'active' | 'archive'

export interface WorkboardItemDraft {
  readonly title: string
  readonly status: WorkboardItemStatus
  readonly project_root?: string
  readonly objective: string
  readonly acceptance: string[]
  readonly current_state: string
  readonly next_action: string
  readonly blockers: string[]
}

export interface WorkboardItem extends WorkboardItemDraft {
  readonly updated_at: string
}

export interface ArchivedWorkboardItem extends WorkboardItem {
  readonly archived_as: WorkboardArchiveOutcome
  readonly archived_at: string
}

/** Manager tools only receive this projection; schema/revision are Store implementation details. */
export interface ManagerWorkboard {
  readonly manager_key: ManagerKey
  readonly active: WorkboardItem[]
  readonly archive: ArchivedWorkboardItem[]
}

export interface ManagerWorkboardAdminView extends ManagerWorkboard {
  readonly revision: number
}

export interface PendingAdminWorkboardNotice {
  readonly revision: number
  readonly created_at: string
  readonly attempts: number
  readonly retry_after_at?: string
}

interface AdminWorkboardReadFence {
  readonly revision: number
  readonly view: WorkboardView
  readonly titles: string[]
}

interface PersistedWorkboardV1 extends ManagerWorkboard {
  readonly schema_version: 1
}

interface PersistedWorkboardV2 extends ManagerWorkboardAdminView {
  readonly schema_version: 2
  readonly pending_admin_notice?: PendingAdminWorkboardNotice
  readonly admin_read_fences?: AdminWorkboardReadFence[]
}

interface InternalBoard extends PersistedWorkboardV2 {}

export interface WorkboardMutationResult<T extends WorkboardItem | ArchivedWorkboardItem> {
  readonly board: ManagerWorkboard
  readonly item: T
}

export interface AdminWorkboardMutationResult<T extends WorkboardItem | ArchivedWorkboardItem> {
  readonly board: ManagerWorkboardAdminView
  readonly item: T
  readonly notice: PendingAdminWorkboardNotice
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

function normalizedStringList(
  value: unknown,
  field: string,
  persisted: boolean,
  requireNonEmpty: boolean,
): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`)
  if (requireNonEmpty && value.length === 0) throw new Error(`${field} 至少包含一项`)
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

function assertItemSize(item: WorkboardItem | ArchivedWorkboardItem): void {
  if (Buffer.byteLength(JSON.stringify(item), 'utf-8') > MAX_ITEM_BYTES) {
    throw new Error('任务项序列化后不得超过 32 KiB')
  }
}

function normalizeDraft(value: unknown, persisted: boolean): WorkboardItemDraft {
  if (!isRecord(value)) throw new Error('任务项必须是对象')
  assertOnlyKeys(
    value,
    ['title', 'status', 'project_root', 'objective', 'acceptance', 'current_state', 'next_action', 'blockers'],
    '任务项',
  )

  const title = normalizedString(value.title, 'title', persisted)
  if (Array.from(title).length > 200) throw new Error('title 必须为 1 至 200 个 Unicode 字符')
  if (value.status !== 'ready' && value.status !== 'in_progress' && value.status !== 'blocked') {
    throw new Error('status 必须是 ready、in_progress 或 blocked')
  }
  const acceptance = normalizedStringList(value.acceptance, 'acceptance', persisted, true)
  const blockers = normalizedStringList(value.blockers, 'blockers', persisted, false)
  if (value.status === 'blocked' && blockers.length === 0) {
    throw new Error('blocked 任务项必须至少包含一个 blocker')
  }
  const projectRoot = normalizedProjectRoot(value.project_root, persisted)

  return {
    title,
    status: value.status,
    ...(projectRoot !== undefined ? { project_root: projectRoot } : {}),
    objective: normalizedString(value.objective, 'objective', persisted),
    acceptance,
    current_state: normalizedString(value.current_state, 'current_state', persisted),
    next_action: normalizedString(value.next_action, 'next_action', persisted),
    blockers,
  }
}

function normalizePersistedItem(value: unknown, archived: false): WorkboardItem
function normalizePersistedItem(value: unknown, archived: true): ArchivedWorkboardItem
function normalizePersistedItem(value: unknown, archived: boolean): WorkboardItem | ArchivedWorkboardItem {
  if (!isRecord(value)) throw new Error('任务项必须是对象')
  const draftValue = Object.fromEntries(
    Object.entries(value).filter(([key]) => !['updated_at', 'archived_as', 'archived_at'].includes(key)),
  )
  const draft = normalizeDraft(draftValue, true)
  const expectedKeys = [
    'title', 'status', 'objective', 'acceptance', 'current_state', 'next_action', 'blockers', 'updated_at',
    ...(value.project_root === undefined ? [] : ['project_root']),
    ...(archived ? ['archived_as', 'archived_at'] : []),
  ]
  assertOnlyKeys(value, expectedKeys, archived ? '归档任务项' : 'active 任务项')
  const base: WorkboardItem = { ...draft, updated_at: assertTimestamp(value.updated_at, 'updated_at') }
  if (!archived) {
    assertItemSize(base)
    return base
  }
  if (value.archived_as !== 'completed' && value.archived_as !== 'abandoned') {
    throw new Error('archived_as 必须是 completed 或 abandoned')
  }
  const result: ArchivedWorkboardItem = {
    ...base,
    archived_as: value.archived_as,
    archived_at: assertTimestamp(value.archived_at, 'archived_at'),
  }
  assertItemSize(result)
  return result
}

function normalizeBoardItems(value: Record<string, unknown>, key: ManagerKey): Pick<ManagerWorkboard, 'manager_key' | 'active' | 'archive'> {
  if (value.manager_key !== key) throw new Error(`manager_key 不匹配: ${String(value.manager_key)}`)
  if (!Array.isArray(value.active) || !Array.isArray(value.archive)) {
    throw new Error('任务板 active/archive 必须是数组')
  }
  const active = value.active.map((item) => normalizePersistedItem(item, false))
  const titles = new Set<string>()
  for (const item of active) {
    if (titles.has(item.title)) throw new Error(`active 标题重复: ${item.title}`)
    titles.add(item.title)
  }
  return { manager_key: key, active, archive: value.archive.map((item) => normalizePersistedItem(item, true)) }
}

function normalizeNotice(value: unknown): PendingAdminWorkboardNotice {
  if (!isRecord(value)) throw new Error('pending_admin_notice 非法')
  // `principal_permissions` was persisted by the first v2 implementation. It is
  // no longer an execution input, but old notices remain readable until any normal
  // workboard write rewrites them without the retired field.
  assertOnlyKeys(value, ['revision', 'created_at', 'principal_permissions', 'attempts', 'retry_after_at'], 'pending_admin_notice')
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

function normalizeFence(value: unknown): AdminWorkboardReadFence {
  if (!isRecord(value)) throw new Error('admin_read_fence 非法')
  assertOnlyKeys(value, ['revision', 'view', 'titles'], 'admin_read_fence')
  if (value.view !== 'active' && value.view !== 'archive') throw new Error('admin_read_fence view 非法')
  const titles = normalizedStringList(value.titles, 'admin_read_fence.titles', true, true)
  if (new Set(titles).size !== titles.length) throw new Error('admin_read_fence titles 重复')
  return { revision: assertRevision(value.revision), view: value.view, titles }
}

function emptyBoard(key: ManagerKey): InternalBoard {
  return { schema_version: 2, manager_key: key, revision: 0, active: [], archive: [] }
}

function validateBoard(value: unknown, key: ManagerKey): InternalBoard {
  if (!isRecord(value)) throw new Error('任务板 shape 非法')
  if (value.schema_version === 1) {
    assertOnlyKeys(value, ['schema_version', 'manager_key', 'active', 'archive'], '任务板')
    return { schema_version: 2, revision: 0, ...normalizeBoardItems(value, key) }
  }
  if (value.schema_version !== 2) throw new Error(`未知 schema_version: ${String(value.schema_version)}`)
  assertOnlyKeys(value, ['schema_version', 'manager_key', 'revision', 'active', 'archive', 'pending_admin_notice', 'admin_read_fences'], '任务板')
  const notice = value.pending_admin_notice === undefined ? undefined : normalizeNotice(value.pending_admin_notice)
  const fences = value.admin_read_fences === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(value.admin_read_fences)) throw new Error('admin_read_fences 必须是数组')
        const normalized = value.admin_read_fences.map(normalizeFence)
        for (let index = 0; index < normalized.length; index++) {
          if (normalized.slice(0, index).some((candidate) => candidate.titles.some((title) => normalized[index].titles.includes(title)))) {
            throw new Error('admin_read_fences 不能有可合并的重复事项')
          }
        }
        return normalized
      })()
  const board = {
    schema_version: 2 as const,
    revision: assertRevision(value.revision),
    ...normalizeBoardItems(value, key),
    ...(notice ? { pending_admin_notice: notice } : {}),
    ...(fences && fences.length > 0 ? { admin_read_fences: fences } : {}),
  }
  for (const fence of fences ?? []) {
    if (fence.revision > board.revision) throw new Error('admin_read_fence revision 超前')
  }
  return board
}

function managerProjection(board: InternalBoard): ManagerWorkboard {
  return { manager_key: board.manager_key, active: board.active, archive: board.archive }
}

function adminProjection(board: InternalBoard): ManagerWorkboardAdminView {
  return { ...managerProjection(board), revision: board.revision }
}

function isSameLogicalFence(fence: AdminWorkboardReadFence, titles: ReadonlyArray<string>): boolean {
  return fence.titles.some((title) => titles.includes(title))
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

  async create(key: ManagerKey, value: WorkboardItemDraft): Promise<WorkboardMutationResult<WorkboardItem>> {
    return this.managerMutate(key, (board) => {
      const item = this.materializeItem(value)
      this.assertNoUnreadFence(board, item.title)
      if (board.active.some((candidate) => candidate.title === item.title)) throw new Error(`active 任务项标题重复: ${item.title}`)
      return { board: { ...board, active: [...board.active, item] }, item }
    })
  }

  async revise(key: ManagerKey, currentTitle: string, value: WorkboardItemDraft): Promise<WorkboardMutationResult<WorkboardItem>> {
    return this.managerMutate(key, (board) => {
      const target = normalizedString(currentTitle, 'current_title', false)
      this.assertNoUnreadFence(board, target)
      const index = this.uniqueActiveIndex(board, target)
      const item = this.materializeItem(value)
      if (board.active.some((candidate, candidateIndex) => candidateIndex !== index && candidate.title === item.title)) {
        throw new Error(`active 任务项标题重复: ${item.title}`)
      }
      const active = [...board.active]
      active[index] = item
      return { board: { ...board, active }, item }
    })
  }

  async archive(key: ManagerKey, currentTitle: string, archivedAs: WorkboardArchiveOutcome): Promise<WorkboardMutationResult<ArchivedWorkboardItem>> {
    return this.managerMutate(key, (board) => {
      const target = normalizedString(currentTitle, 'current_title', false)
      this.assertNoUnreadFence(board, target)
      const index = this.uniqueActiveIndex(board, target)
      if (archivedAs !== 'completed' && archivedAs !== 'abandoned') throw new Error('archived_as 必须是 completed 或 abandoned')
      const item: ArchivedWorkboardItem = { ...board.active[index], archived_as: archivedAs, archived_at: this.now() }
      assertItemSize(item)
      return {
        board: { ...board, active: board.active.filter((_, candidateIndex) => candidateIndex !== index), archive: [...board.archive, item] },
        item,
      }
    })
  }

  async adminCreate(
    key: ManagerKey,
    expectedRevision: number,
    value: WorkboardItemDraft,
  ): Promise<AdminWorkboardMutationResult<WorkboardItem>> {
    return this.adminMutate(key, expectedRevision, (board) => {
      const item = this.materializeItem(value)
      if (board.active.some((candidate) => candidate.title === item.title)) throw new Error(`active 任务项标题重复: ${item.title}`)
      return { board: { ...board, active: [...board.active, item] }, item, fence: { view: 'active', titles: [item.title] } }
    })
  }

  async adminRevise(
    key: ManagerKey,
    expectedRevision: number,
    currentTitle: string,
    value: WorkboardItemDraft,
  ): Promise<AdminWorkboardMutationResult<WorkboardItem>> {
    return this.adminMutate(key, expectedRevision, (board) => {
      const target = normalizedString(currentTitle, 'current_title', false)
      const index = this.uniqueActiveIndex(board, target)
      const item = this.materializeItem(value)
      if (board.active.some((candidate, candidateIndex) => candidateIndex !== index && candidate.title === item.title)) {
        throw new Error(`active 任务项标题重复: ${item.title}`)
      }
      const active = [...board.active]
      active[index] = item
      return { board: { ...board, active }, item, fence: { view: 'active', titles: [target, item.title] } }
    })
  }

  async adminArchive(
    key: ManagerKey,
    expectedRevision: number,
    currentTitle: string,
    archivedAs: WorkboardArchiveOutcome,
  ): Promise<AdminWorkboardMutationResult<ArchivedWorkboardItem>> {
    return this.adminMutate(key, expectedRevision, (board) => {
      const target = normalizedString(currentTitle, 'current_title', false)
      const index = this.uniqueActiveIndex(board, target)
      if (archivedAs !== 'completed' && archivedAs !== 'abandoned') throw new Error('archived_as 必须是 completed 或 abandoned')
      const item: ArchivedWorkboardItem = { ...board.active[index], archived_as: archivedAs, archived_at: this.now() }
      assertItemSize(item)
      return {
        board: { ...board, active: board.active.filter((_, candidateIndex) => candidateIndex !== index), archive: [...board.archive, item] },
        item,
        fence: { view: 'archive', titles: [target, item.title] },
      }
    })
  }

  /** A Manager can only clear a fence it actually observed in a tool result. */
  async acknowledgeManagerRead(
    key: ManagerKey,
    view: WorkboardView,
    visibleItems: ReadonlyArray<WorkboardItem | ArchivedWorkboardItem>,
    observedRevision: number,
  ): Promise<void> {
    this.assertKey(key)
    assertRevision(observedRevision)
    const visibleTitles = new Set(visibleItems.map((item) => item.title))
    if (visibleTitles.size === 0) return
    await this.mutexFor(key).run(async () => {
      const board = await this.readUnlocked(key)
      const fences = board.admin_read_fences ?? []
      const remaining = fences.filter((fence) => (
        fence.revision > observedRevision
        || fence.view !== view
        || !fence.titles.some((title) => visibleTitles.has(title))
      ))
      if (remaining.length === fences.length) return
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

  private materializeItem(value: WorkboardItemDraft): WorkboardItem {
    const item: WorkboardItem = { ...normalizeDraft(value, false), updated_at: this.now() }
    assertItemSize(item)
    return item
  }

  private uniqueActiveIndex(board: InternalBoard, title: string): number {
    const matches = board.active.flatMap((item, index) => item.title === title ? [index] : [])
    if (matches.length === 0) throw new Error(`active 任务项不存在: ${title}`)
    if (matches.length > 1) throw new Error(`active 任务项标题不唯一: ${title}`)
    return matches[0]
  }

  private assertNoUnreadFence(board: InternalBoard, title: string): void {
    if (board.admin_read_fences?.some((fence) => fence.titles.includes(title))) {
      throw new Error('任务板已被管理员更新，请先使用 inspect_workboard 查阅最新内容后重试。')
    }
  }

  private async managerMutate<T extends WorkboardItem | ArchivedWorkboardItem>(
    key: ManagerKey,
    change: (board: InternalBoard) => { board: InternalBoard; item: T },
  ): Promise<WorkboardMutationResult<T>> {
    this.assertKey(key)
    return this.mutexFor(key).run(async () => {
      const before = await this.readUnlocked(key)
      const result = change(before)
      const board: InternalBoard = { ...result.board, schema_version: 2, revision: before.revision + 1 }
      await this.writeUnlocked(key, board)
      return { board: managerProjection(board), item: result.item }
    })
  }

  private async adminMutate<T extends WorkboardItem | ArchivedWorkboardItem>(
    key: ManagerKey,
    expectedRevision: number,
    change: (board: InternalBoard) => { board: InternalBoard; item: T; fence: { view: WorkboardView; titles: string[] } },
  ): Promise<AdminWorkboardMutationResult<T>> {
    this.assertKey(key)
    assertRevision(expectedRevision)
    return this.mutexFor(key).run(async () => {
      const before = await this.readUnlocked(key)
      if (before.revision !== expectedRevision) throw new WorkboardRevisionConflictError(before.revision)
      let result: ReturnType<typeof change>
      try {
        // `change` only validates request-derived values against the loaded board;
        // read and write failures intentionally remain ordinary internal errors.
        result = change(before)
      } catch (error) {
        if (error instanceof WorkboardValidationError) throw error
        if (error instanceof Error) throw new WorkboardValidationError(error.message)
        throw error
      }
      const revision = before.revision + 1
      const notice: PendingAdminWorkboardNotice = {
        revision,
        created_at: this.now(),
        attempts: 0,
      }
      const board: InternalBoard = {
        ...result.board,
        schema_version: 2,
        revision,
        pending_admin_notice: notice,
        admin_read_fences: this.mergeFence(before.admin_read_fences ?? [], { ...result.fence, revision }),
      }
      await this.writeUnlocked(key, board)
      return { board: adminProjection(board), item: result.item, notice }
    })
  }

  private mergeFence(existing: ReadonlyArray<AdminWorkboardReadFence>, next: AdminWorkboardReadFence): AdminWorkboardReadFence[] {
    const mergedTitles = new Set(next.titles)
    let mergedView = next.view
    const remaining: AdminWorkboardReadFence[] = []
    for (const fence of existing) {
      if (!isSameLogicalFence(fence, next.titles)) {
        remaining.push(fence)
        continue
      }
      for (const title of fence.titles) mergedTitles.add(title)
      mergedView = next.view
    }
    return [...remaining, { revision: next.revision, view: mergedView, titles: [...mergedTitles] }]
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
