import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'crabot-core-integrity-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const root = path.join(parent, '中文 核心'); await fs.mkdir(root)
  await fs.mkdir(path.join(root, 'bin'))
  await fs.writeFile(path.join(root, 'bin/node'), 'standalone-node', { mode: 0o755 })
  for (const file of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(root, file), JSON.stringify({ version: '1.2.3' }))
  return { parent, root, release: { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch,
    commit: '1'.repeat(40), source_dirty: false } }
}

test('the complete core survives relocation and rejects version/platform mixing', async t => {
  const f = await fixture(t)
  const size = await writeCoreRelease(f.root, f.release)
  assert.equal(size.files, 3); assert.ok(size.bytes > 0)
  const moved = path.join(f.parent, '移动 后'); await fs.rename(f.root, moved)
  assert.equal((await verifyCoreRelease(moved, { version: '1.2.3' })).commit, f.release.commit)
  await assert.rejects(verifyCoreRelease(moved, { version: '1.2.4' }), { code: 'CRABOT_CORE_INTEGRITY' })
  await assert.rejects(verifyCoreRelease(moved, { arch: 'wrong' }), { code: 'CRABOT_CORE_INTEGRITY' })
})

for (const mutation of ['missing', 'changed', 'extra', 'inventory', 'metadata']) test('core verification rejects ' + mutation + ' payloads', async t => {
  const f = await fixture(t); await writeCoreRelease(f.root, f.release)
  if (mutation === 'missing') await fs.rm(path.join(f.root, 'bin/node'))
  if (mutation === 'changed') await fs.writeFile(path.join(f.root, 'bin/node'), 'different-runtime')
  if (mutation === 'extra') await fs.writeFile(path.join(f.root, 'unexpected-private-data'), 'must not ship')
  if (mutation === 'inventory') await fs.appendFile(path.join(f.root, 'core-files.json'), ' ')
  if (mutation === 'metadata') await fs.writeFile(path.join(f.root, 'core-release.json'), JSON.stringify({ ...f.release, version: '1.2.4' }))
  await assert.rejects(verifyCoreRelease(f.root), { code: 'CRABOT_CORE_INTEGRITY' })
})

test('symlink aliases stay inside the payload and executable permissions are checked', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await fs.symlink('node', path.join(f.root, 'bin/node-alias'))
  await writeCoreRelease(f.root, f.release); await verifyCoreRelease(f.root)
  await fs.chmod(path.join(f.root, 'bin/node'), 0o644)
  await assert.rejects(verifyCoreRelease(f.root), { code: 'CRABOT_CORE_INTEGRITY' })
  await fs.chmod(path.join(f.root, 'bin/node'), 0o755)
  await fs.rm(path.join(f.root, 'bin/node-alias')); await fs.symlink('../../outside', path.join(f.root, 'bin/node-alias'))
  await fs.writeFile(path.join(f.parent, 'outside'), 'outside')
  await assert.rejects(verifyCoreRelease(f.root), { code: 'CRABOT_CORE_INTEGRITY' })
})
