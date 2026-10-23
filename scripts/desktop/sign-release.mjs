// Development publisher only. Formal signing credentials/channel remain disabled.
import { createPrivateKey, createPublicKey, createHash, sign } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import identity from '../lib/process-identity.cjs'
import { DesktopReleaseManifestSchema, serializeDesktopReleaseManifest, serializeDesktopReleaseSignatures,
  desktopReleaseMetadataNames } from '../../crabot-client/dist/contracts/index.js'
import { createDesktopReleaseVerifier } from '../../crabot-desktop/dist/release-signatures.js'
const fail = kind => { throw Object.assign(new Error('Desktop release signing was not completed.'), { code: 'CRABOT_DESKTOP_RELEASE_' + kind }) }

export function signDesktopReleaseManifest(manifest, privateKeys) {
  let raw
  try { raw = Buffer.from(serializeDesktopReleaseManifest(manifest)); if (raw.length > 65536) fail('METADATA') }
  catch { fail('METADATA') }
  try {
    if (!Array.isArray(privateKeys) || !privateKeys.length || privateKeys.length > 4) fail('SIGNATURE')
    const publicKeys = [], signatures = privateKeys.map(pem => {
      if (typeof pem !== 'string' || pem.length > 4096 || !pem.startsWith('-----BEGIN PRIVATE KEY-----\n')) fail('SIGNATURE')
      const key = createPrivateKey(pem)
      if (key.asymmetricKeyType !== 'ed25519') fail('SIGNATURE')
      const publicKey = createPublicKey(key)
      publicKeys.push(publicKey.export({ type: 'spki', format: 'pem' }).toString())
      return { key_id: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
        signature: sign(null, raw, key).toString('base64url') }
    })
    const envelope = Buffer.from(serializeDesktopReleaseSignatures({ schema_version: 1, signatures }))
    if (envelope.length > 4096) fail('SIGNATURE')
    return { manifest: raw, signatures: envelope, publicKeys }
  } catch { fail('SIGNATURE') }
}

export async function writeSignedDesktopRelease({ manifest, artifact, privateKeys, output }) {
  manifest = DesktopReleaseManifestSchema.parse(manifest)
  const signed = signDesktopReleaseManifest(manifest, privateKeys)
  // Publisher-side self-check, not consumer key enrollment. It has no lifecycle effects.
  const verifier = createDesktopReleaseVerifier(signed.publicKeys)
  const proof = verifier.verifyMetadata(signed.manifest, signed.signatures, { platform: manifest.platform, arch: manifest.arch, purpose: 'install' })
  await verifier.verifyArtifact(artifact, proof)
  const names = desktopReleaseMetadataNames(manifest.platform, manifest.arch)
  await fs.mkdir(output, { mode: 0o700 }) // Never replace an existing publication.
  const manifestFile = path.join(output, names.manifest), signaturesFile = path.join(output, names.signatures)
  await fs.writeFile(manifestFile, signed.manifest, { flag: 'wx', mode: 0o644, flush: true })
  await fs.writeFile(signaturesFile, signed.signatures, { flag: 'wx', mode: 0o644, flush: true })
  await fs.writeFile(path.join(output, 'candidate-only.json'), JSON.stringify({ candidate_only: true, release_signed: false }) + '\n', { flag: 'wx', mode: 0o644, flush: true })
  return { candidate_only: true, manifestFile, signaturesFile,
    key_ids: JSON.parse(signed.signatures.toString('utf8')).signatures.map(item => item.key_id) }
}

async function readInput(file, limit, secret = false) {
  const before = await fs.lstat(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(limit)) fail('SIGNATURE')
  if (secret) {
    const privateFile = process.platform === 'win32' ? identity.isPrivateFile(file)
      : before.uid === BigInt(process.getuid()) && (before.mode & 0o777n) === 0o600n
    if (!privateFile) fail('SIGNATURE')
  }
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const same = stat => ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].every(name => stat[name] === before[name])
    if (!same(await handle.stat({ bigint: true }))) fail('SIGNATURE')
    const bytes = Buffer.alloc(limit + 1); let used = 0
    while (used <= limit) { const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null); if (!bytesRead) break; used += bytesRead; if (used > limit) fail('SIGNATURE') }
    if (BigInt(used) !== before.size || !same(await handle.stat({ bigint: true })) || !same(await fs.lstat(file, { bigint: true }))) fail('SIGNATURE')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))
  } finally { await handle.close() }
}
async function main() {
  const args = new Map(), keyFiles = []
  for (const value of process.argv.slice(2)) {
    const split = value.indexOf('='); if (split < 0) fail('METADATA')
    const name = value.slice(0, split), text = value.slice(split + 1)
    if (!text || !['--candidate', '--manifest', '--artifact', '--key', '--out'].includes(name)) fail('METADATA')
    if (name === '--key') keyFiles.push(text)
    else { if (args.has(name)) fail('METADATA'); args.set(name, text) }
  }
  if (args.get('--candidate') !== 'true' || args.size !== 4 || !keyFiles.length || keyFiles.length > 4) fail('METADATA')
  const manifest = JSON.parse(await readInput(args.get('--manifest'), 65536))
  const privateKeys = []
  for (const file of keyFiles) privateKeys.push(await readInput(file, 4096, true))
  const result = await writeSignedDesktopRelease({ manifest, artifact: path.resolve(args.get('--artifact')), privateKeys, output: path.resolve(args.get('--out')) })
  console.log(JSON.stringify(result))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch(() => { process.stderr.write('CRABOT_DESKTOP_RELEASE_SIGNING_FAILED\n'); process.exitCode = 1 })
}
