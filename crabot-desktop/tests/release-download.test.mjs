import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { createDesktopReleaseDownloader } from '../dist/release-download.js'
import { signDesktopReleaseManifest } from '../../scripts/desktop/sign-release.mjs'
import { desktopReleaseMetadataNames } from '../../crabot-client/dist/contracts/index.js'
const keys = generateKeyPairSync('ed25519'), pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const base = 'https://github.com/smilefufu/crabot/releases/latest/download/'
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-release-fetch-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('complete archive bytes'), current = { schema_version: 1, version: '1.2.2', gui_id: 'aabbccdd-0011-2233-4455-667788990011', core_id: 'b'.repeat(64) }
  const manifest = { schema_version: 1, app_id: 'com.crabot.desktop', platform: process.platform, arch: process.arch,
    selection: { ...current, version: '1.2.3', core_id: 'a'.repeat(64) }, artifact: { file: 'Crabot.zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
  const names = desktopReleaseMetadataNames(process.platform, process.arch), bodies = new Map(), calls = []
  function setManifest(value) {
    const signed = signDesktopReleaseManifest(value, [privateKey])
    bodies.set(names.manifest, signed.manifest); bodies.set(names.signatures, signed.signatures)
  }
  setManifest(manifest); bodies.set('Crabot.zip', bytes)
  const responses = new Map()
  const fetch = async (url, options) => {
    calls.push({ url, options })
    const name = new URL(url).pathname.split('/').at(-1)
    if (responses.has(name)) return responses.get(name)(url, options)
    return new Response(bodies.get(name), { status: 200 })
  }
  const cacheRoot = path.join(root, 'cache')
  const downloader = createDesktopReleaseDownloader({ pinnedPublicKeys: [pub], platform: process.platform, arch: process.arch, cacheRoot, fetch })
  return { root, bytes, current, manifest, names, bodies, calls, responses, setManifest, cacheRoot, downloader }
}
test('fixed anonymous source authenticates metadata before exact streaming download and disposes only its private job', async t => {
  const f = await fixture(t), progress = [], result = await f.downloader.check(f.current, { progress: value => progress.push(value) })
  assert.deepEqual(await fs.readFile(result.artifact), f.bytes)
  assert.deepEqual(result.manifest, f.manifest)
  assert.equal(progress.at(-1), 100)
  for (const call of f.calls) {
    assert.equal(call.url.startsWith(base), true); assert.equal(call.options.redirect, 'manual')
    assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.headers.Authorization, undefined)
  }
  const keep = path.join(f.cacheRoot, 'unrelated'); await fs.writeFile(keep, 'keep')
  await result.discard()
  assert.equal(await fs.readFile(keep, 'utf8'), 'keep')
  await assert.rejects(fs.lstat(result.artifact), { code: 'ENOENT' })
})
test('exact current signed pair reports current; same-version different pair and lower replay do not download', async t => {
  const f = await fixture(t)
  f.setManifest({ ...f.manifest, selection: f.current })
  assert.equal(await f.downloader.check(f.current), null)
  f.setManifest({ ...f.manifest, selection: { ...f.current, core_id: 'c'.repeat(64) } })
  await assert.rejects(f.downloader.check(f.current), { code: 'CRABOT_DESKTOP_RELEASE_VERSION' })
  f.setManifest({ ...f.manifest, selection: { ...f.current, version: '1.2.1' } })
  await assert.rejects(f.downloader.check(f.current), { code: 'CRABOT_DESKTOP_RELEASE_VERSION' })
  assert.equal(f.calls.some(call => call.url.endsWith('/Crabot.zip')), false)
  await assert.rejects(fs.lstat(f.cacheRoot), { code: 'ENOENT' })
})
test('bad or oversized metadata cannot fetch an archive or create cache', async t => {
  const f = await fixture(t), signed = Buffer.from(f.bodies.get(f.names.manifest)); signed[0] ^= 1
  f.bodies.set(f.names.manifest, signed)
  await assert.rejects(f.downloader.check(f.current), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
  f.bodies.set(f.names.manifest, Buffer.alloc(65537))
  await assert.rejects(f.downloader.check(f.current), { code: 'CRABOT_DESKTOP_RELEASE_METADATA' })
  assert.equal(f.calls.some(call => call.url.endsWith('/Crabot.zip')), false)
  await assert.rejects(fs.lstat(f.cacheRoot), { code: 'ENOENT' })
})
test('official release/CDN redirects work; foreign origins, credentials, downgrade, wrong basename and loops are closed', async t => {
  const f = await fixture(t)
  f.responses.set('Crabot.zip', url => new Response(null, { status: 302, headers: { location: url.includes('/latest/')
    ? 'https://github.com/smilefufu/crabot/releases/download/v1.2.3/Crabot.zip'
    : 'https://release-assets.githubusercontent.com/github-production-release-asset/123/asset-id?signed=opaque' } }))
  f.responses.set('asset-id', () => new Response(f.bytes))
  const result = await f.downloader.check(f.current); await result.discard()
  for (const location of ['https://example.com/Crabot.zip', 'http://github.com/smilefufu/crabot/releases/download/v1/Crabot.zip',
    'https://user:secret@github.com/smilefufu/crabot/releases/download/v1/Crabot.zip',
    'https://github.com/other/repository/releases/download/v1/Crabot.zip',
    'https://github.com/smilefufu/crabot/releases/download/v1/other.zip', base + 'Crabot.zip']) {
    f.responses.set('Crabot.zip', () => new Response(null, { status: 302, headers: { location } }))
    await assert.rejects(f.downloader.check(f.current), { code: 'CRABOT_DESKTOP_RELEASE_METADATA' })
  }
})
test('wrong byte length, digest, HTTP error and overlong stream leave no completed or partial job', async t => {
  const f = await fixture(t)
  for (const response of [() => new Response('x'), () => new Response(Buffer.alloc(f.bytes.length)),
    () => new Response(Buffer.alloc(f.bytes.length + 1)), () => new Response(f.bytes, { headers: { 'content-length': '1' } }),
    () => new Response('private response', { status: 500 })]) {
    f.responses.set('Crabot.zip', response)
    await assert.rejects(f.downloader.check(f.current))
    assert.deepEqual(await fs.readdir(f.cacheRoot), [])
  }
})
test('insufficient space and cancellation remain specific and never complete a download', async t => {
  const f = await fixture(t), statfs = fs.statfs
  t.mock.method(fs, 'statfs', async () => ({ bavail: 1n, bsize: 1n }))
  await assert.rejects(f.downloader.check(f.current), { code: 'CRABOT_UPDATE_SPACE' })
  t.mock.restoreAll(); assert.equal(fs.statfs, statfs)
  const abort = new AbortController(); abort.abort('private-secret')
  await assert.rejects(f.downloader.check(f.current, { signal: abort.signal }), { name: 'AbortError', message: 'Cancelled' })
  assert.deepEqual(await fs.readdir(f.cacheRoot), [])
})

test('cancelling a stalled response aborts its reader and removes the partial private job', { timeout: 2000 }, async t => {
  const f = await fixture(t), abort = new AbortController(); let cancelled = false
  f.responses.set('Crabot.zip', () => new Response(new ReadableStream({ start() { setTimeout(() => abort.abort('private-secret'), 30) }, cancel() { cancelled = true } })))
  await assert.rejects(f.downloader.check(f.current, { signal: abort.signal }), { name: 'AbortError', message: 'Cancelled' })
  assert.equal(cancelled, true)
  assert.deepEqual(await fs.readdir(f.cacheRoot), [])
})

test('metadata failure cancels a stalled sibling while retaining the original closed failure', { timeout: 2000 }, async t => {
  const f = await fixture(t); let cancelled = false
  f.responses.set(f.names.manifest, () => new Response(new ReadableStream({ cancel() { cancelled = true } })))
  f.responses.set(f.names.signatures, () => new Response(Buffer.alloc(4097)))
  await assert.rejects(f.downloader.check(f.current), { code: 'CRABOT_DESKTOP_RELEASE_METADATA' })
  assert.equal(cancelled, true)
  await assert.rejects(fs.lstat(f.cacheRoot), { code: 'ENOENT' })
})

test('space consumed by another process during download stops before writing away the reserve', async t => {
  const f = await fixture(t); let checks = 0
  t.mock.method(fs, 'statfs', async () => ({ bavail: ++checks === 1 ? 2n ** 40n : 1n, bsize: 1n }))
  await assert.rejects(f.downloader.check(f.current), { code: 'CRABOT_UPDATE_SPACE' })
  assert.ok(checks > 1)
  assert.deepEqual(await fs.readdir(f.cacheRoot), [])
})

test('transport errors cannot inject arbitrary release codes or raw URLs into feedback', async t => {
  const f = await fixture(t)
  for (const [code, expected] of [['CRABOT_DESKTOP_RELEASE_private-secret', 'CRABOT_DESKTOP_RELEASE_DOWNLOAD'], ['CRABOT_DESKTOP_RELEASE_SIGNATURE', 'CRABOT_DESKTOP_RELEASE_SIGNATURE']]) {
    f.responses.set('Crabot.zip', () => { throw Object.assign(new Error('private-url-secret'), { code }) })
    await assert.rejects(f.downloader.check(f.current), error => {
      assert.equal(error.code, expected); assert.equal(error.message.includes('private'), false); return true
    })
  }
})
