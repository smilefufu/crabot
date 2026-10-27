import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { discoverLegacyUserInstall, discoverDefaultLegacyUserInstall, assertFreshUserInstallation } from '../legacy-desktop.mjs'

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

for (const version of ['v2026.10.14.1', 'v2026.10.15.1']) test('fresh installer cannot bypass an existing release with an empty data directory: ' + version, async t => {
  const f = await defaultFixture(t)
  await fs.mkdir(f.dataDir, { recursive: true }); await materializeLegacyRelease(f.root, version)
  const names = await fs.readdir(f.root)
  await assert.rejects(assertFreshUserInstallation(f), { code: 'CRABOT_DESKTOP_TAKEOVER_REQUIRED' })
  assert.deepEqual(await fs.readdir(f.root), names)
  assert.deepEqual(await fs.readdir(f.dataDir), [])
})

test('fresh installer preserves an unrecognized old footprint without creating a replacement', async t => {
  const f = await defaultFixture(t)
  await fs.mkdir(f.root); await fs.writeFile(path.join(f.root, 'VERSION'), 'unrecognized old release')
  await assert.rejects(assertFreshUserInstallation(f), { code: 'CRABOT_DESKTOP_TAKEOVER_REQUIRED' })
  assert.deepEqual(await fs.readdir(f.root), ['VERSION'])
})

test('fresh installer accepts a clean home or empty default root without creating data', async t => {
  const f = await defaultFixture(t)
  await assertFreshUserInstallation(f)
  assert.deepEqual(await fs.readdir(f.home), [])
  await fs.mkdir(f.root)
  await assertFreshUserInstallation(f)
  assert.deepEqual(await fs.readdir(f.root), [])
})

test('offline installer discovery loads outside the checkout without Core or old-code execution', async t => {
  const f = await defaultFixture(t), bootstrap = path.join(f.home, 'installer/bootstrap')
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  for (const relative of ['scripts/lib/legacy-desktop.mjs', 'scripts/lib/legacy-release-identity.mjs', 'scripts/lib/legacy-release-files.mjs',
    'scripts/lib/mode.mjs', 'scripts/lib/process-identity.cjs', 'scripts/desktop/legacy-releases.json', 'crabot-native/build/Release/crabot-native.node']) {
    const target = path.join(bootstrap, relative)
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(repository, relative), target)
  }
  await fs.mkdir(f.dataDir, { recursive: true }); await materializeLegacyRelease(f.root)
  const names = await fs.readdir(f.root)
  const script = `
    import assert from 'node:assert/strict'
    import { pathToFileURL } from 'node:url'
    const [module,home,etcDir] = process.argv.slice(1)
    const { assertFreshUserInstallation } = await import(pathToFileURL(module).href)
    await assert.rejects(assertFreshUserInstallation({home,etcDir,source:{}}), {code:'CRABOT_DESKTOP_TAKEOVER_REQUIRED'})
    console.log('OFFLINE_LEGACY_PREFLIGHT_CONFIRMED')
  `
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []))
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script,
    path.join(bootstrap, 'scripts/lib/legacy-desktop.mjs'), f.home, f.etcDir], { env, cwd: bootstrap, timeout: 10000, maxBuffer: 65536 })
  assert.equal(result.stdout.trim(), 'OFFLINE_LEGACY_PREFLIGHT_CONFIRMED')
  assert.deepEqual(await fs.readdir(f.root), names)
  assert.deepEqual(await fs.readdir(f.dataDir), [])
  await assert.rejects(fs.lstat(path.join(bootstrap, 'crabot-core')), { code: 'ENOENT' })
})

test('desktop takeover discovery leaves clean locations untouched and recognizes the original root', async t => {
  const f = await defaultFixture(t)
  const { discoverLegacyDesktopTakeover } = await import('../legacy-desktop-discovery.mjs')
  assert.equal(await discoverLegacyDesktopTakeover({ root: f.root, source: f.source, etcDir: f.etcDir }), null)
  await assert.rejects(fs.stat(f.root), { code: 'ENOENT' })
  await fs.mkdir(f.dataDir, { recursive: true }); await materializeLegacyRelease(f.root)
  const result = await discoverLegacyDesktopTakeover({ root: f.root, source: f.source, etcDir: f.etcDir })
  assert.equal(result.installation.installRoot, realpathSync(f.root))
  assert.equal((await fs.stat(result.installation.installRoot, { bigint: true })).ino, (await fs.stat(f.root, { bigint: true })).ino)
  assert.equal(result.entryFenceId, undefined)
  assert.deepEqual(await fs.readdir(f.dataDir), [])
})

test('desktop takeover discovery reads a fenced source without pretending it is a fresh install', async t => {
  const f = await defaultFixture(t); await fs.mkdir(f.dataDir, { recursive: true }); await materializeLegacyRelease(f.root)
  const { discoverLegacyDesktopTakeover } = await import('../legacy-desktop-discovery.mjs')
  const { fenceLegacyEntries } = await import('../legacy-entry-fence.mjs')
  const original = await discoverLegacyUserInstall(f), entry = await fenceLegacyEntries(original)
  const result = await discoverLegacyDesktopTakeover({ root: f.root, source: f.source, etcDir: f.etcDir })
  assert.deepEqual(result.installation, original); assert.equal(result.entryFenceId, entry.id)
  assert.deepEqual(await fs.readdir(f.dataDir), [])
})


test('a cancelled and restored old takeover can be discovered again without changing its data', async t => {
  const f = await defaultFixture(t); await fs.mkdir(f.dataDir, { recursive: true }); await materializeLegacyRelease(f.root)
  const { discoverLegacyDesktopTakeover } = await import('../legacy-desktop-discovery.mjs')
  const { fenceLegacyEntries, restoreLegacyEntries } = await import('../legacy-entry-fence.mjs')
  const original = await discoverLegacyUserInstall(f)
  await fenceLegacyEntries(original); await restoreLegacyEntries(f.root)
  assert.deepEqual(await discoverLegacyDesktopTakeover({ root: f.root, source: f.source, etcDir: f.etcDir }), { installation: original })
  assert.deepEqual(await fs.readdir(f.dataDir), [])
})
