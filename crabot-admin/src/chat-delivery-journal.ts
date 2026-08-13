/**
 * Admin Chat delivery journal（P6-A §3.4/§11.8-12）。
 *
 * - delivery index：delivery_id、exact ordered request_ids、canonical payload hash、
 *   platform_message_id、sent_at；
 * - journal：prepared/committing/committed/rolled_back + 可恢复的目标 mutation
 *   （planned MediaStore UUID/URL、staging 源身份、finalized content）；
 * - staging：媒体 commit 前的不可见副本。
 *
 * 重启后先 reconcile 两类 journal（prepared/committing → 按 journal 确定性 complete，
 * rolled_back → 调用方可按同 delivery_id 重试），再接受新 delivery。
 */

import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'

export type ChatDeliveryJournalState = 'prepared' | 'committing' | 'committed' | 'rolled_back'

export interface ChatDeliveryPlannedMedia {
  /** staging 源身份（staged 文件路径；commit 后可为空——promotion 已消费）。 */
  readonly staged_path: string
  readonly planned_media_id: string
  readonly planned_media_url: string
  readonly entry: unknown
}

export interface ChatDeliveryJournalRecord {
  readonly delivery_id: string
  state: ChatDeliveryJournalState
  /** 排序规范化后的 request IDs（空 = proactive）。 */
  readonly request_ids: string[]
  /** wire 原始 MessageContent 的 canonical payload hash（§11.7）。 */
  readonly payload_sha256: string
  readonly session_id: string
  readonly planned_media: ChatDeliveryPlannedMedia[]
  /** finalized content（降级/失败提示已定型；retry/restart 不得重新决定）。 */
  readonly finalized_content: unknown
  /** prepare 时即定型的 assistant message id（committing 崩溃恢复/重试复用，不二次落新消息）。 */
  readonly planned_message_id: string
  platform_message_id?: string
  sent_at?: string
  readonly created_at: string
  updated_at: string
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmpPath = join(dirname(path), `.tmp-${randomUUID()}.json`)
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 })
  await fs.rename(tmpPath, path)
}

export class ChatDeliveryJournalStore {
  private readonly mutexes = new Map<string, Promise<unknown>>()

  constructor(private readonly dataDir: string) {}

  private journalPath(deliveryId: string): string {
    return join(this.dataDir, 'chat-delivery-journal', `${deliveryId}.json`)
  }

  stagingDir(deliveryId: string): string {
    return join(this.dataDir, 'chat-delivery-staging', deliveryId)
  }

  async withMutex<T>(deliveryId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutexes.get(deliveryId) ?? Promise.resolve()
    const run = previous.then(fn)
    const tracked = run.then(() => undefined, () => undefined)
    this.mutexes.set(deliveryId, tracked)
    try {
      return await run
    } finally {
      // 只清自己这条链：已有后来者挂在 tracked 上时必须保留，否则第三个并发会旁路串行。
      if (this.mutexes.get(deliveryId) === tracked) this.mutexes.delete(deliveryId)
    }
  }

  async prepare(record: Omit<ChatDeliveryJournalRecord, 'state' | 'created_at' | 'updated_at'>): Promise<ChatDeliveryJournalRecord> {
    const now = new Date().toISOString()
    const full: ChatDeliveryJournalRecord = { ...record, state: 'prepared', created_at: now, updated_at: now }
    await writeJsonAtomic(this.journalPath(record.delivery_id), full)
    return full
  }

  async read(deliveryId: string): Promise<ChatDeliveryJournalRecord | null> {
    try {
      const raw = await fs.readFile(this.journalPath(deliveryId), 'utf-8')
      return JSON.parse(raw) as ChatDeliveryJournalRecord
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async transition(deliveryId: string, state: ChatDeliveryJournalState, patch: Partial<Pick<ChatDeliveryJournalRecord, 'platform_message_id' | 'sent_at'>> = {}): Promise<void> {
    const record = await this.read(deliveryId)
    if (!record) return
    record.state = state
    record.updated_at = new Date().toISOString()
    if (patch.platform_message_id !== undefined) record.platform_message_id = patch.platform_message_id
    if (patch.sent_at !== undefined) record.sent_at = patch.sent_at
    await writeJsonAtomic(this.journalPath(deliveryId), record)
  }

  /** startup reconcile：prepared/committing 的 journal（committed/rolled_back 不返回）。 */
  async pendingJournals(): Promise<ChatDeliveryJournalRecord[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(join(this.dataDir, 'chat-delivery-journal'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: ChatDeliveryJournalRecord[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const record = JSON.parse(await fs.readFile(join(this.dataDir, 'chat-delivery-journal', entry), 'utf-8')) as ChatDeliveryJournalRecord
        if (record.state === 'prepared' || record.state === 'committing') records.push(record)
      } catch { /* 坏 record 隔离跳过 */ }
    }
    return records
  }

  async cleanStaging(deliveryId: string): Promise<void> {
    await fs.rm(this.stagingDir(deliveryId), { recursive: true, force: true }).catch(() => {})
  }
}
