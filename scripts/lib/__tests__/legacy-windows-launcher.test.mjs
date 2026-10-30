import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { verifyLegacyReleaseEntries } from '../legacy-release-identity.mjs'
import { discoverLegacyUserInstall } from '../legacy-desktop.mjs'
import { fenceLegacyEntries, inspectLegacyEntryFence, restoreLegacyEntries } from '../legacy-entry-fence.mjs'

const source = await fs.readFile(new URL('./fixtures/legacy-windows-launcher.ps1', import.meta.url), 'utf8').then(value => value.replaceAll('\r\n', '\n'))
const privateTemplate = source.split("$private = @'\n")[1]?.split("\n'@")[0]
assert.ok(privateTemplate)
const generated = [Buffer.from('@echo off\nnode "%~dp0cli.mjs" %*\r\n'),
  ...['\n', '\r\n'].map(newline => Buffer.from(privateTemplate.replaceAll('\n', newline) + '\r\n'))]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t, version) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'legacy-launcher-')))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  await materializeLegacyRelease(root, version, { platform: 'win32' })
  return root
}
for (const version of ['v2026.10.14.1', 'v2026.10.15.1']) {
  for (const [index, bytes] of generated.entries()) test('recognize official installed Windows launcher ' + version + '/' + index, async t => {
    const root = await fixture(t, version)
    await fs.writeFile(path.join(root, 'crabot.cmd'), bytes)
    const result = await verifyLegacyReleaseEntries(root, { platform: 'win32' })
    assert.equal(result.files['crabot.cmd'], hash(bytes))
    assert.deepEqual(await fs.readFile(path.join(root, 'crabot.cmd')), bytes)
    await fs.appendFile(path.join(root, 'crabot.cmd'), '\r\necho custom user command\r\n')
    await assert.rejects(verifyLegacyReleaseEntries(root, { platform: 'win32' }), /关键入口已修改/)
  })
}
for (const privateNode of [false, true]) for (const newline of ['\n', '\r\n']) test('actual Windows producer survives discovery, fencing and cancellation: ' + privateNode + '/' + JSON.stringify(newline), { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t, 'v2026.10.14.1'), dataDir = path.join(root, 'data')
  await fs.mkdir(dataDir); await fs.writeFile(path.join(dataDir, 'keep'), 'original user history')
  const producer = path.join(root, 'official-producer.ps1')
  await fs.writeFile(producer, source.replaceAll('\r\n', '\n').replaceAll('\n', newline))
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', producer, '-Directory', root, ...(privateNode ? ['-PrivateNode'] : [])])
  const original = await fs.readFile(path.join(root, 'crabot.cmd'))
  const installation = await discoverLegacyUserInstall({ root, dataDir, source: {} })
  const fence = await fenceLegacyEntries(installation)
  assert.equal((await inspectLegacyEntryFence(root)).id, fence.id)
  await restoreLegacyEntries(root)
  assert.deepEqual(await fs.readFile(path.join(root, 'crabot.cmd')), original)
  assert.equal((await discoverLegacyUserInstall({ root, dataDir, source: {} })).fingerprint, installation.fingerprint)
  assert.equal(await fs.readFile(path.join(dataDir, 'keep'), 'utf8'), 'original user history')
})
