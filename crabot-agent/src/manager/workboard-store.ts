import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { AsyncMutex } from '../workers/async-mutex.js'
import { encodeSegment, isManagerKey } from '../workers/harness/ledger-store.js'
import type { ManagerKey } from './types.js'

const WORKBOARD_FILE = 'workboard.json'
const MAX_ITEM_BYTES = 32 * 1024

export type WorkboardItemStatus = 'ready' | 'in_progress' | 'blocked'
export type WorkboardArchiveOutcome = 'completed' | 'abandoned'

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

export interface ManagerWorkboard {
  readonly schema_version: 1
  readonly manager_key: ManagerKey
  readonly active: WorkboardItem[]
  readonly archive: ArchivedWorkboardItem[]
}

export interface WorkboardMutationResult<T extends WorkboardItem | ArchivedWorkboardItem> {
  readonly board: ManagerWorkboard
  readonly item: T
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
  const titleLength = Array.from(title).length
  if (titleLength > 200) throw new Error('title 必须为 1 至 200 个 Unicode 字符')
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
  const base: WorkboardItem = {
    ...draft,
    updated_at: assertTimestamp(value.updated_at, 'updated_at'),
  }
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

function validateBoard(value: unknown, key: ManagerKey): ManagerWorkboard {
  if (!isRecord(value)) throw new Error('任务板 shape 非法')
  assertOnlyKeys(value, ['schema_version', 'manager_key', 'active', 'archive'], '任务板')
  if (value.schema_version !== 1) throw new Error(`未知 schema_version: ${String(value.schema_version)}`)
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
  return {
    schema_version: 1,
    manager_key: key,
    active,
    archive: value.archive.map((item) => normalizePersistedItem(item, true)),
  }
}

function emptyBoard(key: ManagerKey): ManagerWorkboard {
  return { schema_version: 1, manager_key: key, active: [], archive: [] }
}

export class ManagerWorkboardStore {
  private readonly mutexes = new Map<ManagerKey, AsyncMutex>()

  constructor(
    private readonly managersDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async load(key: ManagerKey): Promise<ManagerWorkboard> {
    this.assertKey(key)
    return this.mutexFor(key).run(() => this.readUnlocked(key))
  }

  async create(key: ManagerKey, value: WorkboardItemDraft): Promise<WorkboardMutationResult<WorkboardItem>> {
    return this.mutate(key, (board) => {
      const item = this.materializeItem(value)
      if (board.active.some((candidate) => candidate.title === item.title)) {
        throw new Error(`active 任务项标题重复: ${item.title}`)
      }
      return { board: { ...board, active: [...board.active, item] }, item }
    })
  }

  async revise(
    key: ManagerKey,
    currentTitle: string,
    value: WorkboardItemDraft,
  ): Promise<WorkboardMutationResult<WorkboardItem>> {
    return this.mutate(key, (board) => {
      const target = normalizedString(currentTitle, 'current_title', false)
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

  async archive(
    key: ManagerKey,
    currentTitle: string,
    archivedAs: WorkboardArchiveOutcome,
  ): Promise<WorkboardMutationResult<ArchivedWorkboardItem>> {
    return this.mutate(key, (board) => {
      const target = normalizedString(currentTitle, 'current_title', false)
      const index = this.uniqueActiveIndex(board, target)
      if (archivedAs !== 'completed' && archivedAs !== 'abandoned') {
        throw new Error('archived_as 必须是 completed 或 abandoned')
      }
      const item: ArchivedWorkboardItem = {
        ...board.active[index],
        archived_as: archivedAs,
        archived_at: this.now(),
      }
      assertItemSize(item)
      return {
        board: {
          ...board,
          active: board.active.filter((_, candidateIndex) => candidateIndex !== index),
          archive: [...board.archive, item],
        },
        item,
      }
    })
  }

  private materializeItem(value: WorkboardItemDraft): WorkboardItem {
    const item: WorkboardItem = { ...normalizeDraft(value, false), updated_at: this.now() }
    assertItemSize(item)
    return item
  }

  private uniqueActiveIndex(board: ManagerWorkboard, title: string): number {
    const matches = board.active.flatMap((item, index) => item.title === title ? [index] : [])
    if (matches.length === 0) throw new Error(`active 任务项不存在: ${title}`)
    if (matches.length > 1) throw new Error(`active 任务项标题不唯一: ${title}`)
    return matches[0]
  }

  private async mutate<T extends WorkboardItem | ArchivedWorkboardItem>(
    key: ManagerKey,
    change: (board: ManagerWorkboard) => WorkboardMutationResult<T>,
  ): Promise<WorkboardMutationResult<T>> {
    this.assertKey(key)
    return this.mutexFor(key).run(async () => {
      const result = change(await this.readUnlocked(key))
      await this.writeUnlocked(key, result.board)
      return result
    })
  }

  private async readUnlocked(key: ManagerKey): Promise<ManagerWorkboard> {
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

  private async writeUnlocked(key: ManagerKey, board: ManagerWorkboard): Promise<void> {
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
