import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { writeCoreRelease, verifyCoreRelease } from '../../scripts/lib/core-release.mjs'
import { preparePairedUpdateCore } from './prepare-paired-update-core.mjs'
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'paired-target-core-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'), target = path.join(root, 'target'); await fs.mkdir(source)
  for (const file of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(source, file), JSON.stringify({ version: '1.2.3', retained: true }) + '\n')
  await fs.writeFile(path.join(source, 'program.mjs'), 'throw new Error("Fixture producer must not execute Core code")\n')
  await writeCoreRelease(source, { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  return { source, target }
}
test('actual paired target producer replaces only copied old manifests and seals a complete higher fixture', async t => {
  const f = await fixture(t), original = await verifyCoreRelease(f.source), before = await fs.readFile(path.join(f.source, 'core-files.json'))
  const target = await preparePairedUpdateCore(f.source, f.target, '1.2.4-desktop-fixture.1')
  assert.equal(target.version, '1.2.4-desktop-fixture.1'); assert.notEqual(target.inventory_sha256, original.inventory_sha256)
  assert.deepEqual(await verifyCoreRelease(f.source), original); assert.deepEqual(await fs.readFile(path.join(f.source, 'core-files.json')), before)
  assert.deepEqual(await fs.readFile(path.join(f.target, 'program.mjs')), await fs.readFile(path.join(f.source, 'program.mjs')))
  assert.equal(JSON.parse(await fs.readFile(path.join(f.target, 'product-runtime.json'), 'utf8')).retained, true)
})
test('paired target producer refuses a nonempty destination or overlapping source without altering it', async t => {
  const f = await fixture(t); await fs.mkdir(f.target); await fs.writeFile(path.join(f.target, 'keep'), 'user bytes')
  await assert.rejects(preparePairedUpdateCore(f.source, f.target, '1.2.4-desktop-fixture.1'), { code: 'EEXIST' })
  assert.equal(await fs.readFile(path.join(f.target, 'keep'), 'utf8'), 'user bytes')
  await assert.rejects(preparePairedUpdateCore(f.source, path.join(f.source, 'nested'), '1.2.4-desktop-fixture.1'), /Invalid finite/)
  await verifyCoreRelease(f.source)
})
test('paired target producer refuses corrupt source before creating its destination', async t => {
  const f = await fixture(t); await fs.appendFile(path.join(f.source, 'program.mjs'), '// changed')
  await assert.rejects(preparePairedUpdateCore(f.source, f.target, '1.2.4-desktop-fixture.1'), { code: 'CRABOT_CORE_INTEGRITY' })
  await assert.rejects(fs.lstat(f.target), { code: 'ENOENT' })
})
