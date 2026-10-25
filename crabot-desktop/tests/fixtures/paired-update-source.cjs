// CI-only packaged GUI component actor with unchanged production modules. It
// uses the real selected executable and normal peer policy, never a debug flag.
const { app, shell } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { Readable } = require('node:stream')
const { sourceLifetimeMs } = require('./paired-update-limits.cjs')
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('An isolated CI user is required')
const config = JSON.parse(fs.readFileSync(process.env.CRABOT_PAIRED_UPDATE_FIXTURE_CONFIG, 'utf8'))
const profile = path.join(config.source.dataDir, 'desktop-profile')
fs.mkdirSync(profile, { recursive: true, mode: 0o700 })
app.setName('Crabot paired update source fixture')
app.setPath('userData', profile); app.setPath('sessionData', profile)
if (!app.requestSingleInstanceLock()) throw new Error('Fixture profile is already in use')
let controller, driver, handingOff = false, ordinaryExits = 0, requests = 0
const timer = setTimeout(() => app.exit(2), sourceLifetimeMs)
const write = (name, value) => {
  const file = path.join(config.control, name + '.json'), temporary = file + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600, flush: true }); fs.renameSync(temporary, file)
}
app.on('before-quit', event => { if (!handingOff) { ordinaryExits++; event.preventDefault(); app.exit(3) } })
app.on('will-quit', () => { driver?.close(); controller?.close(); clearTimeout(timer) })
void app.whenReady().then(async () => {
  const archive = path.join(config.source.resources, 'app.asar'), load = file => import(pathToFileURL(path.join(archive, 'dist', file)).href)
  const { DesktopController } = await load('controller.js')
  const { createPairedUpdateHost } = await load('paired-update-host.js')
  const { registerInstallationEntries } = await load('installation-entries.js')
  const installation = require(path.join(archive, 'dist/bootstrap/scripts/lib/desktop-installation.cjs'))
  const pin = fs.readFileSync(path.join(archive, 'dist/desktop-release.json'), 'utf8')
  const verifyBinding = () => { installation.locatePinnedDesktopGui(config.source.resources, pin) }
  const identity = require(path.join(archive, 'dist/bootstrap/scripts/lib/process-identity.cjs'))
  const entry = require(path.join(config.source.coreRoot, 'scripts/lib/desktop-entry.cjs'))
  assert.equal(entry.verifyDesktopEntry(identity.inspectProcess(process.pid), entry.loadDesktopEntry(config.source.coreRoot)), true)
  const entries = { home: config.home, platform: process.platform, env: process.env, shell }
  await registerInstallationEntries({ installRoot: config.source.root, installation_id: config.source.record.installation_id,
    selection: config.source.selection, coreRoot: config.source.coreRoot, guiRoot: config.source.guiRoot }, entries)
  controller = new DesktopController({ coreRoot: config.source.coreRoot, dataRoot: config.source.dataDir, appVersion: config.source.selection.version,
    platform: process.platform, packaged: true, verifyBinding,
    loginStartup: { captureForUpdate: async () => 'off', restoreForUpdate: async () => assert.fail('Source may not restore target login') } })
  controller.host.subscribe(state => write('source-host-state', { phase: state.phase,
    ...(typeof state.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(state.code) ? { code: state.code } : {}), at_ms: Math.round(performance.now()) }))
  const { startPairedUpdateSource } = require('./paired-update-source-data.cjs')
  const state = await startPairedUpdateSource(controller, config.source.dataDir)
  const { configurePairedSourceModel } = require('./paired-update-source-model.cjs')
  const model = await configurePairedSourceModel(controller.host, config.modelEndpoint)
  const runtime = await import(pathToFileURL(path.join(config.source.coreRoot, 'scripts/lib/instance-runtime.mjs')).href)
  const source = runtime.inspectInstance(config.source.dataDir)
  assert.equal(source.state, 'running'); assert.ok(source.record.mm)
  write('source-ready', { model_configured_via_http: model.configured_via_http, generation: state.generation, instance_id: state.instance_id, mm: source.record.mm, controller: source.record.controller })
  const deadline = Date.now() + 120_000
  while (await controller.updateActivity() !== 'idle') {
    if (Date.now() >= deadline) {
      const { captureSourceActivityEvidence } = require('./paired-update-source-activity.cjs')
      const evidence = await captureSourceActivityEvidence(controller.host)
      try {
        const actual = runtime.inspectInstance(config.source.dataDir)
        Object.assign(evidence, { runtime_state: actual.state, source_generation_matches: actual.record?.generation === state.generation,
          selected_core_matches: Boolean(actual.record && fs.realpathSync(actual.record.install_root) === fs.realpathSync(config.source.coreRoot)),
          mm_alive: Boolean(actual.record?.mm && identity.sameProcess(actual.record.mm, identity.inspectProcess(actual.record.mm.pid))) })
      } catch { evidence.runtime_state = 'unknown' }
      write('source-activity', evidence)
      throw new Error('Source activity did not become authoritatively idle')
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const maintenance = await import(pathToFileURL(path.join(config.source.coreRoot, 'scripts/lib/version-maintenance.mjs')).href)
  const applyPreparedPair = controller.applyPreparedPair.bind(controller)
  driver = await createPairedUpdateHost({ coreRoot: config.source.coreRoot, dataRoot: config.source.dataDir, appVersion: config.source.selection.version,
    pinnedPublicKeys: [config.publicKey], verifyBinding, entries,
    controller: { applyPreparedPair: async (...args) => {
      write('source-stage', { phase: 'applying-prepared-pair', at_ms: Math.round(performance.now()) })
      const target = await applyPreparedPair(...args)
      write('source-stage', { phase: 'pair-committed', at_ms: Math.round(performance.now()) })
      return target
    } },
    transport: () => ({ close: async () => {}, fetch: async (url, options) => {
      requests++; assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual')
      const name = new URL(url).pathname.split('/').at(-1)
      assert.ok([config.manifestName, config.signaturesName, config.artifactName].includes(name))
      const file = path.join(config.publication, name), stat = fs.statSync(file)
      return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { 'Content-Length': String(stat.size) } })
    } }),
    beginExit: () => { write('source-stage', { phase: 'exiting-source', at_ms: Math.round(performance.now()) }); handingOff = true; return () => { handingOff = false } },
    app: { once: (...args) => app.once(...args), off: (...args) => app.off(...args), quit: () => app.quit(), relaunch: options => {
      assert.deepEqual(options.args, [])
      const selected = installation.readDesktopSelection(config.source.root)
      assert.equal(selected.executable, options.execPath); assert.equal(selected.selection.version, config.targetVersion)
      const fence = maintenance.readVersionMaintenance(config.source.dataDir)
      assert.equal(fence.phase, 'verifying'); assert.equal(fence.target_core.root, selected.coreRoot)
      write('handoff', { source_generation: state.generation, target: selected.selection, requests, ordinary_exits: ordinaryExits, maintenance_id: fence.id,
        candidate_channel_enabled: false, production_peer_policy_verified: true })
      app.relaunch(options)
    } } })
  write('source-stage', { phase: 'checking-release', at_ms: Math.round(performance.now()) })
  const candidate = await driver.check(() => {})
  assert.equal(candidate.kind, 'paired'); assert.equal(candidate.version, config.targetVersion)
  write('source-stage', { phase: 'preparing-release', at_ms: Math.round(performance.now()) })
  await driver.install(candidate)
}).catch(error => { write('failure', { code: typeof error.code === 'string' ? error.code : 'PAIRED_UPDATE_FIXTURE_FAILED',
  message: String(error.message).slice(0, 256), phase: controller?.host.snapshot().phase }); console.error(error.stack); clearTimeout(timer); app.exit(1) })
