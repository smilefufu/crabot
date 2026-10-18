import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { discoverLegacyUserInstall } from '../legacy-desktop.mjs'

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
