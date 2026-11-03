import { promises as fs } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { MediaHandleStore, MediaFetchManager, MediaCleaner, RpcError, type FetchImageParams, type FetchImageResult, type MediaHandleRecord, type MessageContent, type Event } from 'crabot-shared'
import type { SlackApi, SlackFile, SlackHistoryMessage } from './types.js'
import { platformError } from './slack-client.js'
import { MediaTransport, MAX_FILE_BYTES, MAX_IMAGE_BYTES, type Downloaded } from './media-transport.js'

interface Reference { sessionId: string; conversationId: string; ts: string; files: SlackFile[] }
export interface UploadSource { filePath: string; filename: string; size: number }
const image = (file: SlackFile) => file.mimetype?.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|tiff?|svg)$/i.test(file.name || file.title || '')
const label = (file: SlackFile) => file.name || file.title || file.id || '未命名文件'
const message = (error: unknown) => error instanceof RpcError ? error.message : '媒体操作失败，请检查权限与网络'
function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
}

export class SlackMedia {
  private readonly handles: MediaHandleStore
  private readonly fetcher: MediaFetchManager
  private readonly cleaner: MediaCleaner
  readonly transport: MediaTransport
  private readonly references = new Map<string, Reference>()
  private readonly cached = new Map<string, Downloaded>()
  private readonly downloading = new Map<string, Promise<Downloaded>>()
  private initialized?: Promise<void>
  private changes: Promise<unknown> = Promise.resolve()
  private stopped = false
  constructor(private readonly options: {
    dir: string; token: string; api: SlackApi; channelId: string
    session: (id: string) => { platform_session_id: string }
    publish: (event: Event) => Promise<void>
  }) {
    this.handles = new MediaHandleStore(options.dir)
    this.transport = new MediaTransport(options.token, path.join(options.dir, 'media'))
    this.cleaner = new MediaCleaner(options.dir)
    this.fetcher = new MediaFetchManager({ store: this.handles, channelId: options.channelId,
      download: rec => this.downloadRecord(rec),
      publishEvent: event => this.stopped ? Promise.resolve() : options.publish(event),
    })
  }
  private init() {
    return this.initialized ??= (async () => {
      await fs.mkdir(this.options.dir, { recursive: true })
      await this.handles.init()
      try {
        const values = JSON.parse(await fs.readFile(path.join(this.options.dir, 'media-references.json'), 'utf8')) as Reference[]
        if (!Array.isArray(values)) throw new Error('invalid references')
        for (const ref of values) {
          if (typeof ref.sessionId !== 'string' || typeof ref.conversationId !== 'string' || typeof ref.ts !== 'string' || !Array.isArray(ref.files)) throw new Error('invalid reference')
          this.references.set(this.key(ref.sessionId, ref.ts), ref)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new RpcError('SERVICE_UNAVAILABLE', 'Slack 媒体引用索引无法读取')
      }
    })()
  }
  async start() {
    await this.init()
    this.cleaner.startCleanup()
  }
  stop() { this.stopped = true; this.transport.stop(); this.cleaner.stopCleanup() }
  private key(sessionId: string, ts: string) { return `${sessionId}\0${ts}` }
  private async save() {
    const target = path.join(this.options.dir, 'media-references.json'), temporary = target + '.tmp'
    try {
      await fs.writeFile(temporary, JSON.stringify([...this.references.values()]), { mode: 0o600 })
      await fs.rename(temporary, target)
    } finally { await fs.rm(temporary, { force: true }) }
  }
  project(sessionId: string, conversationId: string, ts: string, raw: Pick<SlackHistoryMessage, 'text' | 'files'>): Promise<MessageContent> {
    const work = this.changes.then(() => this.projectMessage(sessionId, conversationId, ts, raw))
    this.changes = work.catch(() => {})
    return work
  }
  private async projectMessage(sessionId: string, conversationId: string, ts: string, raw: Pick<SlackHistoryMessage, 'text' | 'files'>): Promise<MessageContent> {
    await this.init()
    if (!raw.files?.length) return { type: 'text', text: raw.text || '' }
    const files: SlackFile[] = [], descriptions: string[] = []
    let firstHandle: string | undefined
    for (const original of raw.files) {
      let file = original, problem = ''
      if (file.id && (!file.mimetype || !file.name && !file.title || file.file_access === 'check_file_info')) {
        try { file = { ...file, ...await this.info(file.id) } } catch (error) { problem = message(error) }
      }
      files.push(file)
      const prefix = `${label(file)}；attachment_id=${file.id || 'unknown'}；MIME=${file.mimetype || 'unknown'}；size=${file.size ?? 'unknown'}`
      if (!file.id) { descriptions.push(`[附件不可用: ${prefix}；平台未提供文件 ID]`); continue }
      const credential = { session_id: sessionId, conversation_id: conversationId, platform_message_id: ts, file_id: file.id }
      const handle = this.handles.findByCredential(credential) ?? await this.handles.put({ kind: 'file', session_id: sessionId, filename: label(file), mime_type: file.mimetype, size: file.size, credential })
      if (files.length === 1) firstHandle = handle
      descriptions.push(`[${image(file) ? '图片' : '文件'}: ${prefix}；handle=${handle}${image(file) ? '；内容未附带，使用 fetch_image 按需读取' : '；未下载，使用 fetch_media'}${problem ? `；${problem}` : ''}]`)
    }
    this.references.set(this.key(sessionId, ts), { sessionId, conversationId, ts, files })
    await this.save()
    const hasImage = files.some(image), first = files[0]
    return { type: hasImage ? 'image' : 'file', text: [raw.text, ...descriptions].filter(Boolean).join('\n'),
      ...(hasImage ? { image_quality: 'unknown' as const } : { handle: firstHandle, status: 'not_fetched' as const, filename: label(first), mime_type: first.mimetype, size: first.size }) }
  }
  private async info(id: string): Promise<SlackFile> {
    const result = await this.options.api.call('files.info', { file: id })
    if (!result.file || result.file.id !== id) throw new RpcError('NOT_FOUND', 'Slack 文件不存在或当前 Bot 无权读取')
    return result.file
  }
  private async resolve(ref: Reference, id: string) {
    if (this.options.session(ref.sessionId).platform_session_id !== ref.conversationId || !ref.files.some(f => f.id === id)) throw new RpcError('PERMISSION_DENIED', '附件不属于指定消息或会话')
    const conversation = (await this.options.api.call('conversations.info', { channel: ref.conversationId })).channel
    if (conversation?.id !== ref.conversationId || conversation.is_archived || !conversation.is_im && !conversation.is_member) throw new RpcError('PERMISSION_DENIED', '当前 Bot 无权访问该文件会话')
    return this.info(id)
  }
  async fetchImage(params: FetchImageParams): Promise<FetchImageResult> {
    try {
      await this.init()
      if (!['hd', 'thumbnail'].includes(params.quality)) throw new RpcError('INVALID_ARGUMENT', '图片质量参数无效')
      const ref = this.references.get(this.key(params.session_id, params.platform_message_id))
      if (!ref) throw new RpcError('NOT_FOUND', '图片消息未登记媒体引用；旧群消息请先查询远端历史')
      const candidates = params.attachment_id ? ref.files.filter(f => f.id === params.attachment_id) : ref.files
      if (!candidates.length) throw new RpcError('NOT_FOUND', '附件不属于该消息')
      return await this.transport.run(async signal => {
        let file: SlackFile | undefined
        for (const candidate of candidates) {
          signal.throwIfAborted()
          if (!candidate.id) continue
          const current = await this.resolve(ref, candidate.id)
          if (image(current)) { file = current; break }
        }
        if (!file) throw new RpcError('NOT_FOUND', '附件不是该消息中的图片')
        const preview = params.quality === 'thumbnail' ? file.thumb_1024 || file.thumb_720 || file.thumb_360 : undefined
        const url = preview || file.url_private_download || file.url_private
        if (!url) return { status: 'not_ready', image_quality: 'unknown' }
        if (file.mode === 'external' || file.is_external || file.filetype === 'remote') throw new RpcError('SERVICE_UNAVAILABLE', '外部文件请使用原文件下载引用；Slack 未托管该图片实体')
        const result = await this.download(ref, file, url, preview ? 'thumbnail' : 'hd', MAX_IMAGE_BYTES, signal)
        const mime = imageMime(await fs.readFile(result.filePath))
        if (!mime) throw new RpcError('CHANNEL_UNSUPPORTED_MESSAGE_TYPE', '该图片格式不支持视觉读取，请用 fetch_media 下载原文件')
        return { status: 'ready', image_quality: preview ? 'thumbnail' : 'hd', file_path: result.filePath, mime_type: mime, size: result.size }
      })
    } catch (error) { return { status: 'failed', error: message(error) } }
  }
  async fetchMedia(handle: string) {
    try {
      return await this.transport.run(async signal => {
        await this.init()
        const rec = this.handles.get(handle)
        if (!rec) throw new RpcError('NOT_FOUND', '媒体引用不存在或不属于该渠道')
        const { file } = await this.resolveRecord(rec)
        if (file.size !== undefined && file.size > MAX_FILE_BYTES) throw new RpcError('CHANNEL_FILE_TOO_LARGE', '附件超过 100 MiB 上限')
        signal.throwIfAborted()
        return this.fetcher.fetch(handle)
      })
    } catch (error) { return { status: 'failed' as const, error: message(error) } }
  }
  private async resolveRecord(rec: MediaHandleRecord) {
    const ts = rec.credential.platform_message_id, id = rec.credential.file_id
    const ref = rec.session_id && this.references.get(this.key(rec.session_id, String(ts)))
    if (!ref || typeof id !== 'string' || ref.conversationId !== rec.credential.conversation_id) throw new RpcError('PERMISSION_DENIED', '附件引用不属于该会话')
    return { ref, file: await this.resolve(ref, id) }
  }
  private downloadRecord(rec: MediaHandleRecord) {
    return this.transport.run(async signal => {
      const { ref, file } = await this.resolveRecord(rec)
      const url = file.url_private_download || file.url_private
      if (!url) throw new RpcError('SERVICE_UNAVAILABLE', '文件还没有可读取地址；外部私有云盘请提供原文件')
      return this.download(ref, file, url, 'file', MAX_FILE_BYTES, signal)
    })
  }
  private async download(ref: Reference, file: SlackFile, url: string, quality: string, limit: number, signal: AbortSignal) {
    const key = `${this.key(ref.sessionId, ref.ts)}\0${file.id}\0${quality}\0${url}`
    const cached = this.cached.get(key)
    if (cached && cached.size <= limit && await fs.stat(cached.filePath).then(s => s.isFile() && s.size === cached.size, () => false)) return cached
    const existing = this.downloading.get(key)
    if (existing) return existing
    const privateFile = !(file.mode === 'external' || file.is_external || file.filetype === 'remote')
    const work = this.transport.download(url, label(file), privateFile, limit, signal).then(result => { this.cached.set(key, result); return result })
    this.downloading.set(key, work)
    try { return await work } finally { this.downloading.delete(key) }
  }
  async sources(content: MessageContent): Promise<UploadSource[]> {
    const inputs = content.media?.length ? content.media.map(m => ({ value: m.media_url, filename: m.filename }))
      : [{ value: content.media_url || content.file_path, filename: content.filename }]
    const sources: UploadSource[] = []
    for (const item of inputs) {
      if (!item.value) throw new RpcError('INVALID_ARGUMENT', '媒体消息缺少文件来源')
      let filePath = item.value, filename = item.filename
      if (/^https?:\/\//.test(item.value)) {
        filename ||= path.basename(new URL(item.value).pathname) || 'file'
        filePath = (await this.transport.run(signal => this.transport.download(item.value!, filename!, false, MAX_FILE_BYTES, signal))).filePath
      } else if (!path.isAbsolute(filePath)) throw new RpcError('INVALID_ARGUMENT', '媒体文件必须使用已解析的本地路径或 HTTP(S) URL')
      const stat = await fs.stat(filePath).catch(() => { throw new RpcError('CHANNEL_FILE_NOT_FOUND', '媒体文件不存在') })
      if (!stat.isFile()) throw new RpcError('CHANNEL_FILE_READ_FAILED', '媒体来源不是文件')
      if (stat.size > MAX_FILE_BYTES) throw new RpcError('CHANNEL_FILE_TOO_LARGE', '附件超过 100 MiB 上限')
      const check = await fs.open(filePath, 'r').catch(() => { throw new RpcError('CHANNEL_FILE_READ_FAILED', '媒体文件不可读取') }); await check.close()
      sources.push({ filePath, filename: filename || path.basename(filePath), size: stat.size })
    }
    return sources
  }
  async share(source: UploadSource, conversationId: string) {
    const uploaded: string[] = []
    let unknown = false
    try {
      return await this.transport.run(async signal => {
        const allocation = await this.options.api.call('files.getUploadURLExternal', { filename: source.filename, length: source.size })
        if (!allocation.upload_url || !allocation.file_id) throw new RpcError('CHANNEL_SEND_FAILED', 'Slack 未返回有效上传信息')
        await this.transport.upload(allocation.upload_url, source.filePath, signal)
        uploaded.push(allocation.file_id)
        signal.throwIfAborted(); unknown = true
        let result
        try { result = await this.options.api.call('files.completeUploadExternal', { files: [{ id: allocation.file_id, title: source.filename }], channel_id: conversationId }) }
        catch (error) {
          if (error instanceof RpcError && ['UNAUTHORIZED', 'PERMISSION_DENIED', 'RATE_LIMITED', 'NOT_FOUND'].includes(error.code)) unknown = false
          throw error
        }
        if (result.ok === false) { unknown = false; throw platformError({ data: result }) }
        while (!signal.aborted) {
          const file = await this.info(allocation.file_id)
          const shares = [...file.shares?.public?.[conversationId] || [], ...file.shares?.private?.[conversationId] || []]
          const ts = shares.find(s => typeof s.ts === 'string' && /^\d+\.\d{1,6}$/.test(s.ts))?.ts
          if (ts) { unknown = false; return { ts, file, uploaded } }
          await sleep(2000, undefined, { signal })
        }
        throw new RpcError('CHANNEL_SEND_FAILED', 'Slack 文件分享结果尚未确认，请核查原会话')
      })
    } catch (error) {
      const e = error instanceof RpcError ? error : new RpcError('CHANNEL_SEND_FAILED', 'Slack 文件发送失败，请核查原会话')
      throw new RpcError(e.code, e.message, { ...e.details, uploaded_file_ids: uploaded, delivery_unknown: unknown })
    }
  }
}
