import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { proxyManager, RpcError } from 'crabot-shared'

export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export interface Downloaded { filePath: string; mimeType?: string; size: number }

export function slackFileUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.username || url.password) throw new RpcError('PERMISSION_DENIED', 'Slack 文件地址不受信任')
  return url
}
function publicUrl(value: string): URL {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new RpcError('INVALID_ARGUMENT', '媒体地址必须为 HTTP(S) 文件地址')
  return url
}
function checkResponse(response: Response) {
  if (response.ok) return
  if (response.status === 429) throw new RpcError('RATE_LIMITED', 'Slack 文件传输限流', { retry_after: Number(response.headers.get('retry-after')) || 1 })
  if ([401, 403].includes(response.status)) throw new RpcError('PERMISSION_DENIED', 'Slack 文件权限不足，请核对 files:read/files:write 并重新授权原 App')
  if (response.status === 404) throw new RpcError('NOT_FOUND', 'Slack 文件不存在或已不可访问')
  throw new RpcError('SERVICE_UNAVAILABLE', 'Slack 文件传输失败')
}

export class MediaTransport {
  private readonly shutdown = new AbortController()
  private readonly deadline = new AsyncLocalStorage<number>()
  constructor(private readonly token: string, private readonly dir: string) {}
  stop() { this.shutdown.abort() }
  async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = this.deadline.getStore() ?? Date.now() + 120_000
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), Math.max(0, deadline - Date.now()))
    const signal = AbortSignal.any([timeout.signal, this.shutdown.signal])
    let aborted: (() => void) | undefined
    try {
      signal.throwIfAborted()
      const stopped = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new Error('media operation stopped'))
        signal.addEventListener('abort', aborted, { once: true })
      })
      const result = await Promise.race([this.deadline.run(deadline, () => work(signal)), stopped])
      signal.throwIfAborted(); return result
    }
    catch (error) {
      if (error instanceof RpcError) throw error
      throw new RpcError('SERVICE_UNAVAILABLE', signal.aborted ? 'Slack 媒体传输已停止或超时' : 'Slack 媒体传输失败，请检查网络与权限')
    } finally { clearTimeout(timer); if (aborted) signal.removeEventListener('abort', aborted) }
  }
  private request(url: URL, init: RequestInit) {
    return fetch(url, { ...init, dispatcher: proxyManager.getDispatcher() } as RequestInit)
  }
  async download(value: string, filename: string, privateFile: boolean, limit: number, signal: AbortSignal): Promise<Downloaded> {
    let url = privateFile ? slackFileUrl(value) : publicUrl(value)
    let response: Response | undefined
    for (let hop = 0; hop <= 5; hop++) {
      signal.throwIfAborted()
      response = await this.request(url, { signal, redirect: 'manual', headers: privateFile ? { Authorization: `Bearer ${this.token}` } : {} })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location || hop === 5) throw new RpcError('SERVICE_UNAVAILABLE', 'Slack 文件重定向无效或过多')
      const target = new URL(location, url).href
      url = privateFile ? slackFileUrl(target) : publicUrl(target)
    }
    try { checkResponse(response!) } catch (error) { await response?.body?.cancel(); throw error }
    if (!response?.body) throw new RpcError('SERVICE_UNAVAILABLE', 'Slack 文件没有可读取内容')
    if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new RpcError('CHANNEL_FILE_TOO_LARGE', '媒体文件超过大小上限') }
    const ext = path.extname(filename), name = randomUUID()
    const target = path.join(this.dir, name + (/^\.[a-zA-Z0-9]{1,12}$/.test(ext) ? ext : '.bin')), temporary = path.join(this.dir, name + '.part')
    const reader = response.body.getReader()
    let file: Awaited<ReturnType<typeof fsp.open>> | undefined
    let size = 0
    try {
      await fsp.mkdir(this.dir, { recursive: true })
      file = await fsp.open(temporary, 'wx', 0o600)
      while (true) {
        signal.throwIfAborted()
        const { done, value: chunk } = await reader.read()
        if (done) break
        size += chunk.length
        if (size > limit) throw new RpcError('CHANNEL_FILE_TOO_LARGE', '媒体文件超过大小上限')
        await file.writeFile(chunk)
      }
      await file.close(); signal.throwIfAborted(); await fsp.rename(temporary, target)
      return { filePath: target, mimeType: response.headers.get('content-type')?.split(';')[0], size }
    } finally {
      await reader.cancel().catch(() => {}); await file?.close().catch(() => {}); await fsp.rm(temporary, { force: true })
    }
  }
  async upload(value: string, file: string, signal: AbortSignal): Promise<void> {
    const url = slackFileUrl(value), size = (await fsp.stat(file)).size
    if (size > MAX_FILE_BYTES) throw new RpcError('CHANNEL_FILE_TOO_LARGE', '附件超过 100 MiB 上限')
    const stream = fs.createReadStream(file, { end: MAX_FILE_BYTES })
    try {
      signal.throwIfAborted()
      const response = await this.request(url, { method: 'POST', body: stream as unknown as BodyInit, duplex: 'half', signal, redirect: 'manual', headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) } } as RequestInit)
      try { checkResponse(response) } finally { await response.body?.cancel() }
    } finally { stream.destroy() }
  }
}
