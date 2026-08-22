/**
 * Agent-owned native trace copy（P6-A §8.10/§8.11）。
 *
 * 每次成功 native read 把脱敏、属于本化身的记录增量写这里；化身终态后 live source
 * 消失时 composite reader 回退读这份 copy。写入绑定 incarnation 指纹——指纹不一致
 * 的 copy 属于另一个（seq 碰撞的）化身，不得混读。
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { NormalizedTraceEvent } from '../types.js'

interface CopyHeader {
  readonly kind: 'native-trace-copy-header'
  readonly worker_id: string
  readonly seq: number
  readonly incarnation_fingerprint: string
}

export class NativeTraceCopyStore {
  private readonly writeTails = new Map<string, Promise<void>>()

  constructor(private readonly rootDir: string) {}

  private fileFor(workerId: string, seq: number): string {
    return join(this.rootDir, encodeURIComponent(workerId), `seq-${seq}.jsonl`)
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
}
