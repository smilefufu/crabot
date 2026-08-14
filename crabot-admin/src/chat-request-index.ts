/**
 * Admin Chat request index（P6-A §3.4）。
 *
 * request_id 级 CAS 真相源：request_id、固定 session、AdminChatInboundFingerprintV1
 * canonical hash、pending/settled/expired、关联 user/assistant message。
 * 所有写盘经原子写 + 专用 mutex；跨 Admin 重启持久。
 */

import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'

export type ChatRequestStatus = 'pending' | 'settled' | 'expired'

export interface ChatRequestIndexEntry {
  readonly request_id: string
  readonly session_id: string
  /** AdminChatInboundFingerprintV1：exact text + 附件 raw-byte hash 序列（不含服务端生成值）。 */
  readonly fingerprint: string
  status: ChatRequestStatus
  user_message_id?: string
  assistant_message_id?: string
  readonly created_at: string
  settled_at?: string
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmpPath = join(dirname(path), `.tmp-${randomUUID()}.json`)
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 })
  await fs.rename(tmpPath, path)
}

export class ChatRequestIndex {
  private readonly entries = new Map<string, ChatRequestIndexEntry>()
  private loaded = false
  private writeTail: Promise<void> = Promise.resolve()
  /** per-request 判准互斥锁（同 ID 并发入站串行）。 */
  private readonly mutexes = new Map<string, Promise<unknown>>()

  constructor(private readonly dataDir: string) {}

  private get filePath(): string {
    return join(this.dataDir, 'chat-request-index.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const entries = JSON.parse(raw) as ChatRequestIndexEntry[]
      for (const entry of entries) this.entries.set(entry.request_id, entry)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    // 超龄条目裁剪（30 天）：index 只承担近期请求的幂等/结算，老条目无消费者。
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000
    for (const [id, entry] of Array.from(this.entries.entries())) {
      if (Date.parse(entry.created_at) < cutoff) this.entries.delete(id)
    }
  }

  get(requestId: string): ChatRequestIndexEntry | undefined {
    return this.entries.get(requestId)
  }

  private async persist(): Promise<void> {
    // 写盘失败必须抛给调用方（入站事务/结算路径据此回滚或重试）——静默降级成
    // 「index 无条目」会让后续 delivery 被 pending 校验拒绝、答案彻底丢失且无人重试。
    // 同时链本身不得被一次失败永久污染：失败只影响本次调用方，writeTail 恢复 resolved。
    const snapshot = Array.from(this.entries.values())
    const run = this.writeTail.then(() => writeJsonAtomic(this.filePath, snapshot))
    this.writeTail = run.catch(() => undefined)
    await run
  }

  /** 同 request_id 的入站串行化（fingerprint CAS 判准在锁内完成）。 */
  async withMutex<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutexes.get(requestId) ?? Promise.resolve()
    const run = previous.then(fn)
    const tracked = run.then(() => undefined, () => undefined)
    this.mutexes.set(requestId, tracked)
    try {
      return await run
    } finally {
      // 只清自己这条链：已有后来者挂在 tracked 上时必须保留，否则第三个并发会旁路串行。
      if (this.mutexes.get(requestId) === tracked) this.mutexes.delete(requestId)
    }
  }

  /**
   * 入站 CAS：不存在 → admitted（落 pending）；exact duplicate（同 fingerprint+session）→ duplicate；
   * 同 ID 不同 fingerprint/session → 抛 409 冲突（调用方保证零 media/chat/index mutation）。
   */
  /**
   * 入站检查（只读，不写）：duplicate → 既有条目；同 ID 不同 fingerprint/session → 409；
   * 不存在 → 'new'。落盘由 `recordAdmission` 在调用方的事务顺序里完成（P6-A §11.3：
   * journal → message → index，崩在 index 之前都能被 dispatch journal 恢复）。
   */
  async check(input: { request_id: string; session_id: string; fingerprint: string }): Promise<
    { kind: 'new' } | { kind: 'duplicate'; entry: ChatRequestIndexEntry }
  > {
    await this.load()
    const existing = this.entries.get(input.request_id)
    if (!existing) return { kind: 'new' }
    if (existing.fingerprint !== input.fingerprint || existing.session_id !== input.session_id) {
      const error = new Error(`chat request conflict: ${input.request_id}`)
      ;(error as { code?: string }).code = 'ADMIN_CHAT_REQUEST_CONFLICT'
      throw error
    }
    return { kind: 'duplicate', entry: existing }
  }

  /** 事务末段的 index 落盘（调用方已完成 check + journal + message 写入）。 */
  async recordAdmission(input: {
    request_id: string
    session_id: string
    fingerprint: string
    user_message_id?: string
  }): Promise<ChatRequestIndexEntry> {
    await this.load()
    const entry: ChatRequestIndexEntry = {
      request_id: input.request_id,
      session_id: input.session_id,
      fingerprint: input.fingerprint,
      status: 'pending',
      ...(input.user_message_id ? { user_message_id: input.user_message_id } : {}),
      created_at: new Date().toISOString(),
    }
    this.entries.set(input.request_id, entry)
    await this.persist()
    return entry
  }

  async expire(requestId: string): Promise<void> {
    const entry = this.entries.get(requestId)
    if (!entry) return
    entry.status = 'expired'
    entry.settled_at = new Date().toISOString()
    await this.persist()
  }

  async settle(requestId: string, assistantMessageId: string): Promise<void> {
    const entry = this.entries.get(requestId)
    if (!entry) return
    entry.status = 'settled'
    entry.assistant_message_id = assistantMessageId
    entry.settled_at = new Date().toISOString()
    await this.persist()
  }
}
