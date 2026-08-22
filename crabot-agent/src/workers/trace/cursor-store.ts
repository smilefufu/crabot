/**
 * Worker trace composite cursor store（P6-A §3.3/§8.12）。
 *
 * 公开 cursor 是随机 opaque token；record 至少绑定 cursor format version、worker ID、
 * 解析出的 incarnation 身份指纹（impl + seq + session_ref/started_at 的安全散列）和
 * 各 source 的位置。同一 token 重放复用首次消费时原子捕获的窗口，不受文件后续追加影响；
 * 清理后的 token 明确抛 INVALID_PARAMS，不得静默从头。
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { createHash, randomBytes } from 'crypto'
import type { WorkerImplId } from '../types.js'
import { RpcError } from 'crabot-shared'

export const TRACE_CURSOR_FORMAT_VERSION = 1

/** 各 source 的消费位置（harness/legacy=事件序，native=已消费原生行数）。 */
export interface TraceSourcePositions {
  readonly harness: number
  readonly native: number
  readonly legacy: number
}

export interface TraceCursorWindow {
  /** 首次消费该 token 时原子捕获的各 source upper bound（含端点）。 */
  readonly end: TraceSourcePositions
  /** 本次窗口消费后生成的下一个 token。 */
  readonly nextToken: string
}

export interface TraceCursorRecord {
  readonly format_version: typeof TRACE_CURSOR_FORMAT_VERSION
  readonly token: string
  readonly worker_id: string
  /** incarnation 身份指纹：实现+seq+session_ref/started_at 的安全散列（seq 碰撞不当唯一身份）。 */
  readonly incarnation_fingerprint: string
  /** 该 token 语义上的消费起点（读事件严格大于这些位置）。 */
  readonly positions: TraceSourcePositions
  /** 首次消费后写入的稳定窗口；未消费过的 token 没有。 */
  window?: TraceCursorWindow
  readonly created_at: string
  last_access_at: string
}

export class InvalidTraceCursorError extends RpcError {
  constructor(message: string) {
    super('INVALID_PARAMS', message)
    this.name = 'InvalidTraceCursorError'
  }
}

const MAX_CURSOR_RECORDS = 512

/** incarnation 身份指纹：只绑不可变身份（impl + seq + started_at）。
 *  session_ref 对 cc/codex 是运行中延后确定的、对 builtin 每轮 burst 前进——把它绑进
 *  指纹会让同一化身在正常运行中换指纹，合法翻页 cursor 被误判成别的化身。 */
export function incarnationFingerprint(input: {
  incarnation_id?: string
  impl: WorkerImplId
  seq: number
  session_ref?: string
  started_at?: string
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      incarnation_id: input.incarnation_id ?? '',
      impl: input.impl,
      seq: input.seq,
      started_at: input.started_at ?? '',
    }))
    .digest('hex')
    .slice(0, 32)
}

/**
 * `incarnation_id` 进入台账前，native copy 仅按实现、seq 和启动时间绑定。
 * 此摘要只用于把那一代已存在的 copy 原子升级到当前身份，绝不能用于新 copy 的常规匹配。
 */
export function legacyIncarnationFingerprint(input: {
  impl: WorkerImplId
  seq: number
  session_ref?: string
  started_at?: string
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      impl: input.impl,
      seq: input.seq,
      started_at: input.started_at ?? '',
    }))
    .digest('hex')
    .slice(0, 32)
}

export class TraceCursorStore {
  private readonly records = new Map<string, TraceCursorRecord>()
  private loaded = false
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly dir: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let entries: string[]
    try {
      entries = await fs.readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const raw = JSON.parse(await fs.readFile(join(this.dir, entry), 'utf-8')) as TraceCursorRecord
        if (raw.format_version !== TRACE_CURSOR_FORMAT_VERSION || typeof raw.token !== 'string') continue
        this.records.set(raw.token, raw)
      } catch { /* 坏 record 隔离跳过 */ }
    }
  }

  private persist(record: TraceCursorRecord): void {
    this.writeTail = this.writeTail.then(async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
      const finalPath = join(this.dir, `${record.token}.json`)
      const tmpPath = `${finalPath}.tmp-${randomBytes(6).toString('hex')}`
      await fs.writeFile(tmpPath, JSON.stringify(record), { mode: 0o600 })
      await fs.rename(tmpPath, finalPath)
    }).catch((error) => {
      console.warn('[TraceCursorStore] persist failed:', error instanceof Error ? error.message : String(error))
    })
  }

  /** 新 token：只记录 positions，窗口等首次消费时捕获。 */
  async mint(workerId: string, fingerprint: string, positions: TraceSourcePositions): Promise<string> {
    await this.ensureLoaded()
    const token = randomBytes(24).toString('base64url')
    const now = new Date().toISOString()
    const record: TraceCursorRecord = {
      format_version: TRACE_CURSOR_FORMAT_VERSION,
      token,
      worker_id: workerId,
      incarnation_fingerprint: fingerprint,
      positions,
      created_at: now,
      last_access_at: now,
    }
    this.records.set(token, record)
    this.persist(record)
    this.gc()
    return token
  }

  /**
   * 解析并校验 token。worker/化身不匹配、格式错误、已被 GC 一律 INVALID_PARAMS。
   */
  async resolve(token: string, workerId: string, fingerprint: string): Promise<TraceCursorRecord> {
    await this.ensureLoaded()
    const record = this.records.get(token)
    if (!record) throw new InvalidTraceCursorError(`unknown or expired trace cursor`)
    if (record.worker_id !== workerId) throw new InvalidTraceCursorError('trace cursor belongs to a different worker')
    if (record.incarnation_fingerprint !== fingerprint) {
      throw new InvalidTraceCursorError('trace cursor belongs to a different incarnation')
    }
    record.last_access_at = new Date().toISOString()
    this.persist(record)
    return record
  }

  /** 首次消费时写入稳定窗口；同 token 重放复用既有窗口（后续文件追加不影响）。 */
  async captureWindow(token: string, window: TraceCursorWindow): Promise<void> {
    const record = this.records.get(token)
    if (!record) throw new InvalidTraceCursorError('unknown or expired trace cursor')
    if (record.window) return // 重放：复用既有窗口
    record.window = window
    record.last_access_at = new Date().toISOString()
    this.persist(record)
  }

  /** 等待挂起的写盘全部落地（测试/停机收口用）。 */
  async flush(): Promise<void> {
    await this.writeTail
  }

  /** 有界 GC：超出容量按 last_access 最旧先删。 */
  private gc(): void {
    if (this.records.size <= MAX_CURSOR_RECORDS) return
    const sorted = Array.from(this.records.values()).sort((a, b) => a.last_access_at.localeCompare(b.last_access_at))
    for (const record of sorted.slice(0, this.records.size - MAX_CURSOR_RECORDS)) {
      this.records.delete(record.token)
      this.writeTail = this.writeTail.then(() => fs.rm(join(this.dir, `${record.token}.json`), { force: true }).catch(() => {}))
    }
  }
}
