// Current trusted code only. No target modules, private keys or business effects.
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { constants, promises as fs, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { DesktopReleaseManifestSchema, DesktopReleaseSelectionSchema, DesktopReleaseSignaturesSchema,
  serializeDesktopReleaseManifest, serializeDesktopReleaseSignatures, type DesktopReleaseManifest } from 'crabot-client/contracts'

type Failure = 'SIGNATURE' | 'METADATA' | 'INTEGRITY' | 'VERSION'
function reject(kind: Failure): never {
  throw Object.assign(new Error('桌面发行校验未通过，原版本与数据已保留。'), { code: 'CRABOT_DESKTOP_RELEASE_' + kind })
}
type ReleaseContext = { platform: DesktopReleaseManifest['platform']; arch: DesktopReleaseManifest['arch'];
  purpose: 'install' | 'update' | 'repair'; currentVersion?: string }
export type DesktopReleaseProof = { readonly manifest: Readonly<DesktopReleaseManifest> }
function copyBytes(value: Uint8Array, limit: number): Buffer {
  if (!(value instanceof Uint8Array) || !value.byteLength || value.byteLength > limit) reject('METADATA')
  return Buffer.from(value)
}
function decode(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}
function compareVersions(left: string, right: string): number {
  const parts = (value: string): [string, string | undefined] => { const split = value.indexOf('-'); return split < 0 ? [value, undefined] : [value.slice(0, split), value.slice(split + 1)] }
  const [a, ap] = parts(left), [b, bp] = parts(right), av = a.split('.'), bv = b.split('.')
  for (let i = 0; i < 3; i++) { const first = BigInt(av[i]), second = BigInt(bv[i]); if (first !== second) return first > second ? 1 : -1 }
  if (ap === bp) return 0
  if (ap === undefined) return 1
  if (bp === undefined) return -1
  const identifiers = ap.split('.'), other = bp.split('.')
  for (let i = 0; i < Math.max(identifiers.length, other.length); i++) {
    const first = identifiers[i], second = other[i]
    if (first === undefined) return -1
    if (second === undefined) return 1
    if (first === second) continue
    const an = /^\d+$/.test(first), bn = /^\d+$/.test(second)
    if (an && bn) { if (BigInt(first) !== BigInt(second)) return BigInt(first) > BigInt(second) ? 1 : -1 }
    else if (an !== bn) return an ? -1 : 1
    else return first > second ? 1 : -1
  }
  return 0
}
function checkContext(manifest: DesktopReleaseManifest, context: ReleaseContext) {
  if (manifest.platform !== context.platform || manifest.arch !== context.arch) reject('METADATA')
  if (context.purpose === 'install') { if (context.currentVersion !== undefined) reject('VERSION'); return }
  if (!['update', 'repair'].includes(context.purpose) || !DesktopReleaseSelectionSchema.shape.version.safeParse(context.currentVersion).success) reject('VERSION')
  const comparison = compareVersions(manifest.selection.version, context.currentVersion!)
  if (comparison < 0 || comparison === 0 && (context.purpose !== 'repair' || manifest.selection.version !== context.currentVersion)) reject('VERSION')
}
function sameFile(left: BigIntStats, right: BigIntStats) {
  return (['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const).every(name => left[name] === right[name])
}

export function createDesktopReleaseVerifier(pinnedPublicKeys: readonly string[]) {
  const keys = new Map<string, KeyObject>()
  try {
    if (!Array.isArray(pinnedPublicKeys) || !pinnedPublicKeys.length || pinnedPublicKeys.length > 4) reject('SIGNATURE')
    for (const pem of pinnedPublicKeys) {
      if (typeof pem !== 'string' || pem.length > 4096 || !pem.startsWith('-----BEGIN PUBLIC KEY-----\n')) reject('SIGNATURE')
      const key = createPublicKey(pem)
      if (key.asymmetricKeyType !== 'ed25519' || key.export({ type: 'spki', format: 'pem' }).toString() !== pem) reject('SIGNATURE')
      const id = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
      if (keys.has(id)) reject('SIGNATURE')
      keys.set(id, key)
    }
  } catch { reject('SIGNATURE') }
  const proofs = new WeakMap<DesktopReleaseProof, { raw: Buffer; signatures: Buffer; context: ReleaseContext }>()
  function readMetadata(raw: Buffer, signatures: Buffer, context: ReleaseContext): DesktopReleaseManifest {
    let envelope
    try {
      envelope = DesktopReleaseSignaturesSchema.parse(decode(signatures))
      if (!Buffer.from(serializeDesktopReleaseSignatures(envelope)).equals(signatures)) reject('METADATA')
    } catch { reject('METADATA') }
    // Authenticate the original bounded bytes before interpreting any manifest JSON.
    try {
      if (!envelope.signatures.some(item => { const key = keys.get(item.key_id); return !!key && verify(null, raw, key, Buffer.from(item.signature, 'base64url')) })) reject('SIGNATURE')
    } catch { reject('SIGNATURE') }
    let manifest: DesktopReleaseManifest
    try {
      manifest = DesktopReleaseManifestSchema.parse(decode(raw))
      if (!Buffer.from(serializeDesktopReleaseManifest(manifest)).equals(raw)) reject('METADATA')
    } catch { reject('METADATA') }
    checkContext(manifest, context)
    Object.freeze(manifest.selection); Object.freeze(manifest.artifact)
    return Object.freeze(manifest)
  }
  return {
    verifyMetadata(manifestBytes: Uint8Array, signatureBytes: Uint8Array, context: ReleaseContext): DesktopReleaseProof {
      const raw = copyBytes(manifestBytes, 65536), signatures = copyBytes(signatureBytes, 4096), expected = { ...context }
      const proof = Object.freeze({ manifest: readMetadata(raw, signatures, expected) })
      proofs.set(proof, { raw, signatures, context: expected })
      return proof
    },
    async verifyArtifact(file: string, proof: DesktopReleaseProof, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
      const stored = proofs.get(proof)
      if (!stored) reject('SIGNATURE')
      const manifest = readMetadata(stored.raw, stored.signatures, stored.context)
      let handle
      try {
        signal?.throwIfAborted()
        if (path.basename(file) !== manifest.artifact.file) reject('INTEGRITY')
        const before = await fs.lstat(file, { bigint: true })
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(manifest.artifact.size)) reject('INTEGRITY')
        handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        if (!sameFile(before, await handle.stat({ bigint: true }))) reject('INTEGRITY')
        const digest = createHash('sha256')
        for await (const bytes of handle.createReadStream({ autoClose: false })) { signal?.throwIfAborted(); digest.update(bytes) }
        if (digest.digest('hex') !== manifest.artifact.sha256 || !sameFile(before, await handle.stat({ bigint: true }))
          || !sameFile(before, await fs.lstat(file, { bigint: true }))) reject('INTEGRITY')
      } catch {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
        reject('INTEGRITY')
      } finally { await handle?.close() }
    },
  }
}
