// Anonymous program downloads only. No Admin session, updater installer or target code.
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { desktopReleaseMetadataNames, DesktopReleaseSelectionSchema, type DesktopReleaseManifest } from 'crabot-client/contracts'
import { createDesktopReleaseVerifier } from './release-signatures.js'

const management = createRequire(import.meta.url)('./bootstrap/scripts/lib/desktop-management.cjs')
const channel = 'https://github.com/smilefufu/crabot/releases/latest/download/'
const reserve = 512n * 1024n * 1024n
function fail(kind: 'METADATA' | 'INTEGRITY' | 'DOWNLOAD'): never {
  throw Object.assign(new Error('更新下载未完成，当前版本与数据已保留。'), { code: 'CRABOT_DESKTOP_RELEASE_' + kind })
}
function allowedRedirect(value: URL, name: string): boolean {
  if (value.protocol !== 'https:' || value.username || value.password || value.port || value.hash) return false
  if (value.hostname === 'github.com') return !value.search && value.pathname.startsWith('/smilefufu/crabot/releases/download/')
    && value.pathname.split('/').length === 7 && value.pathname.endsWith('/' + name)
  return value.hostname === 'release-assets.githubusercontent.com' && /^\/github-production-release-asset\/\d+\/[^/]+$/.test(value.pathname)
}
function checkLength(response: Response, maximum: number, exact: boolean) {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(maximum) || exact && BigInt(length) !== BigInt(maximum))) fail(exact ? 'INTEGRITY' : 'METADATA')
}

async function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('Cancelled', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([promise, aborted]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

export function createDesktopReleaseDownloader(options: {
  pinnedPublicKeys: readonly string[]; platform: DesktopReleaseManifest['platform']; arch: DesktopReleaseManifest['arch']; cacheRoot: string
  fetch: (url: string, init: RequestInit) => Promise<Response>
}) {
  const verifier = createDesktopReleaseVerifier(options.pinnedPublicKeys), names = desktopReleaseMetadataNames(options.platform, options.arch)
  if (!path.isAbsolute(options.cacheRoot)) fail('METADATA')
  return {
    async check(current: DesktopReleaseManifest['selection'], { signal, progress = () => {} }: { signal?: AbortSignal; progress?: (percent: number) => void } = {}) {
      const cancelled = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError') }
      cancelled(); current = DesktopReleaseSelectionSchema.parse(current)
      const abort = new AbortController(), combined = AbortSignal.any([abort.signal, AbortSignal.timeout(30 * 60_000), ...(signal ? [signal] : [])])
      let job: string | undefined
      async function response(name: string) {
        let url = new URL(name, channel)
        const visited = new Set<string>()
        for (let i = 0; i < 6; i++) {
          if (visited.has(url.href)) fail('METADATA')
          visited.add(url.href)
          const result = await waitFor(options.fetch(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
            referrerPolicy: 'no-referrer', headers: { Accept: 'application/octet-stream' }, signal: combined }), AbortSignal.any([combined, AbortSignal.timeout(60000)]))
          if ([301, 302, 303, 307, 308].includes(result.status)) {
            const location = result.headers.get('location')
            await result.body?.cancel()
            if (!location) fail('METADATA')
            const next = new URL(location, url)
            if (!allowedRedirect(next, name)) fail('METADATA')
            url = next; continue
          }
          if (result.status !== 200 || !result.body) { await result.body?.cancel(); fail('DOWNLOAD') }
          return result
        }
        fail('METADATA')
      }
      async function consume(result: Response, maximum: number, accept: (bytes: Uint8Array) => Promise<void>, exact: boolean) {
        const reader = result.body!.getReader()
        let used = 0
        try {
          checkLength(result, maximum, exact)
          for (;;) {
            cancelled(); combined.throwIfAborted()
            const next = await waitFor(reader.read(), AbortSignal.any([combined, AbortSignal.timeout(60000)]))
            if (next.done) break
            used += next.value.byteLength
            if (used > maximum) fail(exact ? 'INTEGRITY' : 'METADATA')
            await accept(next.value)
          }
          if (exact && used !== maximum) fail('INTEGRITY')
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      }
      async function metadata(name: string, limit: number) {
        const chunks: Buffer[] = []
        await consume(await response(name), limit, async bytes => { chunks.push(Buffer.from(bytes)) }, false)
        return Buffer.concat(chunks)
      }
      try {
        // Independent bounded metadata reads; one failed request aborts its sibling.
        let metadataError: unknown
        const results = await Promise.allSettled([metadata(names.manifest, 65536), metadata(names.signatures, 4096)]
          .map(promise => promise.catch(error => { metadataError ??= error; abort.abort(); throw error })))
        const [manifest, signatures] = results
        if (manifest.status !== 'fulfilled' || signatures.status !== 'fulfilled') throw metadataError
        const manifestBytes = manifest.value, signatureBytes = signatures.value
        const context = { platform: options.platform, arch: options.arch, purpose: 'install' as const }
        const authenticated = verifier.verifyMetadata(manifestBytes, signatureBytes, context)
        if (JSON.stringify(authenticated.manifest.selection) === JSON.stringify(current)) return null
        const proof = verifier.verifyMetadata(manifestBytes, signatureBytes, { ...context, purpose: 'update', currentVersion: current.version })
        const cache = management.ensurePrivateDataRoot(options.cacheRoot)
        job = path.join(cache, 'download-' + randomUUID()); management.ensurePrivateDataRoot(job)
        const space = await fs.statfs(job, { bigint: true }), artifactSize = proof.manifest.artifact.size
        if (space.bavail * space.bsize < BigInt(artifactSize) + reserve) throw Object.assign(new Error('更新空间不足，当前版本保留。'), { code: 'CRABOT_UPDATE_SPACE' })
        const temporary = path.join(job, 'archive.partial'), artifact = path.join(job, proof.manifest.artifact.file)
        const handle = await fs.open(temporary, 'wx', 0o600), digest = createHash('sha256')
        let received = 0, sinceSpaceCheck = 16 * 1024 * 1024
        try {
          await consume(await response(proof.manifest.artifact.file), artifactSize, async bytes => {
            if (sinceSpaceCheck >= 16 * 1024 * 1024) {
              const available = await fs.statfs(job!, { bigint: true })
              if (available.bavail * available.bsize < reserve + BigInt(bytes.byteLength)) throw Object.assign(new Error('更新空间不足，当前版本保留。'), { code: 'CRABOT_UPDATE_SPACE' })
              sinceSpaceCheck = 0
            }
            digest.update(bytes)
            let offset = 0
            while (offset < bytes.byteLength) { const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset); if (!bytesWritten) fail('INTEGRITY'); offset += bytesWritten }
            received += bytes.byteLength; sinceSpaceCheck += bytes.byteLength; progress(received / artifactSize * 100)
          }, true)
          if (digest.digest('hex') !== proof.manifest.artifact.sha256) fail('INTEGRITY')
          await handle.sync()
        } finally { await handle.close() }
        await fs.rename(temporary, artifact)
        await verifier.verifyArtifact(artifact, proof, { signal: combined })
        const owned = job; job = undefined
        return Object.freeze({ manifest: proof.manifest, manifestBytes, signatureBytes, artifact,
          discard: () => fs.rm(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
      } catch (error) {
        cancelled()
        const code = (error as { code?: unknown })?.code
        if (typeof code === 'string' && ['CRABOT_DESKTOP_RELEASE_SIGNATURE', 'CRABOT_DESKTOP_RELEASE_METADATA',
          'CRABOT_DESKTOP_RELEASE_INTEGRITY', 'CRABOT_DESKTOP_RELEASE_VERSION', 'CRABOT_DESKTOP_RELEASE_DOWNLOAD', 'CRABOT_UPDATE_SPACE', 'ENOSPC'].includes(code)) {
          throw Object.assign(new Error('更新下载未完成，当前版本与数据已保留。'), { code })
        }
        fail('DOWNLOAD')
      } finally {
        abort.abort()
        if (job) await fs.rm(job, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
  }
}
