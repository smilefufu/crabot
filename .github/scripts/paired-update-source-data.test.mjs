import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import management from '../../scripts/lib/desktop-management.cjs'
const fileName = 'update-fixture-preserved.txt'
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-source-update-data-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return management.ensurePrivateDataRoot(path.join(root, 'data'))
}
test('the observed source-fixture order is refused by actual fresh desktop management initialization', async t => {
  const data = await fixture(t); await fs.writeFile(path.join(data, fileName), 'sentinel too early')
  assert.throws(() => management.initializeDesktopManagement(data), { code: 'CRABOT_DESKTOP_TAKEOVER_REQUIRED' })
  assert.equal(await fs.readFile(path.join(data, fileName), 'utf8'), 'sentinel too early')
})
test('source fixture writes its preservation sentinel only after real fresh management and ready acknowledgement', async t => {
  const data = await fixture(t), { startPairedUpdateSource } = await import('../../crabot-desktop/tests/fixtures/paired-update-source-data.cjs')
  let release
  const gate = new Promise(resolve => { release = resolve }), state = { phase: 'ready', generation: 'same-original-generation' }
  const pending = startPairedUpdateSource({ start: async () => { management.initializeDesktopManagement(data); await gate; return state } }, data)
  await assert.rejects(fs.lstat(path.join(data, fileName)), { code: 'ENOENT' })
  assert.equal(management.readDesktopManagement(data).install_kind, 'desktop')
  release(); assert.equal(await pending, state)
  assert.equal(await fs.readFile(path.join(data, fileName), 'utf8'), 'preserved across the actual pair handoff\n')
})
for (const phase of ['migration_required', 'error', 'starting']) test('source fixture does not write or override data before ready: ' + phase, async t => {
  const data = await fixture(t), { startPairedUpdateSource } = await import('../../crabot-desktop/tests/fixtures/paired-update-source-data.cjs')
  await fs.writeFile(path.join(data, 'existing-user-file'), 'keep')
  await assert.rejects(startPairedUpdateSource({ start: async () => ({ phase }) }, data), { code: 'ERR_ASSERTION' })
  assert.deepEqual(await fs.readdir(data), ['existing-user-file'])
})
test('source preservation setup refuses an existing sentinel instead of overwriting it', async t => {
  const data = await fixture(t), { startPairedUpdateSource } = await import('../../crabot-desktop/tests/fixtures/paired-update-source-data.cjs')
  management.initializeDesktopManagement(data); await fs.writeFile(path.join(data, fileName), 'original fixture content')
  await assert.rejects(startPairedUpdateSource({ start: async () => ({ phase: 'ready' }) }, data), { code: 'EEXIST' })
  assert.equal(await fs.readFile(path.join(data, fileName), 'utf8'), 'original fixture content')
})
