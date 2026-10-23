// Current trusted GUI orchestration. These capabilities never stop/select Core.
import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import path from 'node:path'
import type { DesktopReleaseManifest } from 'crabot-client/contracts'
import { createDesktopReleaseVerifier, type DesktopReleaseProof } from './release-signatures.js'

const management = createRequire(import.meta.url)('./bootstrap/scripts/lib/desktop-management.cjs')
type Context = Parameters<ReturnType<typeof createDesktopReleaseVerifier>['verifyMetadata']>[2]
type VerifiedPayload = { record: { selection: DesktopReleaseManifest['selection'] } }
type StagedRelease = { readonly manifest: Readonly<DesktopReleaseManifest> }
function fail(kind: 'INTEGRITY' | 'SIGNATURE'): never {
  throw Object.assign(new Error('桌面发行校验未通过，原版本与数据已保留。'), { code: 'CRABOT_DESKTOP_RELEASE_' + kind })
}
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError') }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function extract(python: string, helper: string, artifact: string, payload: string, proof: DesktopReleaseProof, signal?: AbortSignal) {
  cancelled(signal)
  await new Promise<void>((resolve, reject) => {
    // No shell/PATH lookup or inherited Agent/Admin environment. The fixed
    // helper has no children; killing this owned Python cannot kill user work.
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []))
    const child = spawn(python, ['-I', '-B', helper, artifact, payload, String(proof.manifest.artifact.size), proof.manifest.artifact.sha256],
      { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = ''
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-256) })
    let force: NodeJS.Timeout | undefined, stopping = false
    const stop = () => { stopping = true; child.kill(); force ??= setTimeout(() => child.kill('SIGKILL'), 2000) }
    const timer = setTimeout(stop, 20 * 60_000)
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    let failed = false
    child.on('error', () => { failed = true })
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort', stop)
      if (signal?.aborted) reject(new DOMException('Cancelled', 'AbortError'))
      else if (failed || stopping || code !== 0) reject(Object.assign(new Error('完整包解包未完成，原版本与数据已保留。'),
        { code: diagnostic === 'CRABOT_UPDATE_SPACE\n' ? 'CRABOT_UPDATE_SPACE' : 'CRABOT_DESKTOP_RELEASE_INTEGRITY' }))
      else resolve()
    })
  })
}

// The caller supplies only already trusted current-runtime capabilities. The
// returned private stage token cannot be restored from JSON or another factory.
export function createDesktopReleaseIntake<T>(options: {
  pinnedPublicKeys: readonly string[]; python: string; cacheRoot: string
  verifyPayload: (directory: string, options: { signal?: AbortSignal }) => Promise<VerifiedPayload>
  preparePair: (options: { payload: string; installRoot: string; signal?: AbortSignal }) => Promise<T>
}) {
  if (!path.isAbsolute(options.python) || !path.isAbsolute(options.cacheRoot)) fail('INTEGRITY')
  const verifier = createDesktopReleaseVerifier(options.pinnedPublicKeys)
  const stages = new WeakMap<StagedRelease, { proof: DesktopReleaseProof; artifact: string; job: string; payload: string; inventory: string }>()
  async function inventory(payload: string): Promise<string> {
    const file = path.join(payload, 'desktop-payload.json'), stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) fail('INTEGRITY')
    return hash(await fs.readFile(file))
  }
  async function verifyPayload(payload: string, proof: DesktopReleaseProof, signal?: AbortSignal) {
    cancelled(signal)
    const verified = await options.verifyPayload(payload, { signal })
    if (JSON.stringify(verified.record.selection) !== JSON.stringify(proof.manifest.selection)) fail('INTEGRITY')
    cancelled(signal)
  }
  return {
    async stage(request: { manifestBytes: Uint8Array; signatureBytes: Uint8Array; artifact: string; context: Context; signal?: AbortSignal }): Promise<StagedRelease> {
      cancelled(request.signal)
      const proof = verifier.verifyMetadata(request.manifestBytes, request.signatureBytes, request.context)
      await verifier.verifyArtifact(request.artifact, proof, { signal: request.signal })
      // Bad source/bytes never create a directory or launch even the trusted helper.
      const cache = management.ensurePrivateDataRoot(options.cacheRoot), job = path.join(cache, 'release-' + randomUUID())
      management.ensurePrivateDataRoot(job)
      try {
        const payload = management.ensurePrivateDataRoot(path.join(job, 'payload'))
        const helper = path.join(job, 'extract.py')
        await fs.copyFile(new URL('./bootstrap/scripts/desktop/extract-paired-release.py', import.meta.url), helper)
        await extract(options.python, helper, path.resolve(request.artifact), payload, proof, request.signal)
        const checksum = await inventory(payload)
        await verifyPayload(payload, proof, request.signal)
        const stage = Object.freeze({ manifest: proof.manifest })
        stages.set(stage, { proof, artifact: path.resolve(request.artifact), job, payload, inventory: checksum })
        return stage
      } catch (error) {
        await fs.rm(job, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        throw error
      }
    },
    async prepare(stage: StagedRelease, request: { installRoot: string; signal?: AbortSignal }): Promise<T> {
      const stored = stages.get(stage)
      if (!stored) fail('SIGNATURE')
      cancelled(request.signal)
      await verifier.verifyArtifact(stored.artifact, stored.proof, { signal: request.signal })
      if (await inventory(stored.payload) !== stored.inventory) fail('INTEGRITY')
      await verifyPayload(stored.payload, stored.proof, request.signal)
      // Online preparation still owns its existing lock, byte verification and
      // final-path preview; the intake grants no stop/migration/commit authority.
      return options.preparePair({ payload: stored.payload, installRoot: request.installRoot, signal: request.signal })
    },
    async discard(stage: StagedRelease): Promise<void> {
      const stored = stages.get(stage)
      if (!stored) fail('SIGNATURE')
      stages.delete(stage)
      await fs.rm(stored.job, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
}
