/**
 * Agent-owned native trace copy（P6-A §8.10/§8.11）。
 *
 * 每次成功 native read 把脱敏、属于本化身的记录增量写这里；化身终态后 live source
 * 消失时 composite reader 回退读这份 copy。写入绑定 incarnation 指纹——指纹不一致
 * 的 copy 属于另一个（seq 碰撞的）化身，不得混读。
 */

import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import type { NormalizedTraceEvent, WorkerSubagentSummary } from '../types.js'

interface CopyHeader {
  readonly kind: 'native-trace-copy-header'
  readonly worker_id: string
  readonly seq: number
  readonly incarnation_fingerprint: string
}

interface SubagentCopyHeader {
  readonly kind: 'native-subagent-trace-copy-header'
  readonly worker_id: string
  readonly parent_incarnation_id?: string
  readonly subagent_id: string
  readonly subagent_fingerprint: string
  readonly summary: WorkerSubagentSummary
  /** `pending` means the child identity is durable, but its terminal source was not copied yet. */
  readonly capture_status: 'pending' | 'complete'
  /** Native cursor after the full terminal read; preserves skipped raw records on fallback. */
  readonly next_cursor_offset?: number
  readonly unavailable_reason?: string
}

export interface StoredSubagentTrace {
  readonly summary: WorkerSubagentSummary
  readonly parent_incarnation_id?: string
  readonly capture_status: 'pending' | 'complete'
  readonly next_cursor_offset?: number
  readonly unavailable_reason?: string
  readonly events: NormalizedTraceEvent[]
}

export interface PendingSubagentCapture {
  readonly worker_id: string
  readonly parent_incarnation_id?: string
  readonly subagent_id: string
  readonly subagent_fingerprint: string
  readonly summary: WorkerSubagentSummary
}

export class NativeTraceCopyStore {
  private readonly writeTails = new Map<string, Promise<void>>()

  constructor(private readonly rootDir: string) {}

  private fileFor(workerId: string, seq: number): string {
    return join(this.rootDir, encodeURIComponent(workerId), `seq-${seq}.jsonl`)
  }

  private subagentFileFor(workerId: string, subagentId: string): string {
    return join(this.rootDir, encodeURIComponent(workerId), 'subagents', `${encodeURIComponent(subagentId)}.jsonl`)
  }

  /** 追加本化身的脱敏 native 事件；header 指纹不一致时整文件替换（旧 copy 属于死化身）。 */
  async append(
    workerId: string,
    seq: number,
    fingerprint: string,
    events: ReadonlyArray<NormalizedTraceEvent>,
    redact: (text: string) => string,
    options: { replace?: boolean } = {},
  ): Promise<void> {
    if (events.length === 0) return
    const key = `${workerId}#${seq}`
    const tail = this.writeTails.get(key) ?? Promise.resolve()
    const next = tail.then(() => this.appendInner(workerId, seq, fingerprint, events, redact, options.replace === true)).catch((error) => {
      console.warn(`[NativeTraceCopyStore] append failed for ${key}:`, error instanceof Error ? error.message : String(error))
    })
    this.writeTails.set(key, next)
    return next
  }

  private async appendInner(
    workerId: string,
    seq: number,
    fingerprint: string,
    events: ReadonlyArray<NormalizedTraceEvent>,
    redact: (text: string) => string,
    replace = false,
  ): Promise<void> {
    const filePath = this.fileFor(workerId, seq)
    const existing = await this.readHeader(filePath)
    if (!replace && existing?.incarnation_fingerprint === fingerprint) {
      // 按 source_offset 去重：同一化身的重复首读/翻页不得把整段 native 再追加一遍。
      // 去重必须先限定同化身——文件属于旧化身（seq 碰撞）时不能拿它的 offset 砍新内容。
      const maxOffset = await this.readMaxOffset(filePath)
      if (maxOffset !== null) {
        events = events.filter((event) => event.source_offset !== undefined && event.source_offset > maxOffset)
        if (events.length === 0) return
      }
    }
    const lines: string[] = []
    const rewrite = replace || !existing || existing.incarnation_fingerprint !== fingerprint
    if (rewrite) {
      // 指纹不一致：整文件替换（旧 copy 属于 seq 碰撞的旧化身，不得混入）。
      const header: CopyHeader = { kind: 'native-trace-copy-header', worker_id: workerId, seq, incarnation_fingerprint: fingerprint }
      lines.push(JSON.stringify(header))
    }
    for (const event of events) {
      lines.push(redact(JSON.stringify(event)))
    }
    await fs.mkdir(join(this.rootDir, encodeURIComponent(workerId)), { recursive: true, mode: 0o700 })
    const tmpPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`
    if (rewrite) {
      // 新 header：整文件重写（已有内容属于旧化身）。
      await fs.writeFile(tmpPath, lines.join('\n') + '\n', { mode: 0o600 })
      await fs.rename(tmpPath, filePath)
    } else {
      await fs.appendFile(filePath, lines.join('\n') + '\n', { mode: 0o600 })
    }
  }

  private async readHeader(filePath: string): Promise<CopyHeader | null> {
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    return this.parseHeader(raw)
  }

  private parseHeader(raw: string): CopyHeader | null {
    const firstLine = raw.split('\n', 1)[0]
    if (!firstLine) return null
    try {
      const parsed = JSON.parse(firstLine) as Partial<CopyHeader>
      return parsed.kind === 'native-trace-copy-header' ? (parsed as CopyHeader) : null
    } catch {
      return null
    }
  }

  private eventsFromRaw(raw: string): NormalizedTraceEvent[] {
    const events: NormalizedTraceEvent[] = []
    for (const line of raw.split('\n').filter((line) => line.length > 0).slice(1)) {
      try {
        events.push(JSON.parse(line) as NormalizedTraceEvent)
      } catch { /* 坏行跳过（copy 只用于降级展示） */ }
    }
    return events
  }

  /** 等待挂起的写盘全部落地（测试/停机收口用）。 */
  async flush(): Promise<void> {
    await Promise.all(Array.from(this.writeTails.values()))
  }

  /** copy 里已写的最大 source_offset（去重依据）；无文件/无事件返回 null。 */
  private async readMaxOffset(filePath: string): Promise<number | null> {
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const lines = raw.split('\n').filter((line) => line.length > 0)
    let max: number | null = null
    for (const line of lines.slice(1)) {
      try {
        const offset = (JSON.parse(line) as NormalizedTraceEvent).source_offset
        if (offset !== undefined && (max === null || offset > max)) max = offset
      } catch { /* skip */ }
    }
    return max
  }

  /** 读取 copy；不存在或指纹不匹配返回 null（不得混读其它化身的 copy）。 */
  async read(
    workerId: string,
    seq: number,
    fingerprint: string,
  ): Promise<{ events: NormalizedTraceEvent[] } | null> {
    const filePath = this.fileFor(workerId, seq)
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const header = this.parseHeader(raw)
    if (!header || header.incarnation_fingerprint !== fingerprint) return null
    return { events: this.eventsFromRaw(raw) }
  }

  /**
   * 只在 live native source 已不可读时接受 pre-incarnation copy，并把 header 原子升级。
   * 旧摘要必须逐字匹配当时的绑定算法；新摘要不匹配仍绝不混读。
   */
  async readLegacyAndUpgrade(
    workerId: string,
    seq: number,
    legacyFingerprint: string,
    fingerprint: string,
  ): Promise<{ events: NormalizedTraceEvent[] } | null> {
    const key = `${workerId}#${seq}`
    const tail = this.writeTails.get(key) ?? Promise.resolve()
    const next = tail.then(async () => {
      const filePath = this.fileFor(workerId, seq)
      let raw: string
      try {
        raw = await fs.readFile(filePath, 'utf-8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      const header = this.parseHeader(raw)
      if (header?.incarnation_fingerprint === fingerprint) {
        return { events: this.eventsFromRaw(raw) }
      }
      if (
        !header
        || header.worker_id !== workerId
        || header.seq !== seq
        || header.incarnation_fingerprint !== legacyFingerprint
      ) return null

      const lineEnd = raw.indexOf('\n')
      const body = lineEnd === -1 ? '' : raw.slice(lineEnd + 1)
      const replacement: CopyHeader = {
        kind: 'native-trace-copy-header',
        worker_id: workerId,
        seq,
        incarnation_fingerprint: fingerprint,
      }
      const tmpPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`
      // 只替换 header；已经脱敏的原始 event 行按字节保留，不再经过第二次 redaction。
      await fs.writeFile(tmpPath, `${JSON.stringify(replacement)}\n${body}`, { mode: 0o600 })
      await fs.rename(tmpPath, filePath)
      return { events: this.eventsFromRaw(raw) }
    })
    // 后续 append 必须排在 header 升级之后，避免将旧副本误判为另一化身而覆盖。
    this.writeTails.set(key, next.then(() => undefined, () => undefined))
    return next
  }

  /**
   * First durable step for a terminal CLI child. Keeping this marker before the
   * native read means a failed final write remains discoverable and can be
   * retried at the next terminal/startup harvest.
   */
  async beginSubagentCapture(
    workerId: string,
    parentIncarnationId: string | undefined,
    summary: WorkerSubagentSummary,
    fingerprint: string,
    redact: (text: string) => string,
  ): Promise<void> {
    this.assertSubagentOwner(workerId, summary)
    const key = `subagent:${workerId}:${summary.subagent_id}`
    await this.enqueue(key, async () => {
      const filePath = this.subagentFileFor(workerId, summary.subagent_id)
      const existing = await this.readSubagentHeader(filePath)
      if (
        existing?.worker_id === workerId
        && existing.subagent_id === summary.subagent_id
        && existing.subagent_fingerprint === fingerprint
        && existing.capture_status === 'complete'
      ) return
      await this.writeSubagentFile(filePath, {
        kind: 'native-subagent-trace-copy-header',
        worker_id: workerId,
        ...(parentIncarnationId === undefined ? {} : { parent_incarnation_id: parentIncarnationId }),
        subagent_id: summary.subagent_id,
        subagent_fingerprint: fingerprint,
        summary,
        capture_status: 'pending',
      }, [], redact)
    })
  }

  /** Persist a complete, redacted terminal child trace after its native source was read. */
  async completeSubagentCapture(
    workerId: string,
    parentIncarnationId: string | undefined,
    summary: WorkerSubagentSummary,
    fingerprint: string,
    events: ReadonlyArray<NormalizedTraceEvent>,
    nextCursorOffset: number,
    redact: (text: string) => string,
  ): Promise<void> {
    this.assertSubagentOwner(workerId, summary)
    const key = `subagent:${workerId}:${summary.subagent_id}`
    await this.enqueue(key, async () => {
      await this.writeSubagentFile(this.subagentFileFor(workerId, summary.subagent_id), {
        kind: 'native-subagent-trace-copy-header',
        worker_id: workerId,
        ...(parentIncarnationId === undefined ? {} : { parent_incarnation_id: parentIncarnationId }),
        subagent_id: summary.subagent_id,
        subagent_fingerprint: fingerprint,
        summary,
        capture_status: 'complete',
        next_cursor_offset: nextCursorOffset,
      }, events, redact)
    })
  }

  /** Keep the child identity visible when the source disappears before a final copy can be made. */
  async markSubagentCaptureUnavailable(
    workerId: string,
    parentIncarnationId: string | undefined,
    summary: WorkerSubagentSummary,
    fingerprint: string,
    unavailableReason: string,
    redact: (text: string) => string,
  ): Promise<void> {
    this.assertSubagentOwner(workerId, summary)
    const key = `subagent:${workerId}:${summary.subagent_id}`
    await this.enqueue(key, async () => {
      const filePath = this.subagentFileFor(workerId, summary.subagent_id)
      const existing = await this.readSubagentHeader(filePath)
      if (
        existing?.worker_id === workerId
        && existing.subagent_id === summary.subagent_id
        && existing.subagent_fingerprint === fingerprint
        && existing.capture_status === 'complete'
      ) return
      await this.writeSubagentFile(filePath, {
        kind: 'native-subagent-trace-copy-header',
        worker_id: workerId,
        ...(parentIncarnationId === undefined ? {} : { parent_incarnation_id: parentIncarnationId }),
        subagent_id: summary.subagent_id,
        subagent_fingerprint: fingerprint,
        summary,
        capture_status: 'pending',
        unavailable_reason: unavailableReason,
      }, [], redact)
    })
  }

  /** Read one retained child; mismatched identity is never allowed to cross a Worker boundary. */
  async readSubagent(
    workerId: string,
    subagentId: string,
    fingerprint: string,
  ): Promise<StoredSubagentTrace | null> {
    const filePath = this.subagentFileFor(workerId, subagentId)
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const header = this.parseSubagentHeader(raw)
    if (
      !header
      || header.worker_id !== workerId
      || header.subagent_id !== subagentId
      || header.subagent_fingerprint !== fingerprint
    ) return null
    return {
      summary: header.summary,
      ...(header.parent_incarnation_id === undefined ? {} : { parent_incarnation_id: header.parent_incarnation_id }),
      capture_status: header.capture_status,
      ...(header.next_cursor_offset === undefined ? {} : { next_cursor_offset: header.next_cursor_offset }),
      ...(header.unavailable_reason === undefined ? {} : { unavailable_reason: header.unavailable_reason }),
      events: this.eventsFromRaw(raw),
    }
  }

  /** Enumerate only durable child captures that still need a terminal source read. */
  async listPendingSubagentCaptures(): Promise<PendingSubagentCapture[]> {
    let workerEntries: string[]
    try {
      workerEntries = await fs.readdir(this.rootDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const pending: PendingSubagentCapture[] = []
    for (const workerEntry of workerEntries) {
      const subagentsDir = join(this.rootDir, workerEntry, 'subagents')
      let childEntries: string[]
      try {
        childEntries = await fs.readdir(subagentsDir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const childEntry of childEntries) {
        if (!childEntry.endsWith('.jsonl')) continue
        const header = await this.readSubagentHeader(join(subagentsDir, childEntry))
        if (!header || header.capture_status !== 'pending') continue
        pending.push({
          worker_id: header.worker_id,
          ...(header.parent_incarnation_id === undefined ? {} : { parent_incarnation_id: header.parent_incarnation_id }),
          subagent_id: header.subagent_id,
          subagent_fingerprint: header.subagent_fingerprint,
          summary: header.summary,
        })
      }
    }
    return pending
  }

  /** Retained child summaries are the fallback only; live adapter records always take precedence. */
  async listSubagents(workerId: string, parentIncarnationId?: string): Promise<WorkerSubagentSummary[]> {
    const dir = join(this.rootDir, encodeURIComponent(workerId), 'subagents')
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const summaries: WorkerSubagentSummary[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const header = await this.readSubagentHeader(join(dir, entry))
      if (
        header?.worker_id === workerId
        && header.summary.worker_id === workerId
        && (parentIncarnationId === undefined || header.parent_incarnation_id === parentIncarnationId)
      ) {
        summaries.push(header.summary)
      }
    }
    return summaries.sort((left, right) => (right.started_at ?? '').localeCompare(left.started_at ?? ''))
  }

  /** PR B's Worker-retention transaction removes this whole Worker-owned directory. */
  async removeWorker(workerId: string): Promise<void> {
    const prefix = `${workerId}#`
    const childPrefix = `subagent:${workerId}:`
    await Promise.all(Array.from(this.writeTails.entries())
      .filter(([key]) => key.startsWith(prefix) || key.startsWith(childPrefix))
      .map(([, tail]) => tail))
    await fs.rm(join(this.rootDir, encodeURIComponent(workerId)), { recursive: true, force: true })
  }

  private assertSubagentOwner(workerId: string, summary: WorkerSubagentSummary): void {
    if (summary.worker_id !== workerId) {
      throw new Error(`subagent ${summary.subagent_id} does not belong to worker ${workerId}`)
    }
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const tail = this.writeTails.get(key) ?? Promise.resolve()
    const next = tail.then(operation)
    this.writeTails.set(key, next.then(() => undefined, () => undefined))
    return next
  }

  private async writeSubagentFile(
    filePath: string,
    header: SubagentCopyHeader,
    events: ReadonlyArray<NormalizedTraceEvent>,
    redact: (text: string) => string,
  ): Promise<void> {
    const lines = [
      redact(JSON.stringify(header)),
      ...events.map((event) => redact(JSON.stringify(event))),
    ]
    await fs.mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    const tmpPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`
    await fs.writeFile(tmpPath, `${lines.join('\n')}\n`, { mode: 0o600 })
    await fs.rename(tmpPath, filePath)
  }

  private async readSubagentHeader(filePath: string): Promise<SubagentCopyHeader | null> {
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    return this.parseSubagentHeader(raw)
  }

  private parseSubagentHeader(raw: string): SubagentCopyHeader | null {
    const firstLine = raw.split('\n', 1)[0]
    if (!firstLine) return null
    try {
      const parsed = JSON.parse(firstLine) as Partial<SubagentCopyHeader>
      return parsed.kind === 'native-subagent-trace-copy-header'
        && typeof parsed.worker_id === 'string'
        && typeof parsed.subagent_id === 'string'
        && typeof parsed.subagent_fingerprint === 'string'
        && parsed.summary !== undefined
        && (parsed.capture_status === 'pending' || parsed.capture_status === 'complete')
        ? parsed as SubagentCopyHeader
        : null
    } catch {
      return null
    }
  }
}
