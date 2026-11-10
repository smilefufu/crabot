import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { legacyProgramCleanup } from '../desktop-legacy-cleanup.mjs'
const gui = '11111111-1111-4111-8111-111111111111', core = 'a'.repeat(64)
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-cleanup-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const record = { schema_version: 1, platform: process.platform, arch: process.arch,
    selection: { schema_version: 1, version: '1.0.0', gui_id: gui, core_id: core }, gui: {} }
  await fs.mkdir(path.join(root, 'app/payloads'), { recursive: true })
  await fs.writeFile(path.join(root, 'app/payloads', gui + '.json'), JSON.stringify(record), { mode: 0o600 })
  for (const relative of ['releases/' + core, 'app/releases/' + gui]) {
    await fs.mkdir(path.join(root, relative), { recursive: true }); await fs.writeFile(path.join(root, relative, 'program'), 'old')
  }
  await fs.mkdir(path.join(root, 'data')); await fs.writeFile(path.join(root, 'data', 'user'), 'irreplaceable')
  let occupied = false, current = true
  const api = { current: () => ({ root, record: { installation_id: current ? 'own' : 'different' }, selection: { version: '2.0.0' }, coreRoot: path.join(root, 'program/core'), guiRoot: path.join(root, 'program/gui') }),
    identity: { isPrivateFile: () => true, isOwnedDirectory: () => true, inspectProgramReferences: async () => ({ complete: true, incomplete: false, processes: occupied ? [{ pid: 42, executable: 'tail.exe' }] : [], unknown_pids: [] }) },
    verifyCore: async directory => { assert.equal(await fs.readFile(path.join(directory, 'program'), 'utf8'), 'old'); return { inventory_sha256: core } }, verifyGui: async () => {} }
  return { root, api, occupy: () => { occupied = true }, change: () => { current = false } }
}
test('previews confirmed old programs, removes only those after confirmation, and preserves unknown/data', async t => {
  const { root, api } = await fixture(t); await fs.mkdir(path.join(root, 'releases', 'unknown'))
  const cleanup = await legacyProgramCleanup(root, api)
  assert.equal(cleanup.preview.length, 2); assert.equal(cleanup.preview[0].bytes, 3)
  assert.equal(await fs.readFile(path.join(root, 'releases', core, 'program'), 'utf8'), 'old')
  const result = await cleanup.removeConfirmed(); assert.equal(result.removed.length, 2)
  assert.equal(result.retained[0].relative, 'releases/unknown')
  assert.equal(await fs.readFile(path.join(root, 'data', 'user'), 'utf8'), 'irreplaceable')
})
test('rechecks tail occupancy after preview and preserves its runtime without termination', async t => {
  const { root, api, occupy } = await fixture(t); const cleanup = await legacyProgramCleanup(root, api); occupy()
  const result = await cleanup.removeConfirmed(); assert.equal(result.removed.length, 0); assert.equal(result.retained.length, 2)
  assert.equal(await fs.readFile(path.join(root, 'releases', core, 'program'), 'utf8'), 'old')
})
test('does not clear an installation whose identity changed while the dialog was open', async t => {
  const { root, api, change } = await fixture(t); const cleanup = await legacyProgramCleanup(root, api); change()
  assert.equal((await cleanup.removeConfirmed()).removed.length, 0)
})
test('protects recovery records and a swapped directory', async t => {
  const { root, api } = await fixture(t); const cleanup = await legacyProgramCleanup(root, api)
  await fs.rename(path.join(root, 'releases', core), path.join(root, 'releases', 'original'))
  await fs.mkdir(path.join(root, 'releases', core)); await fs.writeFile(path.join(root, 'releases', core, 'user'), 'keep')
  assert.equal((await cleanup.removeConfirmed()).removed.includes('releases/' + core), false)
  await fs.writeFile(path.join(root, '.desktop-installing.json'), '{}')
  await assert.rejects(legacyProgramCleanup(root, api), /恢复/)
})
test('does not follow a redirected releases directory', async t => {
  const { root, api } = await fixture(t); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.rm(path.join(root, 'releases'), { recursive: true })
  await fs.symlink(outside, path.join(root, 'releases'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(legacyProgramCleanup(root, api), /路径/)
})
test('an added user file is preserved by the real Core inventory verifier', async t => {
  const { root, api } = await fixture(t)
  const { writeCoreRelease, verifyCoreRelease } = await import('../core-release.mjs')
  const directory = path.join(root, 'releases', core)
  for (const file of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(directory, file), JSON.stringify({ version: '1.0.0' }))
  await writeCoreRelease(directory, { schema_version: 1, version: '1.0.0', commit: 'b'.repeat(40), source_dirty: false, platform: process.platform, arch: process.arch })
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'core-release.json'), 'utf8'))
  const actual = metadata.inventory_sha256
  await fs.rename(directory, path.join(root, 'releases', actual))
  const file = path.join(root, 'app/payloads', gui + '.json'), proof = JSON.parse(await fs.readFile(file, 'utf8'))
  proof.selection.core_id = actual; await fs.writeFile(file, JSON.stringify(proof))
  api.verifyCore = directory => verifyCoreRelease(directory)
  const cleanup = await legacyProgramCleanup(root, api)
  assert.ok(cleanup.preview.some(item => item.relative === 'releases/' + actual))
  await fs.writeFile(path.join(root, 'releases', actual, 'user.txt'), 'preserve')
  const result = await cleanup.removeConfirmed()
  assert.equal(result.removed.includes('releases/' + actual), false)
  assert.equal(await fs.readFile(path.join(root, 'releases', actual, 'user.txt'), 'utf8'), 'preserve')
})
test('the real native query protects a child holding an old program file', async t => {
  let identity
  try { identity = (await import('../process-identity.cjs')).default }
  catch (error) { if (error.code === 'MODULE_NOT_FOUND') { t.skip('同平台 native helper 尚未构建'); return } throw error }
  const { root, api } = await fixture(t), cleanup = await legacyProgramCleanup(root, api)
  const { spawn } = await import('node:child_process')
  const file = path.join(root, 'releases', core, 'program')
  const child = spawn(process.execPath, ['-e', "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');console.log('ready');setInterval(()=>{},1000)", file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  t.after(() => child.kill())
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('fixture exited'))) })
  const observation = await identity.inspectProgramReferences({ roots: [path.dirname(file)], files: [file] })
  assert.ok(observation.processes.some(item => item.pid === child.pid))
  api.identity.inspectProgramReferences = options => identity.inspectProgramReferences(options)
  const result = await cleanup.removeConfirmed()
  assert.equal(result.removed.includes('releases/' + core), false)
  assert.equal(child.exitCode, null)
  assert.equal(await fs.readFile(file, 'utf8'), 'old')
})
