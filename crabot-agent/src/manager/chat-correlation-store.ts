/**
 * Admin Chat correlation 持久化（P6-A §3.2/§3.5）。
 *
 * 每 Manager 目录下：
 * - `pending-admin-chat-wakes.jsonl`：完整可重放的入站 wake envelope（含原始 ChannelMessage、
 *   message hash、不渲染进 LLM 正文的 request IDs）。assertion 核销后、Manager 唤醒前原子写入；
 *   Admin 确认 outbound delivery 后才把对应 wake 标 settled。
 * - `admin-chat-request-index.json`：durable inbound index（request_id + message hash + ManagerKey），
 *   exact 已有幂等 accepted，冲突拒绝，缺失才原子写 wake。
 * - `outbound-deliveries/<delivery_id>.json`：prepared outbound delivery（delivery ID、exact ordered
 *   request IDs、目标 session、canonical dispatch payload fingerprint、可重放的脱敏 payload、
 *   prepared|confirmed|failed）。
 * - `outbound-staging/<delivery_id>/`：local attachment 的 Agent-owned staging（raw-byte digest 记录）。
 *
 * 纪律：assertion/JWT/credential/Authorization/setup bytes 一律不写入任何 journal。
 */

import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { createHash, randomUUID } from 'crypto'
import { encodeSegment, decodeSegment } from '../workers/harness/ledger-store.js'
import type { ManagerKey } from '../workers/harness/ledger-types.js'
import type { ChannelMessage } from '../types.js'

export interface AdminChatWakeRecord {
  readonly kind: 'admin_chat_wake'
  readonly request_id: string
  readonly manager_key: ManagerKey
  /** canonical inbound fingerprint（原文 ChannelMessage 的 sha256，见 §3.4 request index）。 */
  readonly message_sha256: string
  /** 完整可重放的原始 ChannelMessage。 */
  readonly message: ChannelMessage
  /** 到达时间（入口固定，重启重放不产生新时间）。 */
  readonly received_at: string
  status: 'pending' | 'settled'
}

export interface AdminChatRequestIndexEntry {
  readonly request_id: string
  readonly message_sha256: string
  readonly manager_key: ManagerKey
  status: 'pending' | 'settled' | 'expired'
  readonly created_at: string
}

export type OutboundDeliveryStatus = 'prepared' | 'confirmed' | 'failed' | 'abandoned'

export interface OutboundDeliveryRecord {
  readonly kind: 'outbound_delivery'
  readonly delivery_id: string
  readonly manager_key: ManagerKey
  /** exact ordered request IDs（空数组 = proactive push）。 */
  readonly request_ids: string[]
  readonly target_session: { channel_id: string; session_id: string }
  /** canonical dispatch payload 指纹（内容+IDs 的稳定散列）。 */
  readonly payload_sha256: string
  /** 可重放的脱敏/finalized dispatch payload（staging 引用稳定副本，不含源路径）。 */
  readonly payload: unknown
  status: OutboundDeliveryStatus
  readonly created_at: string
  updated_at: string
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmpPath = join(dirname(path), `.tmp-${randomUUID()}.json`)
  await fs.writeFile(tmpPath, JSON.stringify(data), { mode: 0o600 })
  await fs.rename(tmpPath, path)
}

export class AdminChatCorrelationStore {
  /** request index 的 read-modify-write 串行锁（并发入站 dispatch 不得互相覆盖条目）。 */
  private indexTail: Promise<void> = Promise.resolve()

  constructor(private readonly managersRoot: string) {}

  private withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.indexTail.then(fn)
    this.indexTail = run.then(() => undefined, () => undefined)
    return run
  }

  private dirFor(managerKey: ManagerKey): string {
    return join(this.managersRoot, encodeSegment(managerKey))
  }

  private wakesPath(managerKey: ManagerKey): string {
    return join(this.dirFor(managerKey), 'pending-admin-chat-wakes.jsonl')
  }

  private indexPath(managerKey: ManagerKey): string {
    return join(this.dirFor(managerKey), 'admin-chat-request-index.json')
  }

  private outboundDir(managerKey: ManagerKey): string {
    return join(this.dirFor(managerKey), 'outbound-deliveries')
  }

  /** local attachment 的 per-delivery staging 目录。 */
  stagingDir(managerKey: ManagerKey, deliveryId: string): string {
    return join(this.dirFor(managerKey), 'outbound-staging', deliveryId)
  }

  // ── inbound request index ────────────────────────────────────

  async readRequestIndex(managerKey: ManagerKey): Promise<Map<string, AdminChatRequestIndexEntry>> {
    try {
      const raw = await fs.readFile(this.indexPath(managerKey), 'utf-8')
      const entries = JSON.parse(raw) as AdminChatRequestIndexEntry[]
      return new Map(entries.map((entry) => [entry.request_id, entry]))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      throw error
    }
  }

  private async writeRequestIndex(managerKey: ManagerKey, entries: Map<string, AdminChatRequestIndexEntry>): Promise<void> {
    await writeJsonAtomic(this.indexPath(managerKey), Array.from(entries.values()))
  }

  /**
   * durable inbound index 判准入站：exact 已有 → 幂等 accepted（不重复 wake）；
   * 同 ID 不同 hash/manager → 冲突拒绝；缺失 → 原子写 wake journal + index 后返回 'committed'。
   */
  async admitInbound(
    record: Omit<AdminChatWakeRecord, 'status'>,
  ): Promise<'committed' | 'duplicate'> {
    // 判重 + wake journal + index 写是一个 read-modify-write 事务，必须串行
    // （并发入站各自跑 dispatch loop，无锁会互相覆盖 index 条目）。
    return this.withIndexLock(async () => {
      const index = await this.readRequestIndex(record.manager_key)
      const existing = index.get(record.request_id)
      if (existing) {
        if (existing.message_sha256 !== record.message_sha256 || existing.manager_key !== record.manager_key) {
          throw new Error(`admin chat request conflict: ${record.request_id}`)
        }
        return 'duplicate'
      }
      // 先写 wake journal（完整可重放 envelope），再写 index——崩溃在两者之间时重启靠
      // journal 重放补 index（见 replayPendingWakes 的 index 自愈）。
      const wake: AdminChatWakeRecord = { ...record, status: 'pending' }
      const line = JSON.stringify(wake) + '\n'
      const wakesPath = this.wakesPath(record.manager_key)
      await fs.mkdir(dirname(wakesPath), { recursive: true, mode: 0o700 })
      await fs.appendFile(wakesPath, line, { mode: 0o600 })
      index.set(record.request_id, {
        request_id: record.request_id,
        message_sha256: record.message_sha256,
        manager_key: record.manager_key,
        status: 'pending',
        created_at: record.received_at,
      })
      await this.writeRequestIndex(record.manager_key, index)
      return 'committed'
    })
  }

  /** Admin 确认 outbound delivery 后结算：wake → settled、index → settled。 */
  async settleInbound(managerKey: ManagerKey, requestIds: ReadonlyArray<string>): Promise<void> {
    if (requestIds.length === 0) return
    return this.withIndexLock(async () => {
      const ids = new Set(requestIds)
      const wakes = await this.readWakes(managerKey)
      let changed = false
      for (const wake of wakes) {
        if (ids.has(wake.request_id) && wake.status === 'pending') {
          wake.status = 'settled'
          changed = true
        }
      }
      if (changed) await this.rewriteWakes(managerKey, wakes)
      const index = await this.readRequestIndex(managerKey)
      let indexChanged = false
      for (const id of ids) {
        const entry = index.get(id)
        if (entry && entry.status === 'pending') {
          entry.status = 'settled'
          indexChanged = true
        }
      }
      if (indexChanged) await this.writeRequestIndex(managerKey, index)
    })
  }

  async readWakes(managerKey: ManagerKey): Promise<AdminChatWakeRecord[]> {
    try {
      const raw = await fs.readFile(this.wakesPath(managerKey), 'utf-8')
      return raw.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as AdminChatWakeRecord)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async rewriteWakes(managerKey: ManagerKey, wakes: AdminChatWakeRecord[]): Promise<void> {
    const wakesPath = this.wakesPath(managerKey)
    await fs.mkdir(dirname(wakesPath), { recursive: true, mode: 0o700 })
    const tmpPath = `${wakesPath}.tmp-${randomUUID()}`
    await fs.writeFile(tmpPath, wakes.map((wake) => JSON.stringify(wake)).join('\n') + '\n', { mode: 0o600 })
    await fs.rename(tmpPath, wakesPath)
  }

  /** 启动重放：所有未结算 wake（settled 不重放）。同一 request ID 只恢复一次（按序去重）。 */
  async pendingWakes(managerKey: ManagerKey): Promise<AdminChatWakeRecord[]> {
    const wakes = await this.readWakes(managerKey)
    const seen = new Set<string>()
    const pending: AdminChatWakeRecord[] = []
    for (const wake of wakes) {
      if (wake.status !== 'pending') continue
      if (seen.has(wake.request_id)) continue
      seen.add(wake.request_id)
      pending.push(wake)
    }
    return pending
  }

  /** 带 pending wake 的 manager key 列表（启动重放枚举）。 */
  async managersWithPendingWakes(): Promise<ManagerKey[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.managersRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const keys: ManagerKey[] = []
    for (const entry of entries) {
      const wakes = await this.pendingWakes(decodeSegment(entry) as ManagerKey)
      if (wakes.length > 0) keys.push(decodeSegment(entry) as ManagerKey)
    }
    return keys
  }

  // ── outbound deliveries ─────────────────────────────────────

  private outboundPath(managerKey: ManagerKey, deliveryId: string): string {
    return join(this.outboundDir(managerKey), `${deliveryId}.json`)
  }

  /** 第一次 Admin send_message RPC 之前原子写 prepared record。 */
  async prepareOutbound(record: Omit<OutboundDeliveryRecord, 'kind' | 'status' | 'created_at' | 'updated_at'>): Promise<void> {
    const now = new Date().toISOString()
    const full: OutboundDeliveryRecord = { kind: 'outbound_delivery', status: 'prepared', created_at: now, updated_at: now, ...record }
    await writeJsonAtomic(this.outboundPath(record.manager_key, record.delivery_id), full)
  }

  async readOutbound(managerKey: ManagerKey, deliveryId: string): Promise<OutboundDeliveryRecord | null> {
    try {
      const raw = await fs.readFile(this.outboundPath(managerKey, deliveryId), 'utf-8')
      return JSON.parse(raw) as OutboundDeliveryRecord
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async markOutbound(managerKey: ManagerKey, deliveryId: string, status: OutboundDeliveryStatus): Promise<void> {
    const record = await this.readOutbound(managerKey, deliveryId)
    if (!record) return
    record.status = status
    record.updated_at = new Date().toISOString()
    await writeJsonAtomic(this.outboundPath(managerKey, deliveryId), record)
  }

  /** startup reconcile：prepared（响应丢失/未发出）与 failed（传输失败，结果未知）
   *  都重放——同一 delivery_id 对 Admin 幂等，收敛靠 Admin 返回首次结果/终态拒绝；
   *  abandoned（永久拒绝）与 confirmed 不重放。 */
  async pendingOutbounds(managerKey: ManagerKey): Promise<OutboundDeliveryRecord[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.outboundDir(managerKey))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: OutboundDeliveryRecord[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const record = JSON.parse(await fs.readFile(join(this.outboundDir(managerKey), entry), 'utf-8')) as OutboundDeliveryRecord
        if (record.status === 'prepared' || record.status === 'failed') records.push(record)
      } catch { /* 坏 record 隔离跳过 */ }
    }
    return records
  }

  /** 确认成功后清理 staging。 */
  async cleanStaging(managerKey: ManagerKey, deliveryId: string): Promise<void> {
    await fs.rm(this.stagingDir(managerKey, deliveryId), { recursive: true, force: true }).catch(() => {})
  }
}

/** canonical dispatch payload 指纹（内容 + exact ordered IDs；不含 staging 路径/UUID 等服务端值）。 */
export function dispatchPayloadSha256(input: { session_id: string; content: unknown; request_ids: string[]; task_id: string | null }): string {
  return createHash('sha256').update(JSON.stringify({
    session_id: input.session_id,
    content: input.content,
    request_ids: input.request_ids,
    task_id: input.task_id,
  })).digest('hex')
}
