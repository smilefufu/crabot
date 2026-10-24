// CI-only privileged GUI component actor. It loads the real source ASAR but
// never enables its candidate channel; the private component receives test keys.
const { app, shell } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { Readable } = require('node:stream')
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('An isolated CI user is required')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const profile = path.join(config.source.dataDir, 'desktop-profile')
fs.mkdirSync(profile, { recursive: true, mode: 0o700 })
app.setName('Crabot paired update source fixture')
app.setPath('userData', profile); app.setPath('sessionData', profile)
if (!app.requestSingleInstanceLock()) throw new Error('Fixture profile is already in use')
let controller, driver, handingOff = false, ordinaryExits = 0, requests = 0
const timer = setTimeout(() => app.exit(2), 600_000)
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
  const entries = { home: config.home, platform: process.platform, env: process.env, shell }
  await registerInstallationEntries({ installRoot: config.source.root, installation_id: config.source.record.installation_id,
    selection: config.source.selection, coreRoot: config.source.coreRoot, guiRoot: config.source.guiRoot }, entries)
  controller = new DesktopController({ coreRoot: config.source.coreRoot, dataRoot: config.source.dataDir, appVersion: config.source.selection.version,
    platform: process.platform, packaged: true, verifyBinding,
    loginStartup: { captureForUpdate: async () => 'off', restoreForUpdate: async () => assert.fail('Source may not restore target login') } })
  const state = await controller.start()
  assert.equal(state.phase, 'ready')
  const runtime = await import(pathToFileURL(path.join(config.source.coreRoot, 'scripts/lib/instance-runtime.mjs')).href)
  const source = runtime.inspectInstance(config.source.dataDir)
  assert.equal(source.state, 'running'); assert.ok(source.record.mm)
  write('source-ready', { generation: state.generation, instance_id: state.instance_id, mm: source.record.mm, controller: source.record.controller })
  const deadline = Date.now() + 120_000
  while (await controller.updateActivity() !== 'idle') {
    if (Date.now() >= deadline) throw new Error('Source activity did not become authoritatively idle')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  driver = await createPairedUpdateHost({ coreRoot: config.source.coreRoot, dataRoot: config.source.dataDir, appVersion: config.source.selection.version,
    pinnedPublicKeys: [config.publicKey], verifyBinding, controller, entries,
    transport: () => ({ close: async () => {}, fetch: async (url, options) => {
      requests++; assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual')
      const name = new URL(url).pathname.split('/').at(-1)
      assert.ok([config.manifestName, config.signaturesName, config.artifactName].includes(name))
      const file = path.join(config.publication, name), stat = fs.statSync(file)
      return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { 'Content-Length': String(stat.size) } })
    } }),
    beginExit: () => { handingOff = true; return () => { handingOff = false } },
    app: { once: (...args) => app.once(...args), off: (...args) => app.off(...args), quit: () => app.quit(), relaunch: options => {
      assert.deepEqual(options.args, [])
      const selected = installation.readDesktopSelection(config.source.root)
      assert.equal(selected.executable, options.execPath); assert.equal(selected.selection.version, config.targetVersion)
      write('handoff', { source_generation: state.generation, target: selected.selection, requests, ordinary_exits: ordinaryExits,
        candidate_channel_enabled: false, target_fixture_debugger: true })
      // Only this adapter adds a loopback debugger for read-only renderer/PID
      // observation. Production handoff above supplied an empty argument list.
      app.relaunch({ ...options, args: ['--remote-debugging-port=' + config.debugPort] })
    } } })
  const candidate = await driver.check(() => {})
  assert.equal(candidate.kind, 'paired'); assert.equal(candidate.version, config.targetVersion)
  await driver.install(candidate)
}).catch(error => { write('failure', { code: typeof error.code === 'string' ? error.code : 'PAIRED_UPDATE_FIXTURE_FAILED',
  message: String(error.message).slice(0, 256), phase: controller?.host.snapshot().phase }); console.error(error.stack); clearTimeout(timer); app.exit(1) })
