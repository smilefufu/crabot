import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { FetchImageParams, FetchImageResult } from 'crabot-shared'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const FORMATS = [
  { mime: 'image/png', ext: '.png', matches: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { mime: 'image/jpeg', ext: '.jpg', matches: (b: Buffer) => b[0] === 255 && b[1] === 216 && b[2] === 255 },
  { mime: 'image/gif', ext: '.gif', matches: (b: Buffer) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString()) },
  { mime: 'image/webp', ext: '.webp', matches: (b: Buffer) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
]
type ImageFile = { file_path: string; mime_type: string; size: number }

/** 单次查询最新质量；只有被明确选中的版本才下载，不发会话级完成事件。 */
export class WechatImageFetcher {
  private readonly cached = new Map<string, ImageFile>()
  private readonly downloads = new Map<string, Promise<ImageFile>>()

  constructor(private readonly deps: {
    dataDir: string
    getMessage: (id: string) => Promise<Record<string, unknown> | null>
    getTalker: (sessionId: string) => string | undefined
  }) {}

  async fetch(params: FetchImageParams): Promise<FetchImageResult> {
    try {
      if (params.quality !== 'hd' && params.quality !== 'thumbnail') throw new Error('图片质量参数无效')
      const talker = this.deps.getTalker(params.session_id)
      if (!talker) throw new Error('会话不存在')
      const message = await this.deps.getMessage(params.platform_message_id)
      if (!message) throw new Error('无法查询图片消息：消息不存在或渠道暂不可用')
      if (message.fieldTalker !== talker) throw new Error('图片不属于指定会话')
      const content = message.content as Record<string, unknown> | undefined
      if (!content || (message.fieldType ?? content.type) !== 1) throw new Error('该消息不是图片')
      const image_quality = content.image_origin === 1 ? 'hd' : content.image_origin === 0 ? 'thumbnail' : 'unknown'
      if (params.quality === 'hd' && image_quality !== 'hd') return { status: 'not_ready', image_quality }
      const url = content.resource_url
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('图片版本没有可用下载地址')
      const file = await this.download(url, image_quality)
      return { status: 'ready', image_quality, ...file }
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async download(url: string, quality: string): Promise<ImageFile> {
    const key = `${quality}:${url}`
    const pending = this.downloads.get(key)
    if (pending) return pending
    const work = this.downloadOrReuse(url, key)
    this.downloads.set(key, work)
    try { return await work } finally { this.downloads.delete(key) }
  }

  private async downloadOrReuse(url: string, key: string): Promise<ImageFile> {
    const cached = this.cached.get(key)
    if (cached && await fs.stat(cached.file_path).then(s => s.isFile() && s.size === cached.size, () => false)) return cached
    this.cached.delete(key)
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    if (!response.ok || !response.body) throw new Error(`图片下载失败：HTTP ${response.status}`)
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    try {
      if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('图片超过 20MB 上限')
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_IMAGE_BYTES) throw new Error('图片超过 20MB 上限')
        chunks.push(Buffer.from(value))
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    const buffer = Buffer.concat(chunks)
    const format = FORMATS.find(format => format.matches(buffer))
    if (!format) throw new Error('图片格式不支持或下载内容不是图片')
    const dir = path.join(this.deps.dataDir, 'media')
    await fs.mkdir(dir, { recursive: true })
    const file_path = path.join(dir, `image-${createHash('sha256').update(key).digest('hex')}${format.ext}`)
    const temporary = `${file_path}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, buffer)
      await fs.rename(temporary, file_path)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    const result = { file_path, mime_type: format.mime, size }
    this.cached.set(key, result)
    return result
  }
}
