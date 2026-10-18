import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { inspectLegacyPythonEnvironment } from '../legacy-python.mjs'

const root = realpathSync(new URL('../../../', import.meta.url))
const sum = bytes => createHash('sha256').update(bytes).digest('base64url')
async function fixture(t) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot 旧 Python ')))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const venv = path.join(dataDir, 'agent-venv')
  const site = path.join(venv, process.platform === 'win32' ? 'Lib/site-packages' : 'lib/python3.11/site-packages')
  const info = path.join(site, 'sample-1.0.dist-info')
  await fs.mkdir(info, { recursive: true })
  const cfg = 'version_info = 3.11.14\n'
  await fs.writeFile(path.join(venv, 'pyvenv.cfg'), cfg)
  const metadata = 'Name: sample\nVersion: 1.0\n'
  await fs.writeFile(path.join(info, 'METADATA'), metadata)
  const code = 'raise RuntimeError("OLD_CODE_MUST_NOT_EXECUTE")\n'
  await fs.writeFile(path.join(site, 'sample.py'), code)
  await fs.writeFile(path.join(info, 'RECORD'), [
    `sample.py,sha256=${sum(code)},${Buffer.byteLength(code)}`,
    `sample-1.0.dist-info/METADATA,sha256=${sum(metadata)},${Buffer.byteLength(metadata)}`,
    'sample-1.0.dist-info/RECORD,,',
  ].join('\n') + '\n')
  return { dataDir, venv, site, info, cfg, code }
}
const inspect = f => inspectLegacyPythonEnvironment({ root, dataDir: f.dataDir })

test('bundled Python observes old records without importing packages or writing bytecode', async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.info, 'RECORD'))
  const result = await inspect(f), again = await inspect(f)
  assert.equal(result.status, 'observed'); assert.equal(result.observation_only, true)
  assert.equal(result.python_version, '3.11.14'); assert.equal(result.same_python_minor, false)
  assert.equal(result.fingerprint, again.fingerprint)
  assert.deepEqual(result.packages, [{ name: 'sample', version: '1.0', has_file_record: true, has_source_record: false,
    modified_files: 0, missing_files: 0, unverified_files: 0, references: 0 }])
  assert.equal(result.unrecorded_site_files, 0); assert.equal(result.special_site_files, 0)
  assert.equal(await fs.readFile(path.join(f.venv, 'pyvenv.cfg'), 'utf8'), f.cfg)
  assert.equal(await fs.readFile(path.join(f.site, 'sample.py'), 'utf8'), f.code)
  assert.deepEqual(await fs.readFile(path.join(f.info, 'RECORD')), before)
  assert.deepEqual((await fs.readdir(f.site)).sort(), ['sample-1.0.dist-info', 'sample.py'])
})

test('changed, missing, unrecorded and source records remain distinct and credentials stay private', async t => {
  const f = await fixture(t)
  const before = await inspect(f)
  await fs.writeFile(path.join(f.site, 'sample.py'), 'changed')
  await fs.appendFile(path.join(f.info, 'RECORD'), 'gone.py,sha256=absent,7\n')
  await fs.writeFile(path.join(f.site, 'unrecorded.py'), 'user extension')
  const secret = 'credential-never-returned'
  await fs.writeFile(path.join(f.info, 'direct_url.json'), JSON.stringify({ url: `https://user:${secret}@example.invalid/private` }))
  const result = await inspect(f), item = result.packages[0]
  assert.equal(item.modified_files, 1); assert.equal(item.missing_files, 1); assert.equal(item.has_source_record, true)
  assert.equal(result.unrecorded_site_files, 2)
  const extension = result.unrecorded_files.find(file => file.path === 'unrecorded.py')
  assert.deepEqual(extension, { path: 'unrecorded.py', size: 14, sha256: createHash('sha256').update('user extension').digest('hex') })
  assert.equal(result.unrecorded_files.some(file => file.path.includes(f.dataDir)), false)
  assert.notEqual(result.fingerprint, before.fingerprint)
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(JSON.stringify(result).includes('example.invalid'), false)
})

test('missing environment is observationally absent, and a dangling environment link is rejected', async t => {
  const f = await fixture(t)
  await fs.rm(f.venv, { recursive: true })
  assert.equal((await inspect(f)).status, 'absent')
  await fs.symlink(path.join(f.dataDir, 'missing'), f.venv, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(inspect(f), { code: 'CRABOT_LEGACY_PYTHON_INSPECTION' })
})

test('package references are reported without reading their targets or hanging on special files', async t => {
  const f = await fixture(t)
  const external = path.join(f.dataDir, 'outside'); await fs.mkdir(external)
  await fs.writeFile(path.join(external, 'keep.py'), 'external-content')
  await fs.symlink(external, path.join(f.site, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.appendFile(path.join(f.info, 'RECORD'), 'external/keep.py,sha256=not-read,16\n')
  if (process.platform !== 'win32') execFileSync('mkfifo', [path.join(f.site, 'pipe')])
  const result = await inspect(f)
  assert.equal(result.site_references, 1); assert.equal(result.packages[0].references, 1)
  assert.equal(result.special_site_files, process.platform === 'win32' ? 0 : 1)
  await fs.writeFile(path.join(external, 'keep.py'), 'changed-outside-environment')
  assert.equal((await inspect(f)).fingerprint, result.fingerprint, 'External directory contents must not be traversed or hashed')
  assert.equal(await fs.readFile(path.join(external, 'keep.py'), 'utf8'), 'changed-outside-environment')
})
