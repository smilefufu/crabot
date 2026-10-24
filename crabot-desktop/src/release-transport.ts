import { net, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { createDesktopReleaseDownloader } from './release-download.js'

type Fetch = Parameters<typeof createDesktopReleaseDownloader>[0]['fetch']
const unavailable = () => Object.assign(new Error('Release transport is unavailable'), { code: 'CRABOT_DESKTOP_RELEASE_DOWNLOAD' })
// No persist: partition: updates never share the authenticated Admin browser.
export function createDesktopReleaseTransport(): { fetch: Fetch; close: () => Promise<void> } {
  const owned = session.fromPartition('crabot-release-' + randomUUID(), { cache: false })
  owned.setPermissionRequestHandler((_contents, _permission, done) => done(false))
  owned.setPermissionCheckHandler(() => false)
  const active = new Set<() => void>()
  let closed = false
  return {
    fetch: (url, options) => new Promise<Response>((resolve, reject) => {
      if (closed) { reject(unavailable()); return }
      if (options.signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return }
      // ClientRequest exposes the redirect before following it. Electron fetch
      // instead rejects manual redirects, so it cannot implement this boundary.
      const request = net.request({ url, session: owned, method: 'GET', credentials: 'omit', redirect: 'manual', cache: 'no-store',
        referrerPolicy: 'no-referrer', headers: { Accept: 'application/octet-stream' }, bypassCustomProtocolHandlers: true })
      const cleanup = () => { active.delete(abort); options.signal?.removeEventListener('abort', abort) }
      const abort = () => { request.abort(); reject(new DOMException('Cancelled', 'AbortError')); cleanup() }
      active.add(abort); options.signal?.addEventListener('abort', abort, { once: true })
      request.on('error', () => { reject(unavailable()); cleanup() })
      request.on('login', (_info, done) => done())
      request.on('redirect', (status, _method, location) => {
        try { resolve(new Response(null, { status, headers: { location } })) }
        catch { reject(unavailable()) }
        finally { cleanup(); request.abort() } // The downloader validates and starts a new anonymous request.
      })
      request.on('response', response => {
        if (!(response instanceof Readable)) { reject(unavailable()); cleanup(); request.abort(); return }
        response.once('close', () => { cleanup(); request.abort() })
        response.on('error', () => {}) // The bounded consumer observes the stream rejection.
        const headers = new Headers()
        for (const name of ['content-length', 'content-encoding']) {
          const value = response.headers[name]
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        try {
          if (response.statusCode !== 200) { resolve(new Response(null, { status: response.statusCode, headers })); request.abort(); return }
          const body = Readable.toWeb(response, { strategy: { highWaterMark: 1024 * 1024, size: chunk => chunk.byteLength } })
          resolve(new Response(body as ReadableStream<Uint8Array>, { status: 200, headers }))
        } catch { reject(unavailable()); cleanup(); request.abort() }
      })
      request.end()
    }),
    async close() {
      closed = true
      for (const abort of active) abort()
      await owned.closeAllConnections()
      await owned.clearStorageData()
    },
  }
}
