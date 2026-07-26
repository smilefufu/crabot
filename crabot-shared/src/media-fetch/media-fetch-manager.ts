import { type Event, generateId, generateTimestamp } from '../base-protocol.js'
import { MediaHandleStore } from './media-handle-store.js'
import type { FetchMediaResult, MediaDownloadFn, MediaHandleRecord } from './types.js'
import fs from 'node:fs'

const DEFAULT_ASYNC_THRESHOLD = 10 * 1024 * 1024 // 10MB
const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB

export interface MediaFetchManagerDeps {
  store: MediaHandleStore
  channelId: string
  download: MediaDownloadFn
  publishEvent: (event: Event) => Promise<void>
  asyncThresholdBytes?: number
  maxFileSizeBytes?: number
}

export class MediaFetchManager {
  private readonly inProgress = new Set<string>()
  private readonly asyncThreshold: number
  private readonly maxFileSize: number

  constructor(private readonly deps: MediaFetchManagerDeps) {
    this.asyncThreshold = deps.asyncThresholdBytes ?? DEFAULT_ASYNC_THRESHOLD
    this.maxFileSize = deps.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE
  }

  async fetch(handle: string): Promise<FetchMediaResult> {
    const rec = this.deps.store.get(handle)
    if (!rec) return { status: 'failed', error: `unknown media handle: ${handle}` }
    if (rec.size !== undefined && rec.size > this.maxFileSize) {
      return { status: 'failed', error: `file too large: ${rec.size} bytes exceeds inbound limit ${this.maxFileSize} bytes` }
    }
    if (rec.downloaded_file_path && fs.existsSync(rec.downloaded_file_path)) {
      return {
        status: 'ready',
        file_path: rec.downloaded_file_path,
        ...(rec.mime_type !== undefined ? { mime_type: rec.mime_type } : {}),
        ...(rec.size !== undefined ? { size: rec.size } : {}),
      }
    }
    if (rec.size !== undefined && rec.size >= this.asyncThreshold) {
      if (!this.inProgress.has(handle)) {
        this.inProgress.add(handle)
        void this.downloadInBackground(handle, rec)
      }
      return { status: 'fetching' }
    }
    let r: Awaited<ReturnType<MediaDownloadFn>>
    try {
      r = await this.deps.download(rec)
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
    if (!r) return { status: 'failed', error: `download failed for handle ${handle}` }
    await this.deps.store.markDownloaded(handle, r.filePath)
    return {
      status: 'ready',
      file_path: r.filePath,
      ...(r.mimeType !== undefined ? { mime_type: r.mimeType } : {}),
      ...(r.size !== undefined ? { size: r.size } : {}),
    }
  }

  private async downloadInBackground(handle: string, rec: MediaHandleRecord): Promise<void> {
    let status: 'ready' | 'failed' = 'failed'
    let error: string | undefined
    try {
      const r = await this.deps.download(rec)
      if (r) {
        await this.deps.store.markDownloaded(handle, r.filePath)
        status = 'ready'
      } else {
        error = `download failed for handle ${handle}`
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      this.inProgress.delete(handle)
    }
    const event: Event = {
      id: generateId(),
      type: 'media.download_completed',
      source: this.deps.channelId,
      payload: {
        channel_id: this.deps.channelId,
        ...(rec.session_id ? { session_id: rec.session_id } : {}),
        handle,
        status,
        ...(error ? { error } : {}),
      },
      timestamp: generateTimestamp(),
    }
    try {
      await this.deps.publishEvent(event)
    } catch (err) {
      console.warn('[MediaFetchManager] publish media.download_completed failed:', err)
    }
  }
}
