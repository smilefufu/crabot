import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import asar from '@electron/asar'
import { createDesktopReleaseIntake } from '../dist/release-intake.js'
import { signDesktopReleaseManifest, writeSignedDesktopPayload } from '../../scripts/desktop/sign-release.mjs'
import { writeCoreRelease, verifyCoreRelease } from '../../scripts/lib/core-release.mjs'
import { sealDesktopPayload, verifyDesktopPayload } from '../../scripts/lib/desktop-payload.mjs'
const require = createRequire(new URL('../../crabot-admin/package.json', import.meta.url)), AdmZip = require('adm-zip')
const python = process.env.CRABOT_TEST_PYTHON
assert.ok(python && path.isAbsolute(python), 'Run with the actual bundled Python through test-paired-release-intake.mjs')
const key = generateKeyPairSync('ed25519'), privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot signed intake ')))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const payload = path.join(root, 'payload'), core = path.join(payload, 'core'), gui = path.join(payload, 'gui')
  const resources = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
  await fs.mkdir(core, { recursive: true }); await fs.mkdir(resources, { recursive: true })
  for (const name of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(core, name), JSON.stringify({ version: '1.2.3' }))
  await fs.writeFile(path.join(core, 'program.mjs'), 'throw new Error("target code must not execute")')
  await writeCoreRelease(core, { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch, commit: 'a'.repeat(40), source_dirty: false })
  const selection = { schema_version: 1, version: '1.2.3', gui_id: randomUUID(), core_id: (await verifyCoreRelease(core)).inventory_sha256 }
  await fs.writeFile(path.join(core, 'desktop-host.json'), JSON.stringify({ schema_version: 2, platform: process.platform, arch: process.arch }))
  const input = path.join(root, 'asar-input'); await fs.mkdir(path.join(input, 'dist'), { recursive: true })
  await fs.writeFile(path.join(input, 'dist/desktop-release.json'), JSON.stringify(selection) + '\n')
  await asar.createPackage(input, path.join(resources, 'app.asar'))
  await fs.writeFile(path.join(resources, 'desktop-release.json'), JSON.stringify(selection) + '\n')
  const executable = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : process.platform === 'win32' ? 'Crabot.exe' : 'crabot-desktop')
  const helper = path.join(resources, 'app.asar.unpacked/dist/bootstrap/crabot-native/build/Release/crabot-native.node')
  for (const file of [executable, helper]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'finite fixture, never executed') }
  await sealDesktopPayload(payload)
  const zip = new AdmZip()
  async function add(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await add(file)
      else zip.addFile(path.relative(payload, file).split(path.sep).join('/'), await fs.readFile(file), '', (await fs.stat(file)).mode)
    }
  }
  await add(payload)
  const bytes = zip.toBuffer(), artifact = path.join(root, 'Crabot.zip'); await fs.writeFile(artifact, bytes, { mode: 0o600 })
  const manifest = { schema_version: 1, app_id: 'com.crabot.desktop', platform: process.platform, arch: process.arch, selection,
    artifact: { file: 'Crabot.zip', size: bytes.length, sha256: digest(bytes) } }
  const signed = signDesktopReleaseManifest(manifest, [privateKey]), calls = []
  const intake = createDesktopReleaseIntake({ pinnedPublicKeys: [publicKey], python, cacheRoot: path.join(root, 'cache'),
    verifyPayload: async (directory, options) => { calls.push('verify'); return verifyDesktopPayload(directory, options) },
    preparePair: async options => { calls.push('prepare'); return { payload: options.payload } } })
  const request = { manifestBytes: signed.manifest, signatureBytes: signed.signatures, artifact,
    context: { platform: process.platform, arch: process.arch, purpose: 'update', currentVersion: '1.2.2' } }
  return { root, payload, intake, request, signed, calls, manifest, artifact }
}
test('authenticated actual ZIP passes full GUI/Core verification before preparation; JSON cannot authorize a later call', async t => {
  const f = await fixture(t), staged = await f.intake.stage(f.request)
  assert.deepEqual(f.calls, ['verify'])
  await assert.rejects(f.intake.prepare(JSON.parse(JSON.stringify(staged)), { installRoot: f.root }), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
  const prepared = await f.intake.prepare(staged, { installRoot: f.root, payload: 'unsigned-input-must-not-override-stage' })
  assert.deepEqual(f.calls, ['verify', 'verify', 'prepare'])
  assert.notEqual(prepared.payload, 'unsigned-input-must-not-override-stage')
  assert.equal((await fs.readFile(path.join(prepared.payload, 'core/program.mjs'), 'utf8')).startsWith('throw'), true)
  await f.intake.discard(staged)
  await assert.rejects(fs.lstat(prepared.payload), { code: 'ENOENT' })
  await assert.rejects(f.intake.prepare(staged, { installRoot: f.root }), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
})
test('invalid source or archive never creates an extraction directory or reaches payload/target code', async t => {
  const f = await fixture(t), wrong = Buffer.from(f.signed.manifest); wrong[10] ^= 1
  await assert.rejects(f.intake.stage({ ...f.request, manifestBytes: wrong }), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
  await fs.appendFile(f.artifact, 'modified')
  await assert.rejects(f.intake.stage(f.request), { code: 'CRABOT_DESKTOP_RELEASE_INTEGRITY' })
  assert.deepEqual(f.calls, [])
  await assert.rejects(fs.lstat(path.join(f.root, 'cache')), { code: 'ENOENT' })
})
test('a valid signature cannot substitute a different payload selection', async t => {
  const f = await fixture(t), signed = signDesktopReleaseManifest({ ...f.manifest, selection: { ...f.manifest.selection, gui_id: randomUUID() } }, [privateKey])
  await assert.rejects(f.intake.stage({ ...f.request, manifestBytes: signed.manifest, signatureBytes: signed.signatures }), { code: 'CRABOT_DESKTOP_RELEASE_INTEGRITY' })
  assert.deepEqual(f.calls, ['verify'])
  assert.deepEqual(await fs.readdir(path.join(f.root, 'cache')), [])
})
test('modified extracted inventory or archive and pre-cancellation never reach preparation', async t => {
  const f = await fixture(t), abort = new AbortController(); abort.abort('private-secret')
  await assert.rejects(f.intake.stage({ ...f.request, signal: abort.signal }), { name: 'AbortError', message: 'Cancelled' })
  assert.deepEqual(f.calls, [])
  const staged = await f.intake.stage(f.request)
  const [job] = await fs.readdir(path.join(f.root, 'cache'))
  const file = path.join(f.root, 'cache', job, 'payload/desktop-payload.json')
  await fs.appendFile(file, ' ')
  await assert.rejects(f.intake.prepare(staged, { installRoot: f.root }), { code: 'CRABOT_DESKTOP_RELEASE_INTEGRITY' })
  assert.equal(f.calls.includes('prepare'), false)
  await f.intake.discard(staged)
})


for (const format of ['zip', 'tar.gz']) test('producer derives and signs the actual complete payload: ' + format, async t => {
  const f = await fixture(t), output = path.join(f.root, 'publication')
  const result = await writeSignedDesktopPayload({ payload: f.payload, python, privateKeys: [privateKey], output, format })
  const manifestBytes = await fs.readFile(result.manifestFile), signatureBytes = await fs.readFile(result.signaturesFile)
  const descriptor = JSON.parse(manifestBytes)
  assert.deepEqual(descriptor.selection, f.manifest.selection)
  assert.equal(descriptor.artifact.size, (await fs.stat(result.artifact)).size)
  assert.equal(descriptor.artifact.file.endsWith('.' + format), true)
  assert.deepEqual((await fs.readdir(output)).sort(), [path.basename(result.artifact), path.basename(result.manifestFile), path.basename(result.signaturesFile), 'candidate-only.json'].sort())
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'candidate-only.json'), 'utf8')).candidate_only, true)
  const staged = await f.intake.stage({ ...f.request, manifestBytes, signatureBytes, artifact: result.artifact })
  assert.deepEqual(staged.manifest.selection, f.manifest.selection)
  await f.intake.discard(staged)
  await assert.rejects(writeSignedDesktopPayload({ payload: f.payload, python, privateKeys: [privateKey], output, format }))
  assert.deepEqual(await fs.readFile(result.manifestFile), manifestBytes)
  for (const file of await fs.readdir(output)) assert.equal((await fs.readFile(path.join(output, file))).includes(Buffer.from('BEGIN PRIVATE KEY')), false)
})

test('producer refuses changed payload bytes before publishing any archive or metadata', async t => {
  const f = await fixture(t), output = path.join(f.root, 'unpublished')
  await fs.appendFile(path.join(f.payload, 'core/program.mjs'), 'changed')
  await assert.rejects(writeSignedDesktopPayload({ payload: f.payload, python, privateKeys: [privateKey], output }))
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' })
})


test('complete publisher CLI uses the verified bundled runtime and only explicit private test-key files', { timeout: 180000 }, async t => {
  const f = await fixture(t), keyFile = path.join(f.root, 'ephemeral-test-key.pem')
  if (process.platform === 'win32') require('../scripts/lib/process-identity.cjs').writePrivateFile(keyFile, privateKey)
  else await fs.writeFile(keyFile, privateKey, { mode: 0o600 })
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util'), { fileURLToPath } = await import('node:url')
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../scripts/desktop/sign-release.mjs', import.meta.url)),
    '--candidate=true', '--payload=' + f.payload, '--runtime-core=' + process.env.CRABOT_TEST_RUNTIME_CORE,
    '--key=' + keyFile, '--out=' + path.join(f.root, 'cli-publication')], { timeout: 170000 })
  assert.equal(result.stdout.includes('PRIVATE KEY'), false); assert.equal(result.stderr.includes('PRIVATE KEY'), false)
  const publication = JSON.parse(result.stdout)
  const staged = await f.intake.stage({ ...f.request, manifestBytes: await fs.readFile(publication.manifestFile), signatureBytes: await fs.readFile(publication.signaturesFile), artifact: publication.artifact })
  assert.deepEqual(staged.manifest.selection, f.manifest.selection)
  await f.intake.discard(staged)
})

test('publisher rejects an output inside the immutable payload before creating any staging files', async t => {
  const f = await fixture(t)
  t.mock.method(fs, 'mkdtemp', async () => { throw new Error('must not create a publication inside source programs') })
  await assert.rejects(writeSignedDesktopPayload({ payload: f.payload, python, privateKeys: [privateKey], output: path.join(f.payload, 'gui/publication') }),
    { code: 'CRABOT_DESKTOP_RELEASE_METADATA' })
})
