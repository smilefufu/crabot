import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { discoverLegacySystemRelease, discoverFencedLegacySystemRelease } from '../legacy-system-release.mjs'
import { legacyEntryFiles, entryFenceBytes } from '../legacy-entry-files.mjs'
const options = { skip: process.platform === 'win32' }
async function fixture(t, version = 'v2026.10.15.1') {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-legacy-system-code-')))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'shared'), data = path.join(parent, 'employee-private')
  await fs.mkdir(root); await fs.mkdir(data); await fs.writeFile(path.join(data, 'credential'), 'must not read or modify')
  await materializeLegacyRelease(root, version)
  return { root, data, discover: extra => discoverLegacySystemRelease({ root, platform: 'linux', ownerUid: process.getuid(), checkRoot: async () => {}, ...extra }) }
}
for (const version of ['v2026.10.14.1', 'v2026.10.15.1']) test('known shared release code is recognized without reading employee state: ' + version, options, async t => {
  const f = await fixture(t, version), before = await fs.readdir(f.root, { recursive: true })
  const result = await f.discover()
  assert.equal(result.version, version); assert.match(result.code_fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(result.dataRoot, undefined); assert.equal(result.fingerprint, undefined, 'code recognition is not a user/data takeover token')
  assert.deepEqual(await fs.readdir(f.root, { recursive: true }), before)
  assert.equal(await fs.readFile(path.join(f.data, 'credential'), 'utf8'), 'must not read or modify')
})
test('modified source, unknown versions, redirect and writable code are refused read-only', options, async t => {
  const f = await fixture(t), entry = path.join(f.root, 'scripts/start.mjs'), bytes = await fs.readFile(entry)
  await fs.writeFile(path.join(f.root, 'VERSION'), 'v1900.1.1\n')
  await assert.rejects(f.discover(), /此历史版本/)
  await fs.writeFile(path.join(f.root, 'VERSION'), 'v2026.10.15.1\n')
  await fs.appendFile(entry, '\n// local customization\n'); await assert.rejects(f.discover(), /关键入口已修改/)
  await fs.writeFile(entry, bytes); await fs.chmod(entry, 0o666); await assert.rejects(f.discover(), /管理员只读/); await fs.chmod(entry, 0o644)
  await fs.mkdir(path.join(f.root, '.git')); await fs.writeFile(path.join(f.root, '.git/local-change'), 'preserve')
  await assert.rejects(f.discover(), /本地修改保留/)
  assert.equal(await fs.readFile(path.join(f.root, '.git/local-change'), 'utf8'), 'preserve')
  await fs.rm(path.join(f.root, '.git'), { recursive: true })
  await fs.rename(entry, entry + '.original'); await fs.symlink(entry + '.original', entry)
  await assert.rejects(f.discover(), /重定向/)
})
test('system recognition preserves root ownership policy and refuses another native platform', options, async t => {
  const f = await fixture(t)
  await assert.rejects(f.discover({ ownerUid: process.getuid() + 1 }), /管理员只读/)
  await assert.rejects(f.discover({ platform: 'darwin' }), /仅支持Linux/)
  await assert.rejects(f.discover({ checkRoot: () => { throw new Error('untrusted installation ancestor') } }), /untrusted installation ancestor/)
})


test('shared entry ownership is rejected before reading employee-controlled critical bytes', options, async t => {
  const f = await fixture(t), file = path.join(f.root, 'scripts/start.mjs'), lstat = fs.lstat, read = fs.readFile
  t.mock.method(fs, 'lstat', async target => {
    const stat = await lstat(target)
    return target === file ? Object.assign(Object.create(stat), { uid: stat.uid + 1 }) : stat
  })
  let reads = 0
  t.mock.method(fs, 'readFile', (target, ...args) => {
    if (target === file) { reads++; assert.fail('must reject an employee-owned critical path before byte inspection') }
    return read(target, ...args)
  })
  await assert.rejects(f.discover(), /管理员只读/)
  assert.equal(reads, 0)
})


for (const version of ['v2026.10.14.1', 'v2026.10.15.1']) test('fenced shared code is rechecked without reading the root-private transaction: ' + version, options, async t => {
  const f = await fixture(t, version), recognized = await f.discover()
  const args = { root: f.root, platform: 'linux', ownerUid: process.getuid(), checkRoot: () => {} }
  await assert.rejects(discoverFencedLegacySystemRelease(args))
  for (const file of legacyEntryFiles) await fs.writeFile(path.join(f.root, file), entryFenceBytes(file, 'system'))
  const read = fs.readFile, lstat = fs.lstat
  const guard = file => {
    if (typeof file === 'string' && (file.startsWith(f.data) || file.includes('.system-takeover'))) assert.fail('readonly shared code observation cannot read root transaction or employee data')
  }
  t.mock.method(fs, 'readFile', (file, ...rest) => { guard(file); return read(file, ...rest) })
  t.mock.method(fs, 'lstat', (file, ...rest) => { guard(file); return lstat(file, ...rest) })
  const result = await discoverFencedLegacySystemRelease(args)
  assert.deepEqual(result, recognized)
  assert.deepEqual(Object.keys(result), ['version', 'installRoot', 'code_fingerprint'])
})

for (const changed of ['partial', 'user-fence', 'modified-code', 'source-marker', 'writable-file']) test('shared code observations reject non-system or incomplete fencing: ' + changed, options, async t => {
  const f = await fixture(t), args = { root: f.root, platform: 'linux', ownerUid: process.getuid(), checkRoot: () => {} }
  const original = await fs.readFile(path.join(f.root, 'scripts/start.mjs'))
  for (const file of legacyEntryFiles) await fs.writeFile(path.join(f.root, file), entryFenceBytes(file, changed === 'user-fence' ? 'desktop' : 'system'))
  if (changed === 'partial') await fs.writeFile(path.join(f.root, 'scripts/start.mjs'), original)
  if (changed === 'modified-code') await fs.appendFile(path.join(f.root, 'crabot-core/dist/index.js'), 'custom')
  if (changed === 'source-marker') await fs.mkdir(path.join(f.root, '.git'))
  if (changed === 'writable-file') await fs.chmod(path.join(f.root, 'scripts/start.mjs'), 0o666)
  await assert.rejects(discoverFencedLegacySystemRelease(args), { code: 'CRABOT_LEGACY_UNSUPPORTED' })
})
