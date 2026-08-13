/**
 * MediaStore — 带 TTL 的简易媒体存储（spec 2026-06-10-master-chat-redesign Phase 2 / protocol-admin §3.20.4）
 *
 * 目录布局：{baseDir}/media-store/<uuid><ext> + index.json（元数据）+ config.json（ttl_days）。
 * 临时存储定位：每日清扫超期文件，引用方（聊天历史）过期后显示占位。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { MediaItem, MediaStoreConfig, MediaUsage } from './types.js'

interface MediaIndexEntry {
  id: string
  ext: string
  filename: string
  mime_type: string
  size: number
  created_at: string
}

const DEFAULT_TTL_DAYS = 30
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** mime → 扩展名（仅常见类型，未知用 .bin） */
function extFor(mime: string, filename?: string): string {
  const fromName = filename ? path.extname(filename) : ''
  if (fromName && /^\.[A-Za-z0-9]{1,8}$/.test(fromName)) return fromName.toLowerCase()
  const map: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'application/pdf': '.pdf', 'text/plain': '.txt',
  }
  return map[mime] ?? '.bin'
}

export class MediaStore {
  private index: Map<string, MediaIndexEntry> = new Map()
  private config: MediaStoreConfig = { ttl_days: DEFAULT_TTL_DAYS }
  private readonly storeDir: string
  private readonly indexPath: string
  private readonly configPath: string
  /** index.json 写盘串行链：防止并发写时过期快照后落盘（lost update） */
  private indexWriteChain: Promise<void> = Promise.resolve()

  constructor(baseDir: string) {
    this.storeDir = path.join(baseDir, 'media-store')
    this.indexPath = path.join(this.storeDir, 'index.json')
    this.configPath = path.join(this.storeDir, 'config.json')
  }

  async init(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true })
    try {
      const entries = JSON.parse(await fs.readFile(this.indexPath, 'utf-8')) as MediaIndexEntry[]
      this.index = new Map(entries.map((e) => [e.id, e]))
    } catch { /* 首次启动无 index */ }
    try {
      const cfg = JSON.parse(await fs.readFile(this.configPath, 'utf-8')) as MediaStoreConfig
      if (typeof cfg.ttl_days === 'number') this.config = { ttl_days: cfg.ttl_days }
    } catch { /* 默认配置 */ }
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    // tmp 名带随机后缀：并发 saveIndex 时共享固定 tmp 名会让先 rename 的一方
    // 把另一方的 tmp 抢走（ENOENT），调用方平白收到失败
    const tmp = `${filePath}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(tmp, content, 'utf-8')
    await fs.rename(tmp, filePath)
  }

  private async saveIndex(): Promise<void> {
    // 快照必须在轮到自己写时才做（链内），否则并发场景下先到的过期快照
    // 可能最后落盘，丢掉后来者的条目
    const run = this.indexWriteChain.then(() =>
      this.atomicWrite(this.indexPath, JSON.stringify(Array.from(this.index.values()), null, 2))
    )
    // 链条自身吞错防止毒化后续写；本次调用方仍能拿到失败
    this.indexWriteChain = run.catch(() => {})
    return run
  }

  private filePathOf(entry: MediaIndexEntry): string {
    return path.join(this.storeDir, `${entry.id}${entry.ext}`)
  }

  private toItem(entry: MediaIndexEntry): MediaItem {
    return {
      media_url: `/api/media/${entry.id}`,
      mime_type: entry.mime_type,
      filename: entry.filename,
      size: entry.size,
    }
  }

  async saveBuffer(
    buf: Buffer,
    opts: { filename: string; mime_type: string },
  ): Promise<{ id: string; abs_path: string; item: MediaItem }> {
    const id = crypto.randomUUID()
    const entry: MediaIndexEntry = {
      id,
      ext: extFor(opts.mime_type, opts.filename),
      filename: opts.filename,
      mime_type: opts.mime_type,
      size: buf.length,
      created_at: new Date().toISOString(),
    }
    const absPath = this.filePathOf(entry)
    await fs.writeFile(absPath, buf)
    this.index.set(id, entry)
    await this.saveIndex()
    return { id, abs_path: path.resolve(absPath), item: this.toItem(entry) }
  }

  // ── P6-A §11：无业务语义的 stage/promote/rollback（delivery journal 复用）─────────
  // stage 只写 staging 文件（不进 index、不可见）；promote 把 planned UUID 的文件落进 store
  // 并登记 index；rollback 删 staging。planned media_url 在 stage 时即可算出（幂等）。

  /** 预分配 media UUID 并写出 staging 文件；返回 planned entry 与 URL（未进 index，不可见）。 */
  async stageBuffer(
    buf: Buffer,
    opts: { filename: string; mime_type: string },
    stagingDir: string,
  ): Promise<{ planned_id: string; staged_path: string; entry: MediaIndexEntry; media_url: string }> {
    const plannedId = crypto.randomUUID()
    const entry: MediaIndexEntry = {
      id: plannedId,
      ext: extFor(opts.mime_type, opts.filename),
      filename: opts.filename,
      mime_type: opts.mime_type,
      size: buf.length,
      created_at: new Date().toISOString(),
    }
    await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 })
    const stagedPath = path.join(stagingDir, `${plannedId}${entry.ext}`)
    await fs.writeFile(stagedPath, buf, { mode: 0o600 })
    return { planned_id: plannedId, staged_path: stagedPath, entry, media_url: this.toItem(entry).media_url }
  }

  /**
   * 把 staged 文件按 planned UUID promote 进 store + index。崩溃窗口幂等：
   * 「已 rename、index 未落盘」时 staged 文件已不在——只要最终文件存在就只补登记，
   * 不抛 ENOENT（否则 delivery 永久 commit 不了、request 永远 pending）。
   */
  async promoteStaged(stagedPath: string, entry: MediaIndexEntry): Promise<MediaItem> {
    const existing = this.index.get(entry.id)
    if (existing) return this.toItem(existing)
    const finalPath = this.filePathOf(entry)
    const stagedExists = await fs.access(stagedPath).then(() => true).catch(() => false)
    if (stagedExists) {
      await fs.rename(stagedPath, finalPath)
    } else {
      const finalExists = await fs.access(finalPath).then(() => true).catch(() => false)
      if (!finalExists) throw new Error(`staged media missing: ${stagedPath}`)
    }
    this.index.set(entry.id, entry)
    await this.saveIndex()
    return this.toItem(entry)
  }

  /** 丢弃 staged 文件（未进 index，直接删）。 */
  async rollbackStaged(stagedPath: string): Promise<void> {
    await fs.rm(stagedPath, { force: true }).catch(() => {})
  }

  /** 复制外部文件进 store（出站收存：worker 的 file_path / 本地路径形态 media_url） */
  async ingestFile(
    srcAbsPath: string,
    opts?: { filename?: string; mime_type?: string },
  ): Promise<MediaItem> {
    const buf = await fs.readFile(srcAbsPath)
    const filename = opts?.filename ?? path.basename(srcAbsPath)
    const mime = opts?.mime_type ?? 'application/octet-stream'
    const { item } = await this.saveBuffer(buf, { filename, mime_type: mime })
    return item
  }

  /** id → 磁盘信息；非法/不存在返回 null（id 白名单防路径穿越） */
  resolve(id: string): { abs_path: string; mime_type: string; filename: string } | null {
    if (!UUID_PATTERN.test(id)) return null
    const entry = this.index.get(id)
    if (!entry) return null
    return {
      abs_path: path.resolve(this.filePathOf(entry)),
      mime_type: entry.mime_type,
      filename: entry.filename,
    }
  }

  async getUsage(): Promise<MediaUsage> {
    let total = 0
    for (const entry of this.index.values()) total += entry.size
    return { file_count: this.index.size, total_bytes: total, ttl_days: this.config.ttl_days }
  }

  getConfig(): MediaStoreConfig {
    return { ...this.config }
  }

  async setConfig(cfg: MediaStoreConfig): Promise<void> {
    if (!Number.isInteger(cfg.ttl_days) || cfg.ttl_days < 1 || cfg.ttl_days > 365) {
      throw new Error('ttl_days 必须是 1-365 的整数')
    }
    this.config = { ttl_days: cfg.ttl_days }
    await this.atomicWrite(this.configPath, JSON.stringify(this.config, null, 2))
    // 改保存天数立即按新期限清扫：用户缩短 TTL 通常就是为了马上回收空间，
    // 不该让效果等到下一次每日清扫（最长 24h 后）才可见
    await this.sweepExpired()
  }

  /** 清扫超期文件；返回删除数。失败的单个文件跳过不中断。 */
  async sweepExpired(nowMs: number = Date.now()): Promise<number> {
    const ttlMs = this.config.ttl_days * 86400_000
    let deleted = 0
    for (const entry of Array.from(this.index.values())) {
      if (nowMs - Date.parse(entry.created_at) <= ttlMs) continue
      try {
        await fs.unlink(this.filePathOf(entry)).catch(() => {})
        this.index.delete(entry.id)
        deleted++
      } catch { /* 单文件失败跳过 */ }
    }
    if (deleted > 0) await this.saveIndex()
    return deleted
  }
}
