import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { signDesktopReleaseManifest, writeSignedDesktopRelease } from './sign-release.mjs'
import { createDesktopReleaseVerifier } from '../../crabot-desktop/dist/release-signatures.js'
const require = createRequire(new URL('../../crabot-admin/package.json', import.meta.url)), AdmZip = require('adm-zip')
const keys = generateKeyPairSync('ed25519'), pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-release-signing-')); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const components = { 'gui/program.js': 'throw new Error("must not execute")', 'core/cli.mjs': 'core runtime bytes', 'gui/resources/helper': 'native helper bytes' }
  const archive = changed => { const zip = new AdmZip(); for (const [name, bytes] of Object.entries(components)) zip.addFile(name, Buffer.from(name === changed ? bytes.toUpperCase() : bytes)); return zip.toBuffer() }
  const original = archive(), artifact = path.join(root, 'Crabot-test.zip'); await fs.writeFile(artifact, original, { mode: 0o600 })
  const manifest = { schema_version: 1, app_id: 'com.crabot.desktop', platform: process.platform, arch: process.arch,
    selection: { schema_version: 1, version: '1.2.3', gui_id: '00112233-4455-6677-8899-aabbccddeeff', core_id: 'a'.repeat(64) },
    artifact: { file: path.basename(artifact), size: original.length, sha256: createHash('sha256').update(original).digest('hex') } }
  return { root, artifact, manifest, archive, original, components }
}
test('test-key publication writes the shared canonical formats and never writes the private key', async t => {
  const f = await fixture(t), output = path.join(f.root, 'signed')
  const result = await writeSignedDesktopRelease({ manifest: f.manifest, artifact: f.artifact, privateKeys: [pem], output })
  const raw = await fs.readFile(result.manifestFile), signatures = await fs.readFile(result.signaturesFile)
  assert.equal(raw.toString(), JSON.stringify(f.manifest) + '\n')
  assert.equal((await fs.readdir(output)).length, 3)
  const marker = JSON.parse(await fs.readFile(path.join(output, 'candidate-only.json'), 'utf8'))
  assert.equal(marker.candidate_only, true); assert.equal(marker.release_signed, false)
  const verifier = createDesktopReleaseVerifier([keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()])
  await verifier.verifyArtifact(f.artifact, verifier.verifyMetadata(raw, signatures, { platform: process.platform, arch: process.arch, purpose: 'install' }))
  for (const name of await fs.readdir(output)) assert.equal((await fs.readFile(path.join(output, name), 'utf8')).includes('PRIVATE KEY'), false)
  await assert.rejects(writeSignedDesktopRelease({ manifest: f.manifest, artifact: f.artifact, privateKeys: [pem], output }))
})
test('GUI, Core and helper modifications in an actual ZIP are each rejected before publishing metadata', async t => {
  const f = await fixture(t)
  for (const [i, component] of Object.keys(f.components).entries()) {
    await fs.writeFile(f.artifact, f.archive(component))
    const output = path.join(f.root, 'tampered-' + i)
    await assert.rejects(writeSignedDesktopRelease({ manifest: f.manifest, artifact: f.artifact, privateKeys: [pem], output }), { code: 'CRABOT_DESKTOP_RELEASE_INTEGRITY' })
    await assert.rejects(fs.lstat(output), { code: 'ENOENT' })
  }
})
test('CLI accepts explicit private test-key files only and redacts failed signing input', async t => {
  const f = await fixture(t), descriptor = path.join(f.root, 'manifest.json'), key = path.join(f.root, 'test-key.pem')
  await fs.writeFile(descriptor, JSON.stringify(f.manifest)); await fs.writeFile(key, pem, { mode: 0o600 })
  if (process.platform === 'win32') require('../scripts/lib/process-identity.cjs').writePrivateFile(key + '.private', pem)
  const keyFile = process.platform === 'win32' ? key + '.private' : key
  const command = new URL('./sign-release.mjs', import.meta.url)
  const { fileURLToPath } = await import('node:url')
  const args = ['--candidate=true', '--manifest=' + descriptor, '--artifact=' + f.artifact, '--key=' + keyFile, '--out=' + path.join(f.root, 'cli')]
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(command), ...args], { timeout: 30000 })
  assert.equal(result.stdout.includes('PRIVATE KEY'), false)
  await fs.writeFile(descriptor, '{"private-secret":"must-not-print"}')
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(command), ...args], { timeout: 30000 }), error => {
    assert.equal(error.stderr.includes('must-not-print'), false); assert.match(error.stderr, /CRABOT_DESKTOP_RELEASE_SIGNING_FAILED/); return true
  })
})

test('transition signatures verify against either pinned key and invalid signing keys remain closed', async t => {
  const f = await fixture(t), next = generateKeyPairSync('ed25519'), nextPem = next.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const signed = signDesktopReleaseManifest(f.manifest, [pem, nextPem])
  for (const key of [keys, next]) {
    const verifier = createDesktopReleaseVerifier([key.publicKey.export({ type: 'spki', format: 'pem' }).toString()])
    await verifier.verifyArtifact(f.artifact, verifier.verifyMetadata(signed.manifest, signed.signatures, { platform: process.platform, arch: process.arch, purpose: 'install' }))
  }
  for (const privateKeys of [[], [pem, pem], ['private-test-secret'], [keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()],
    [generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()]]) {
    assert.throws(() => signDesktopReleaseManifest(f.manifest, privateKeys), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
  }
  assert.throws(() => signDesktopReleaseManifest({ ...f.manifest, secret: 'private-test-secret' }, [pem]), { code: 'CRABOT_DESKTOP_RELEASE_METADATA' })
})
