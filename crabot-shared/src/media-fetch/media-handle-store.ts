/**
 * MediaHandleStore — handle → 下载凭证 的持久化映射。
 *
 * 入站非图片文件登记一条映射；agent 用 handle 调 fetch_media 时凭此重新解析
 * credential 下载。本地文件被 GC 后仍可凭 handle 重下，故映射须独立于 data/media 持久化。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { MediaHandleRecord } from './types.js'

export class MediaHandleStore {
  private readonly filePath: string
  private map: Map<string, MediaHandleRecord> = new Map()

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'media-handles.json')
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as Record<string, MediaHandleRecord>
      this.map = new Map(Object.entries(raw))
    } catch {
      /* 首次启动无文件 */
    }
  }

  async put(rec: MediaHandleRecord): Promise<string> {
    const handle = `fm_${randomBytes(6).toString('hex')}`
    this.map = new Map(this.map).set(handle, rec)
    try {
      await this.persist()
    } catch (err) {
      // 落盘失败：handle 本次进程内有效（已在内存 map），但重启后丢失。
      // 不上抛——避免一条媒体消息因落盘问题被整体丢弃。
      console.warn('[MediaHandleStore] persist failed, handle will be lost on restart:', err)
    }
    return handle
  }

  get(handle: string): MediaHandleRecord | undefined {
    return this.map.get(handle)
  }

  /** 标记 handle 已下载，缓存本地路径。未知 handle 静默 no-op。落盘失败降级为告警。 */
  async markDownloaded(handle: string, filePath: string): Promise<void> {
    const rec = this.map.get(handle)
    if (!rec) return
    this.map = new Map(this.map).set(handle, { ...rec, downloaded_file_path: filePath })
    try {
      await this.persist()
    } catch (err) {
      console.warn('[MediaHandleStore] markDownloaded persist failed:', err)
    }
  }

  /**
   * 按 credential 查找已有 handle。遍历全表 O(n)，但 handle 总数通常在数百以内。
   * 返回第一个匹配的 handle，或 undefined。
   */
  findByCredential(credential: Record<string, unknown>): string | undefined {
    for (const [handle, rec] of this.map) {
      if (this.credentialMatch(rec.credential, credential)) return handle
    }
    return undefined
  }

  /** 补写 crabot session id（入站时 session 在 applyMediaContent 之后才解析，故分两步）。未知 handle no-op。 */
  async setSessionId(handle: string, sessionId: string): Promise<void> {
    const rec = this.map.get(handle)
    if (!rec) return
    this.map = new Map(this.map).set(handle, { ...rec, session_id: sessionId })
    try {
      await this.persist()
    } catch (err) {
      console.warn('[MediaHandleStore] setSessionId persist failed:', err)
    }
  }

  /** 比较两个 credential 是否逻辑相等（按 key-value 逐项相等，忽略顺序）。 */
  private credentialMatch(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const aKeys = Object.keys(a).sort()
    const bKeys = Object.keys(b).sort()
    if (aKeys.length !== bKeys.length) return false
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false
      if (a[aKeys[i]] !== b[bKeys[i]]) return false
    }
    return true
  }

  private async persist(): Promise<void> {
    const obj = Object.fromEntries(this.map)
    const tmp = `${this.filePath}.${randomBytes(4).toString('hex')}.tmp`
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8')
    await fs.rename(tmp, this.filePath)
  }
}
