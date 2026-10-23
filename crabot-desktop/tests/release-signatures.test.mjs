import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createDesktopReleaseVerifier } from '../dist/release-signatures.js'
const keys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519')
const publicPem = key => key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const keyId = key => createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
const selection = { schema_version: 1, version: '1.2.3', gui_id: '00112233-4455-6677-8899-aabbccddeeff', core_id: 'a'.repeat(64) }
const context = { platform: 'linux', arch: 'x64', purpose: 'update', currentVersion: '1.2.2' }
function fixture({ bytes = Buffer.from('opaque complete GUI Core runtime package'), change = value => value, signer = keys } = {}) {
  const manifest = change({ schema_version: 1, app_id: 'com.crabot.desktop', platform: 'linux', arch: 'x64', selection: { ...selection },
    artifact: { file: 'Crabot-1.2.3-linux-x64.zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } })
  const raw = Buffer.from(JSON.stringify(manifest) + '\n')
  const envelope = { schema_version: 1, signatures: [{ key_id: keyId(signer), signature: sign(null, raw, signer.privateKey).toString('base64url') }] }
  return { raw, envelope, signatures: Buffer.from(JSON.stringify(envelope) + '\n'), bytes, manifest }
}
test('trusted signatures bind immutable metadata and cannot be forged as plain JSON or reused by another verifier', async t => {
  const f = fixture(), verifier = createDesktopReleaseVerifier([publicPem(keys)]), proof = verifier.verifyMetadata(f.raw, f.signatures, context)
  assert.deepEqual(proof.manifest, f.manifest); assert.equal(Object.isFrozen(proof.manifest.artifact), true)
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-signed-release-')); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, f.manifest.artifact.file); await fs.writeFile(file, f.bytes, { mode: 0o600 })
  await verifier.verifyArtifact(file, proof)
  await assert.rejects(verifier.verifyArtifact(file, proof, { signal: AbortSignal.abort('private-abort-reason') }), error => { assert.equal(error.name, 'AbortError'); assert.equal(error.message.includes('private-abort-reason'), false); return true })
  await assert.rejects(verifier.verifyArtifact(file, JSON.parse(JSON.stringify(proof))), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
  await assert.rejects(createDesktopReleaseVerifier([publicPem(keys)]).verifyArtifact(file, proof), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
  f.raw.fill(0); f.signatures.fill(0); await verifier.verifyArtifact(file, proof)
  await fs.writeFile(file, Buffer.alloc(f.bytes.length, 1)); await assert.rejects(verifier.verifyArtifact(file, proof), { code: 'CRABOT_DESKTOP_RELEASE_INTEGRITY' })
  await fs.writeFile(file, f.bytes); await verifier.verifyArtifact(file, proof)
  const aliasDirectory = path.join(root, 'alias'); await fs.mkdir(aliasDirectory)
  const alias = path.join(aliasDirectory, f.manifest.artifact.file)
  if (process.platform !== 'win32') { await fs.symlink(file, alias); await assert.rejects(verifier.verifyArtifact(alias, proof), { code: 'CRABOT_DESKTOP_RELEASE_INTEGRITY' }) }
  await fs.rm(file); await assert.rejects(verifier.verifyArtifact(file, proof), { code: 'CRABOT_DESKTOP_RELEASE_INTEGRITY' })
})
test('unknown signatures coexist with valid pinned keys but never enroll a key', () => {
  const f = fixture(), verifier = createDesktopReleaseVerifier([publicPem(keys)])
  const unknown = { key_id: keyId(other), signature: sign(null, f.raw, other.privateKey).toString('base64url') }
  const envelope = Buffer.from(JSON.stringify({ schema_version: 1, signatures: [unknown, ...f.envelope.signatures] }) + '\n')
  verifier.verifyMetadata(f.raw, envelope, context)
  assert.throws(() => verifier.verifyMetadata(f.raw, fixture({ signer: other }).signatures, context), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
  assert.throws(() => createDesktopReleaseVerifier([]), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
  assert.throws(() => createDesktopReleaseVerifier([keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()]), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
  assert.throws(() => createDesktopReleaseVerifier([publicPem(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }))]), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
})
test('signature checks precede parsing; valid signatures still cannot authorize malformed or duplicate JSON', () => {
  const f = fixture(), verifier = createDesktopReleaseVerifier([publicPem(keys)])
  const envelope = raw => Buffer.from(JSON.stringify({ schema_version: 1, signatures: [{ key_id: keyId(keys), signature: sign(null, raw, keys.privateKey).toString('base64url') }] }) + '\n')
  const bad = Buffer.from('not JSON; private-secret')
  assert.throws(() => verifier.verifyMetadata(bad, f.signatures, context), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
  for (const raw of [bad, Buffer.from('{"schema_version":1,' + f.raw.toString().slice(1)), Buffer.from(f.raw.toString().trim()), Buffer.from(JSON.stringify(f.manifest, null, 2) + '\n'), Buffer.from([255, 254])]) {
    assert.throws(() => verifier.verifyMetadata(raw, envelope(raw), context), { code: 'CRABOT_DESKTOP_RELEASE_METADATA' })
  }
  for (const raw of [Buffer.alloc(65537), Buffer.alloc(0)]) assert.throws(() => verifier.verifyMetadata(raw, f.signatures, context), { code: 'CRABOT_DESKTOP_RELEASE_METADATA' })
  for (const raw of [Buffer.alloc(4097), Buffer.from('{"schema_version":1,' + f.signatures.toString().slice(1))]) assert.throws(() => verifier.verifyMetadata(f.raw, raw, context), { code: 'CRABOT_DESKTOP_RELEASE_METADATA' })
})
test('wrong product, platform, architecture and version never yield an executable proof', () => {
  const verifier = createDesktopReleaseVerifier([publicPem(keys)])
  for (const change of [m => ({ ...m, app_id: 'foreign.app' }), m => ({ ...m, platform: 'win32' }), m => ({ ...m, arch: 'arm64' })]) {
    const f = fixture({ change }); assert.throws(() => verifier.verifyMetadata(f.raw, f.signatures, context), { code: 'CRABOT_DESKTOP_RELEASE_METADATA' })
  }
  const f = fixture()
  for (const currentVersion of ['1.2.3', '1.2.4', '2.0.0']) assert.throws(() => verifier.verifyMetadata(f.raw, f.signatures, { ...context, currentVersion }), { code: 'CRABOT_DESKTOP_RELEASE_VERSION' })
  verifier.verifyMetadata(f.raw, f.signatures, { ...context, purpose: 'repair', currentVersion: '1.2.3' })
  assert.throws(() => verifier.verifyMetadata(f.raw, f.signatures, { ...context, purpose: 'repair', currentVersion: '1.2.4' }), { code: 'CRABOT_DESKTOP_RELEASE_VERSION' })
  verifier.verifyMetadata(f.raw, f.signatures, { platform: 'linux', arch: 'x64', purpose: 'install' })
  assert.throws(() => verifier.verifyMetadata(f.raw, f.signatures, { platform: 'linux', arch: 'x64', purpose: 'update' }), { code: 'CRABOT_DESKTOP_RELEASE_VERSION' })
})

test('numeric and prerelease comparisons do not permit stale or equivalent update replay', () => {
  const verifier = createDesktopReleaseVerifier([publicPem(keys)])
  for (const [version, currentVersion, accepted] of [['1.10.0', '1.9.0', true], ['1.9.0', '1.10.0', false],
    ['2.0.0', '2.0.0-rc.1', true], ['2.0.0-rc.2', '2.0.0', false], ['2.0.0-rc.10', '2.0.0-rc.9', true],
    ['2.0.0-beta', '2.0.0-alpha.9', true], ['2.0.0-rc.01', '2.0.0-rc.1', false], ['2.0.0-rc', '2.0.0-rc.0', false]]) {
    const f = fixture({ change: m => ({ ...m, selection: { ...m.selection, version } }) })
    if (accepted) verifier.verifyMetadata(f.raw, f.signatures, { ...context, currentVersion })
    else assert.throws(() => verifier.verifyMetadata(f.raw, f.signatures, { ...context, currentVersion }), { code: 'CRABOT_DESKTOP_RELEASE_VERSION' })
  }
})
