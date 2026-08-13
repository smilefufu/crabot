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
  ): Promise<void> {
    if (events.length === 0) return
    const key = `${workerId}#${seq}`
    const tail = this.writeTails.get(key) ?? Promise.resolve()
    const next = tail.then(() => this.appendInner(workerId, seq, fingerprint, events, redact)).catch((error) => {
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
  ): Promise<void> {
    const filePath = this.fileFor(workerId, seq)
    const existing = await this.readHeader(filePath)
    const lines: string[] = []
    if (!existing || existing.incarnation_fingerprint !== fingerprint) {
      // 指纹不一致：整文件替换（旧 copy 属于 seq 碰撞的旧化身，不得混入）。
      const header: CopyHeader = { kind: 'native-trace-copy-header', worker_id: workerId, seq, incarnation_fingerprint: fingerprint }
      lines.push(JSON.stringify(header))
    }
    for (const event of events) {
      lines.push(redact(JSON.stringify(event)))
    }
    await fs.mkdir(join(this.rootDir, encodeURIComponent(workerId)), { recursive: true, mode: 0o700 })
    const tmpPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`
    if (lines[0]?.includes('native-trace-copy-header')) {
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
    const firstLine = raw.split('\n', 1)[0]
    if (!firstLine) return null
    try {
      const parsed = JSON.parse(firstLine) as Partial<CopyHeader>
      return parsed.kind === 'native-trace-copy-header' ? (parsed as CopyHeader) : null
    } catch {
      return null
    }
  }

  /** 等待挂起的写盘全部落地（测试/停机收口用）。 */
  async flush(): Promise<void> {
    await Promise.all(Array.from(this.writeTails.values()))
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
    const lines = raw.split('\n').filter((line) => line.length > 0)
    if (lines.length === 0) return null
    const header = await this.readHeader(filePath)
    if (!header || header.incarnation_fingerprint !== fingerprint) return null
    const events: NormalizedTraceEvent[] = []
    for (const line of lines.slice(1)) {
      try {
        events.push(JSON.parse(line) as NormalizedTraceEvent)
      } catch { /* 坏行跳过（copy 只用于降级展示） */ }
    }
    return { events }
  }
}
