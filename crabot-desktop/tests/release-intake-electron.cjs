// Filesystem regression only. No product main, Core, session or MM is launched.
const { app } = require('electron')
const fs = require('node:fs/promises'), physical = require('original-fs').promises
const path = require('node:path'), { pathToFileURL } = require('node:url'), assert = require('node:assert/strict')
const config = JSON.parse(require('node:fs').readFileSync(process.env.CRABOT_RELEASE_INTAKE_FIXTURE_CONFIG, 'utf8'))
const timer = setTimeout(() => app.exit(125), 10000)
app.setPath('userData', path.join(config.root, 'profile')); app.setPath('sessionData', path.join(config.root, 'profile'))
void app.whenReady().then(async () => {
  const { createDesktopReleaseIntake } = await import(pathToFileURL(path.join(config.root, 'app.asar/dist/release-intake.js')).href)
  const intake = createDesktopReleaseIntake({ pinnedPublicKeys: [config.publicKey], python: config.python, cacheRoot: path.join(config.root, 'cache'),
    verifyPayload: async directory => {
      assert.equal((await physical.stat(path.join(directory, 'gui/resources/app.asar'))).isFile(), true)
      if (config.mode === 'failed-verification') throw Object.assign(new Error('Fixture payload rejection'), { code: 'FIXTURE_PAYLOAD_REJECTED' })
      return { record: { selection: config.selection } }
    }, preparePair: async request => ({ payload: request.payload }) })
  const request = { manifestBytes: await fs.readFile(path.join(config.root, 'manifest.json')), signatureBytes: await fs.readFile(path.join(config.root, 'signatures.json')),
    artifact: path.join(config.root, 'Crabot.zip'), context: { platform: process.platform, arch: process.arch, purpose: 'update', currentVersion: '1.2.2' } }
  if (config.mode === 'failed-verification') await assert.rejects(intake.stage(request), { code: 'FIXTURE_PAYLOAD_REJECTED' })
  else {
    const staged = await intake.stage(request)
    await intake.prepare(staged, { installRoot: config.root })
    await intake.discard(staged)
  }
  assert.deepEqual(await physical.readdir(path.join(config.root, 'cache')), [])
  assert.equal(await fs.readFile(path.join(config.root, 'preserved.txt'), 'utf8'), 'outside the disposable stage')
  console.log('CRABOT_ASAR_INTAKE_CLEANUP ' + JSON.stringify({ mode: config.mode, actual_electron: true, intake_loaded_from_asar: true,
    actual_bundled_python: true, nested_real_asar: true, cleanup_completed: true, payload_verifier_substituted: true, preparation_substituted: true,
    core_executed: false, business_mm_started: false }))
}).then(() => { clearTimeout(timer); app.exit(0) }).catch(error => { clearTimeout(timer); console.error(error.stack); app.exit(1) })
