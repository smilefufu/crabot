import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { discoverLegacyUserInstall, discoverDefaultLegacyUserInstall } from '../legacy-desktop.mjs'

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'crabot-legacy-discovery-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const root = path.join(parent, '旧安装'), dataDir = path.join(parent, '自定义 数据'), etcDir = path.join(parent, 'etc')
  for (const directory of [root, dataDir, etcDir]) await fs.mkdir(directory)
  return { root, dataDir, etcDir, source: {} }
}

test('unknown versions, source and system/dev installs remain untouched', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.root, 'VERSION'), 'v1900.1.1\n')
  await fs.writeFile(path.join(f.dataDir, 'keep'), 'business-data')
  await assert.rejects(discoverLegacyUserInstall(f), { code: 'CRABOT_LEGACY_UNSUPPORTED' })
  await fs.mkdir(path.join(f.root, '.git'))
  await assert.rejects(discoverLegacyUserInstall(f), /不属于/)
  await fs.rm(path.join(f.root, '.git'), { recursive: true })
  await assert.rejects(discoverLegacyUserInstall({ ...f, source: { CRABOT_DEV: 'true' } }), /system\/dev/)
  await assert.rejects(discoverLegacyUserInstall({ ...f, source: { CRABOT_PORT_OFFSET: '100' } }), /system\/dev/)
  await fs.writeFile(path.join(f.etcDir, 'cluster.version'), '1')
  await assert.rejects(discoverLegacyUserInstall(f), /system\/dev/)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'keep'), 'utf8'), 'business-data')
  assert.deepEqual(await fs.readdir(f.dataDir), ['keep'])
})

test('a symbolic data root is refused without following or modifying its target', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), link = path.join(f.root, 'data')
  await fs.symlink(f.dataDir, link, 'dir')
  await assert.rejects(discoverLegacyUserInstall({ ...f, dataDir: link }), /不属于当前系统用户/)
  assert.deepEqual(await fs.readdir(f.dataDir), [])
})

for (const version of ['v2026.10.14.1', 'v2026.10.15.1']) {
  test('read-only recognition matches the verified real release ' + version, async t => {
    const f = await fixture(t)
    await materializeLegacyRelease(f.root, version)
    const discovered = await discoverLegacyUserInstall(f)
    assert.equal(discovered.version, version)
    assert.equal(discovered.dataRoot, realpathSync(f.dataDir))
    assert.match(discovered.fingerprint, /^[a-f0-9]{64}$/)
    assert.deepEqual(await fs.readdir(f.dataDir), [])
    await fs.appendFile(path.join(f.root, 'scripts/start.mjs'), '\n// custom service\n')
    await assert.rejects(discoverLegacyUserInstall(f), /关键入口已修改/)
  })
}

// Published Windows entry files use CRLF. Even a line-ending-only edit is not
// silently accepted as the original release on another native platform.
test('raw platform entry fingerprints reject line-ending changes', async t => {
  const f = await fixture(t)
  await materializeLegacyRelease(f.root)
  const entry = path.join(f.root, 'cli.mjs')
  const before = await fs.readFile(entry, 'utf8')
  const changed = process.platform === 'win32' ? before.replaceAll('\r\n', '\n') : before.replaceAll('\n', '\r\n')
  assert.notEqual(changed, before)
  await fs.writeFile(entry, changed)
  await assert.rejects(discoverLegacyUserInstall({ root: f.root, dataDir: f.dataDir }), { code: 'CRABOT_LEGACY_UNSUPPORTED' })
})

async function defaultFixture(t) {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'crabot-default-legacy-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const home = path.join(parent, '普通 用户'), root = path.join(home, '.crabot'), dataDir = path.join(root, 'data'), etcDir = path.join(parent, 'etc')
  await fs.mkdir(home); await fs.mkdir(etcDir)
  return { home, root, dataDir, etcDir, source: {} }
}

test('default discovery creates no installation or data directory on a clean home', async t => {
  const f = await defaultFixture(t)
  assert.equal(await discoverDefaultLegacyUserInstall(f), null)
  assert.deepEqual(await fs.readdir(f.home), [])
})

for (const version of ['v2026.10.14.1', 'v2026.10.15.1']) test('default discovery finds the existing standard user deployment in place: ' + version, async t => {
  const f = await defaultFixture(t)
  await fs.mkdir(f.dataDir, { recursive: true }); await materializeLegacyRelease(f.root, version)
  await fs.writeFile(path.join(f.dataDir, 'original-history'), 'must stay here')
  const before = await fs.readdir(f.root), dataBefore = await fs.readdir(f.dataDir)
  const result = await discoverDefaultLegacyUserInstall(f)
  assert.deepEqual(result, await discoverLegacyUserInstall(f))
  assert.deepEqual(await fs.readdir(f.root), before); assert.deepEqual(await fs.readdir(f.dataDir), dataBefore)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'original-history'), 'utf8'), 'must stay here')
})

test('unrecognized default data requires locating the original installation instead of offering an empty replacement', async t => {
  const f = await defaultFixture(t); await fs.mkdir(f.dataDir, { recursive: true })
  await fs.writeFile(path.join(f.dataDir, 'original-history'), 'must stay here')
  await assert.rejects(discoverDefaultLegacyUserInstall(f), { code: 'CRABOT_LEGACY_UNSUPPORTED' })
  assert.deepEqual(await fs.readdir(f.dataDir), ['original-history'])
})

test('known old entry files without their data directory do not silently become a fresh installation', async t => {
  const f = await defaultFixture(t); await fs.mkdir(f.root); await materializeLegacyRelease(f.root)
  await assert.rejects(discoverDefaultLegacyUserInstall(f), { code: 'CRABOT_LEGACY_UNSUPPORTED' })
  await assert.rejects(fs.lstat(f.dataDir), { code: 'ENOENT' })
})

test('a linked standard installation cannot redirect automatic discovery', { skip: process.platform === 'win32' }, async t => {
  const f = await defaultFixture(t), target = path.join(f.home, 'unselected')
  await fs.mkdir(target); await fs.symlink(target, f.root, 'dir')
  await assert.rejects(discoverDefaultLegacyUserInstall(f), { code: 'CRABOT_LEGACY_UNSUPPORTED' })
  assert.deepEqual(await fs.readdir(target), [])
})

test('an empty default root remains empty during fresh-install discovery', async t => {
  const f = await defaultFixture(t); await fs.mkdir(f.root)
  assert.equal(await discoverDefaultLegacyUserInstall(f), null)
  assert.deepEqual(await fs.readdir(f.root), [])
})

for (const mode of ['system', 'dev', 'offset']) test('default discovery refuses other deployment modes even before creating a user root: ' + mode, async t => {
  const f = await defaultFixture(t)
  if (mode === 'system') await fs.writeFile(path.join(f.etcDir, 'cluster.version'), '1')
  if (mode === 'dev') f.source.CRABOT_DEV = 'true'
  if (mode === 'offset') f.source.CRABOT_PORT_OFFSET = '100'
  await assert.rejects(discoverDefaultLegacyUserInstall(f), { code: 'CRABOT_LEGACY_UNSUPPORTED' })
  assert.deepEqual(await fs.readdir(f.home), [])
})
