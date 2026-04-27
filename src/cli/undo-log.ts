import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 100

export interface UndoEntryInput {
  readonly original_command: string
  readonly reverse: { readonly command: string; readonly preview_description: string }
  readonly actor: string
  readonly snapshot: unknown
}

export interface UndoEntry extends UndoEntryInput {
  readonly id: string
  readonly executed_at: string
  readonly expires_at: string
}

export interface UndoLogOptions {
  readonly now?: () => number
  readonly maxEntries?: number
}

const SENSITIVE_FLAG_RE = /(--?(?:apikey|api[-_]?key|password|secret|token|client[-_]?secret|webhook[-_]?secret))(\s+|=)([^\s]+)/gi

function maskCommandLine(cmd: string): string {
  return cmd.replace(SENSITIVE_FLAG_RE, (_, flag, sep) => `${flag}${sep}***`)
}

export class UndoLog {
  private readonly logPath: string
  private readonly now: () => number
  private readonly maxEntries: number
  private lastTimestamp = 0

  constructor(dataDir: string, opts: UndoLogOptions = {}) {
    const cliDir = join(dataDir, 'cli')
    mkdirSync(cliDir, { recursive: true })
    this.logPath = join(cliDir, 'undo-log.jsonl')
    this.now = opts.now ?? Date.now
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  async append(input: UndoEntryInput): Promise<UndoEntry> {
    let ts = this.now()
    // 保证单调递增
    if (ts <= this.lastTimestamp) ts = this.lastTimestamp + 1
    this.lastTimestamp = ts

    const entry: UndoEntry = {
      id: `undo-${Math.floor(ts / 1000)}-${randomBytes(2).toString('hex')}`,
      executed_at: new Date(ts).toISOString(),
      expires_at: new Date(ts + TTL_MS).toISOString(),
      actor: input.actor,
      original_command: maskCommandLine(input.original_command),
      reverse: input.reverse,
      snapshot: input.snapshot,
    }
    appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf-8')
    await this.gc()
    return entry
  }

  async list(): Promise<ReadonlyArray<UndoEntry>> {
    let raw: string
    try {
      raw = readFileSync(this.logPath, 'utf-8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    const now = this.now()
    const valid: UndoEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as UndoEntry
        if (Date.parse(e.expires_at) > now) valid.push(e)
      } catch { /* skip malformed */ }
    }
    return valid.sort((a, b) => Date.parse(b.executed_at) - Date.parse(a.executed_at))
  }

  async findById(id: string): Promise<UndoEntry | null> {
    const items = await this.list()
    return items.find(e => e.id === id) ?? null
  }

  async removeById(id: string): Promise<void> {
    const items = await this.list()
    const remaining = items.filter(e => e.id !== id)
    this.rewrite(remaining)
  }

  private async gc(): Promise<void> {
    // list() 返回倒序（最新优先）
    const items = await this.list()
    // 如果超过上限，保留最新的 maxEntries 条
    const toKeep = items.length > this.maxEntries ? items.slice(0, this.maxEntries) : items
    // 反转回插入顺序（最旧的在前），然后写入文件
    this.rewrite([...toKeep].reverse())
  }

  private rewrite(items: ReadonlyArray<UndoEntry>): void {
    // items 是插入顺序（最旧的在前，最新的在后）
    const text = items.map(e => JSON.stringify(e)).join('\n') + (items.length > 0 ? '\n' : '')
    writeFileSync(this.logPath, text, 'utf-8')
  }
}
