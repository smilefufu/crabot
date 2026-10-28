// Anonymous program downloads only. No Admin session, updater installer or target code.
import { promises as fs, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { desktopReleaseMetadataNames, DesktopReleaseSelectionSchema, type DesktopReleaseManifest } from 'crabot-client/contracts'
import { createDesktopReleaseVerifier, type DesktopReleaseProof } from './release-signatures.js'

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

async function matchesBytes(file: string, expected: Buffer): Promise<boolean> {
  let handle
  try {
    const before = await fs.lstat(file)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== expected.length) return false
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = await handle.stat()
    if (before.dev !== opened.dev || before.ino !== opened.ino) return false
    const bytes = Buffer.alloc(expected.length + 1); let used = 0
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null)
      if (!bytesRead) break
      used += bytesRead
    }
    return used === expected.length && bytes.subarray(0, used).equals(expected)
  } catch { return false }
  finally { await handle?.close() }
}

export function createDesktopReleaseDownloader(options: {
  pinnedPublicKeys: readonly string[]; platform: DesktopReleaseManifest['platform']; arch: DesktopReleaseManifest['arch']; cacheRoot: string
  fetch: (url: string, init: RequestInit) => Promise<Response>
}) {
  const verifier = createDesktopReleaseVerifier(options.pinnedPublicKeys), names = desktopReleaseMetadataNames(options.platform, options.arch)
  if (!path.isAbsolute(options.cacheRoot)) fail('METADATA')
  function jobFiles(proof: DesktopReleaseProof) { return [names.manifest, names.signatures, proof.manifest.artifact.file] }
  async function matchesJob(job: string, proof: DesktopReleaseProof, raw: Buffer, signatures: Buffer) {
    try {
      management.requirePrivateDataRoot(job)
      const actual = (await fs.readdir(job)).sort(), expected = jobFiles(proof).sort()
      return JSON.stringify(actual) === JSON.stringify(expected)
        && await matchesBytes(path.join(job, names.manifest), raw) && await matchesBytes(path.join(job, names.signatures), signatures)
    } catch { return false }
  }
  function result(job: string, proof: DesktopReleaseProof, manifestBytes: Buffer, signatureBytes: Buffer) {
    const artifact = path.join(job, proof.manifest.artifact.file)
    const raw = Buffer.from(manifestBytes), signatures = Buffer.from(signatureBytes)
    return Object.freeze({ manifest: proof.manifest, manifestBytes: Buffer.from(raw), signatureBytes: Buffer.from(signatures), artifact,
      async discard() {
        // Optional program-cache cleanup. Never recurse into unknown contents,
        // and never let cache deletion authorize or undo an installation.
        if (!await matchesJob(job, proof, raw, signatures)) return
        try {
          await verifier.verifyArtifact(artifact, proof)
          for (const name of jobFiles(proof)) await fs.unlink(path.join(job, name))
          await fs.rmdir(job)
        } catch { /* Preserve changed/in-use entries and any newly added files. */ }
      } })
  }
  async function cached(proof: DesktopReleaseProof, raw: Buffer, signatures: Buffer, signal: AbortSignal) {
    const exists = await fs.lstat(options.cacheRoot).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    if (!exists) return null
    const cache = management.requirePrivateDataRoot(options.cacheRoot)
    for (const entry of await fs.readdir(cache, { withFileTypes: true })) {
      signal.throwIfAborted()
      if (!entry.isDirectory() || !/^download-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(entry.name)) continue
      const job = path.join(cache, entry.name)
      if (!await matchesJob(job, proof, raw, signatures)) continue
      try {
        await verifier.verifyArtifact(path.join(job, proof.manifest.artifact.file), proof, { signal })
        return result(job, proof, raw, signatures)
      } catch { signal.throwIfAborted() } // Bad cache is retained, never trusted or executed.
    }
    return null
  }
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
        const reused = await cached(proof, manifestBytes, signatureBytes, combined)
        if (reused) { progress(100); return reused }
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
        await fs.writeFile(path.join(job, names.manifest), manifestBytes, { flag: 'wx', mode: 0o600, flush: true })
        await fs.writeFile(path.join(job, names.signatures), signatureBytes, { flag: 'wx', mode: 0o600, flush: true })
        const complete = result(job, proof, manifestBytes, signatureBytes); job = undefined
        return complete
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
