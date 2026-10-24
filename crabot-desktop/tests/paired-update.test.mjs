import test from 'node:test'
import assert from 'node:assert/strict'
import { createPairedUpdateDriver } from '../dist/paired-update.js'

const selection = { schema_version: 1, version: '1.2.2', gui_id: 'aaaaaaaa-1111-2222-3333-444444444444', core_id: 'a'.repeat(64) }
function fixture({ fail, hold } = {}) {
  const calls = [], source = { installRoot: '/private-install', installation_id: 'fixture', selection: { ...selection } }
  const manifest = { platform: 'darwin', arch: 'arm64', selection: { ...selection, version: '1.2.3' } }
  const download = { manifest, artifact: '/private-cache/archive.zip', manifestBytes: Buffer.from('raw'), signatureBytes: Buffer.from('sig'), discard: async () => { calls.push('cache-discard') } }
  const staged = { manifest }, prepared = { ...source, source: selection, selection: manifest.selection }
  async function step(name) { calls.push(name); if (name === fail) throw new Error('fixture failure'); if (name === hold?.name) await hold.promise }
  const driver = createPairedUpdateDriver({ platform: 'darwin', arch: 'arm64', current: () => source,
    downloader: { check: async (current, options) => { assert.deepEqual(current, source.selection); options.progress(100); await step('download'); return download } },
    intake: { stage: async request => { assert.equal(request.artifact, download.artifact); assert.deepEqual(request.context, { platform: 'darwin', arch: 'arm64', purpose: 'update', currentVersion: '1.2.2' }); await step('authenticate-expand'); return staged },
      prepare: async (stage, request) => { assert.equal(stage, staged); assert.equal(request.installRoot, source.installRoot); await step('prepare'); return prepared },
      discard: async stage => { assert.equal(stage, staged); await step('expansion-discard') } },
    preparePlatform: async pair => { assert.equal(pair, prepared); await step('platform') },
    apply: async pair => { assert.equal(pair, prepared); await step('apply'); return { executable: '/target/gui', dataDir: '/private-install/data' } },
    handoff: async target => { assert.deepEqual(target, { executable: '/target/gui', dataDir: '/private-install/data' }); await step('handoff') },
  })
  return { driver, calls, source }
}
test('background check holds a private candidate; only explicit installation expands and enters existing pair lifecycle', async () => {
  const f = fixture(), progress = [], candidate = await f.driver.check(value => progress.push(value))
  assert.deepEqual(candidate, { kind: 'paired', version: '1.2.3' }); assert.deepEqual(f.calls, ['download']); assert.deepEqual(progress, [100])
  await assert.rejects(f.driver.install(JSON.parse(JSON.stringify(candidate))), { code: 'CRABOT_DESKTOP_RELEASE_SIGNATURE' })
  await f.driver.install(candidate)
  assert.deepEqual(f.calls, ['download', 'authenticate-expand', 'prepare', 'expansion-discard', 'platform', 'apply', 'cache-discard', 'handoff'])
})
for (const fail of ['authenticate-expand', 'prepare', 'expansion-discard', 'platform', 'apply']) test(fail + ' failure never proceeds to handoff or later authority', async () => {
  const f = fixture({ fail }), candidate = await f.driver.check(() => {})
  await assert.rejects(f.driver.install(candidate), /fixture failure/)
  assert.equal(f.calls.includes('handoff'), false); assert.equal(f.calls.includes('cache-discard'), false)
  if (['authenticate-expand', 'prepare', 'expansion-discard', 'platform'].includes(fail)) assert.equal(f.calls.includes('apply'), false)
  if (fail === 'prepare') assert.equal(f.calls.at(-1), 'expansion-discard')
})
test('a source version changed after downloading cannot install the prior candidate', async () => {
  const f = fixture(), candidate = await f.driver.check(() => {})
  f.source.selection = { ...selection, core_id: 'b'.repeat(64) }
  await assert.rejects(f.driver.install(candidate), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  assert.deepEqual(f.calls, ['download'])
})
test('parallel installation and checks cannot duplicate the stopped lifecycle', async () => {
  let release; const hold = { name: 'prepare', promise: new Promise(resolve => { release = resolve }) }
  const f = fixture({ hold }), candidate = await f.driver.check(() => {}), pending = f.driver.install(candidate)
  await assert.rejects(f.driver.install(candidate), { code: 'CRABOT_UPDATE_BUSY' })
  await assert.rejects(f.driver.check(() => {}), { code: 'CRABOT_UPDATE_BUSY' })
  release(); await pending; assert.equal(f.calls.filter(value => value === 'apply').length, 1)
})

test('a changed source while unpacking never prepares programs in another installation', async () => {
  let release; const hold = { name: 'authenticate-expand', promise: new Promise(resolve => { release = resolve }) }
  const f = fixture({ hold }), candidate = await f.driver.check(() => {}), pending = f.driver.install(candidate)
  f.source.installRoot = '/another-install'; release()
  await assert.rejects(pending, { code: 'CRABOT_DESKTOP_INSTALLATION' })
  assert.deepEqual(f.calls, ['download', 'authenticate-expand', 'expansion-discard'])
})
test('closing during preparation cancels owned work and never reaches platform authorization or stopping', async () => {
  let release; const hold = { name: 'prepare', promise: new Promise(resolve => { release = resolve }) }
  const f = fixture({ hold }), candidate = await f.driver.check(() => {}), pending = f.driver.install(candidate)
  await new Promise(resolve => setImmediate(resolve)); f.driver.close(); release()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(f.calls.includes('platform'), false); assert.equal(f.calls.includes('apply'), false)
  assert.equal(f.calls.at(-1), 'expansion-discard')
})
