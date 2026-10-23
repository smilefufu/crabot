import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readUbuntuBootstrap } from './package-ubuntu-installer.mjs'
const commit = 'a'.repeat(40), names = ['crabot-installer', 'crabot-sandbox-helper']
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-native-package-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bytes = Buffer.alloc(64); Buffer.from([127, 69, 76, 70, 2, 1]).copy(bytes); bytes[18] = 62
  const record = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const manifest = { schema_version: 1, platform: 'linux', arch: 'x64', build_os: 'ubuntu-24.04', commit, source_dirty: false,
    files: Object.fromEntries(names.map(name => [name, record])) }
  for (const name of names) await fs.writeFile(path.join(root, name), bytes)
  const write = () => fs.writeFile(path.join(root, 'native-bootstrap.json'), JSON.stringify(manifest))
  await write(); return { root, manifest, bytes, write }
}
test('read exact same-source Ubuntu24 native bytes without executing a binary', async t => {
  const f = await fixture(t), result = await readUbuntuBootstrap(f.root, commit)
  assert.deepEqual(Object.keys(result.binaries), names)
  for (const bytes of Object.values(result.binaries)) assert.deepEqual(bytes, f.bytes)
})
for (const [key, value] of [['commit', 'b'.repeat(40)], ['source_dirty', true], ['build_os', 'ubuntu-26.04'], ['platform', 'darwin'], ['arch', 'arm64']]) test('reject mismatched native source/baseline: ' + key, async t => {
  const f = await fixture(t); f.manifest[key] = value; await f.write(); await assert.rejects(readUbuntuBootstrap(f.root, commit))
})
for (const mode of ['changed', 'symlink', 'hardlink', 'extra entry']) test('reject unverified native input: ' + mode, async t => {
  const f = await fixture(t), file = path.join(f.root, names[0])
  if (mode === 'changed') await fs.appendFile(file, 'changed')
  if (mode === 'symlink') { await fs.unlink(file); await fs.symlink(names[1], file) }
  if (mode === 'hardlink') await fs.link(file, path.join(f.root, 'other'))
  if (mode === 'extra entry') { f.manifest.files['arbitrary-script'] = f.manifest.files[names[0]]; await f.write() }
  await assert.rejects(readUbuntuBootstrap(f.root, commit))
})
