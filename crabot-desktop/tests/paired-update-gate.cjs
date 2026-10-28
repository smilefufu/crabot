// Finite actual Electron updater gate; no Crabot Core, network or OS entries.
const { app } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const root = process.argv[2], resources = path.join(root, 'resources')
app.setName('Crabot Paired Update Gate Fixture')
app.setPath('userData', path.join(root, 'profile')); app.setPath('sessionData', path.join(root, 'profile'))
const timer = setTimeout(() => app.exit(2), 25000)
void app.whenReady().then(async () => {
  const { createUpdateDriver } = await import(pathToFileURL(path.resolve(__dirname, '../dist/update-driver.js')).href)
  const { createPairedUpdateHost } = await import(pathToFileURL(path.resolve(__dirname, '../dist/paired-update-host.js')).href)
  fs.mkdirSync(resources); fs.writeFileSync(path.join(resources, 'desktop-release.json'), '{}')
  let callbacks = 0
  const forbidden = () => assert.fail('No legacy updater, network, disk/runtime access or exit capability')
  const base = { resources, cacheRoot: path.join(root, 'cache'), packaged: true, beginExit: forbidden }
  assert.equal(await createUpdateDriver(base), null)
  assert.equal(await createUpdateDriver({ ...base, paired: () => {
    callbacks++
    return createPairedUpdateHost(new Proxy({ pinnedPublicKeys: [] }, { get: (value, name) => name === 'pinnedPublicKeys' ? value.pinnedPublicKeys : forbidden() }))
  } }), null)
  assert.equal(callbacks, 1)
  await assert.rejects(createUpdateDriver({ ...base, paired: async () => { throw new Error('Trust unavailable') } }), /Trust unavailable/)
  fs.writeFileSync(path.join(resources, 'candidate-only.json'), '{}')
  assert.equal(await createUpdateDriver({ ...base, paired: forbidden }), null)
  assert.equal(await createUpdateDriver({ ...base, packaged: false, paired: forbidden }), null)
  assert.equal(fs.existsSync(path.join(root, 'cache')), false)
  assert.equal(fs.existsSync(path.join(resources, 'app-update.yml')), false)
  console.log('CRABOT_PAIRED_UPDATE_GATE ' + JSON.stringify({ complete_root_no_legacy: true, empty_keys_no_capabilities: true,
    candidate_overrides_channel: true, source_mode_disabled: true, failed_pair_no_legacy_fallback: true, business_mm_started: false }))
}).then(() => { clearTimeout(timer); app.exit(0) }, error => { console.error(error.stack); clearTimeout(timer); app.exit(1) })
