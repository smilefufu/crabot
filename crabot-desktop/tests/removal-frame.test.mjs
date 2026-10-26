import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { readInstanceRuntime, inspectInstance } from '../../scripts/lib/instance-runtime.mjs'
import { writeCoreRelease, verifyCoreRelease } from '../../scripts/lib/core-release.mjs'
import { sealDesktopPayload, prepareDesktopInstallation, commitDesktopInstallation } from '../../scripts/lib/desktop-payload.mjs'
import identity from '../../scripts/lib/process-identity.cjs'
import { probeKnownProcessExit } from '../../scripts/lib/known-process-exit.cjs'
import { prepareDesktopRemovalGui } from '../../scripts/lib/desktop-removal-host.mjs'
const supported = ['darwin', 'win32'].includes(process.platform), repository = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
let root, payload
before(async () => {
  if (!supported) return
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-protected-removal-frame-')))
  payload = path.join(root, 'payload'); const core = path.join(payload, 'core'), appDir = path.join(root, 'app')
  await fs.mkdir(path.join(core, 'bin'), { recursive: true })
  await fs.copyFile(path.join(repository, 'crabot-native/build/Release', process.platform === 'win32' ? 'crabot.exe' : 'crabot'), path.join(core, 'bin', process.platform === 'win32' ? 'crabot.exe' : 'crabot'))
  for (const name of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(core, name), JSON.stringify({ version: '1.2.3', ...(name === 'package.json' ? { type: 'module' } : {}) }))
  await fs.mkdir(path.join(core, 'crabot-core/dist'), { recursive: true })
  await fs.copyFile(new URL('../../scripts/lib/__tests__/fixtures/core.mjs', import.meta.url), path.join(core, 'crabot-core/dist/main.js'))
  await fs.writeFile(path.join(core, 'program.mjs'), 'throw new Error("Never execute this minimal fixture Core")')
  await writeCoreRelease(core, { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  await fs.writeFile(path.join(core, 'desktop-host.json'), JSON.stringify({ schema_version: 2, platform: process.platform, arch: process.arch }))
  const release = await verifyCoreRelease(core), selection = { schema_version: 1, version: '1.2.3', gui_id: randomUUID(), core_id: release.inventory_sha256 }
  await promisify(execFile)(process.execPath, ['build-preload.mjs'], { cwd: path.join(repository, 'crabot-desktop'), timeout: 30000, maxBuffer: 65536 })
  await fs.mkdir(path.join(appDir, 'dist'), { recursive: true })
  await fs.cp(path.join(repository, 'crabot-desktop/dist/bootstrap'), path.join(appDir, 'dist/bootstrap'), { recursive: true })
  for (const name of ['installation-removal.js', 'installation-entries.js', 'login-startup.js', 'removal-operation.js']) await fs.copyFile(path.join(repository, 'crabot-desktop/dist', name), path.join(appDir, 'dist', name))
  await fs.copyFile(new URL('fixtures/removal-frame-actor.cjs', import.meta.url), path.join(appDir, 'dist/main.cjs'))
  await fs.copyFile(path.join(repository, 'crabot-desktop/dist/removal-preload.cjs'), path.join(appDir, 'dist/removal-preload.cjs'))
  await require('esbuild').build({ entryPoints: [path.join(repository, 'crabot-desktop/src/removal-source.ts')], outfile: path.join(appDir, 'dist/source-entry.js'), bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['electron', 'original-fs'], logLevel: 'silent' })
  await require('esbuild').build({ entryPoints: [path.join(repository, 'crabot-desktop/src/main.ts')], outfile: path.join(appDir, 'dist/full-main.js'), bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['electron', 'original-fs'], banner: { js: "import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);" }, logLevel: 'silent' })
  await fs.writeFile(path.join(appDir, 'dist/desktop-release.json'), JSON.stringify(selection) + '\n')
  await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'crabot-removal-frame-fixture', type: 'module', version: '1.2.3', main: 'dist/main.cjs', dependencies: { '@electron/asar': '3.4.1' } }))
  const parser = path.join(appDir, 'node_modules/@electron/asar'); await fs.mkdir(parser, { recursive: true })
  await require('esbuild').build({ entryPoints: [require.resolve('@electron/asar')], outfile: path.join(parser, 'index.cjs'), bundle: true,
    platform: 'node', format: 'cjs', external: ['original-fs'], logLevel: 'silent' })
  await fs.writeFile(path.join(parser, 'package.json'), '{"name":"@electron/asar","version":"3.4.1","main":"index.cjs"}')
  const { build, Platform, Arch } = require('electron-builder')
  const builder = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib/package.json'))
  let gui
  await build({ projectDir: root, publish: 'never', targets: Platform.current().createTarget('dir', Arch[process.arch]), config: {
    appId: 'com.crabot.removal-frame-fixture', productName: 'Crabot', electronVersion: '44.9.0', directories: { app: appDir, output: path.join(root, 'unpacked') },
    electronDist: path.join(path.dirname(require.resolve('electron/package.json')), 'dist'), files: ['dist/**/*', 'package.json'], asar: true,
    asarUnpack: ['dist/bootstrap/**/*.node'], npmRebuild: false, publish: null,
    electronFuses: { runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true, grantFileProtocolExtraPrivileges: false },
    mac: { minimumSystemVersion: '14.0.0', identity: '-', hardenedRuntime: false, notarize: false }, win: { executableName: 'Crabot' },
    afterPack: async context => {
      gui = context.appOutDir
      const resources = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
      await fs.writeFile(path.join(resources, 'desktop-release.json'), JSON.stringify(selection) + '\n')
    },
  } })
  const executable = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : 'Crabot.exe')
  const { getCurrentFuseWire, FuseV1Options } = builder('@electron/fuses'), fuses = await getCurrentFuseWire(executable)
  for (const key of [FuseV1Options.RunAsNode, FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseV1Options.EnableNodeCliInspectArguments]) assert.equal(fuses[key], 48)
  for (const key of [FuseV1Options.OnlyLoadAppFromAsar, FuseV1Options.EnableEmbeddedAsarIntegrityValidation]) assert.equal(fuses[key], 49)
  await fs.cp(gui, path.join(payload, 'gui'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  await sealDesktopPayload(payload)
}, 120000)
after(async () => { if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) })
for (const scenario of ['valid', 'node-parent', 'unexpected-source-args', 'changed-copy', 'other-installation', 'publish-close', 'publish-cancel', 'publish-module', 'publish-damaged', 'publish-lost-reply', 'publish-replaced-record', 'publish-live', 'publish-cancel-lost', 'publish-stop', 'publish-stop-wrong-root', 'publish-stop-lost', 'publish-stop-retry', 'publish-stop-lost-retry', 'publish-inherited-cwd', 'publish-source-verifier', 'publish-source-exit', 'publish-source-retry', 'publish-source-late-exit', 'publish-source-ignore', 'publish-source-disconnect', 'resume-valid', 'resume-core-missing', 'resume-wrong-operation', 'resume-changed-copy', 'resume-source-changed', 'resume-lease-cancel', 'resume-lease-stopping', 'resume-lease-removing', 'resume-lease-completed', 'resume-lease-core-missing', 'resume-lease-wrong-operation', 'resume-lease-busy', 'resume-lease-source-exit', 'publish-source-remove', 'publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main', 'publish-source-remove-operation', 'publish-source-remove-cancel-retry', 'publish-source-remove-mac-login', 'publish-source-remove-complete', 'publish-source-remove-windows-uninstall', 'publish-source-remove-retry', 'resume-lease-source-remove', 'publish-source-remove-retry-delayed']) test('actual protected initial removal frame: ' + scenario, { skip: !supported || ['publish-source-remove-mac-login', 'publish-source-remove-operation', 'publish-source-remove-main'].includes(scenario) && process.platform !== 'darwin' || scenario === 'publish-source-remove-windows-uninstall' && process.platform !== 'win32', timeout: scenario.includes('source-remove') ? 180000 : 60000 }, async t => {
  const mode = scenario.endsWith('-delayed') ? scenario.slice(0, -8) : scenario
  const area = await fs.mkdtemp(path.join(root, 'case-'))
  const cancelled = ['publish-cancel', 'publish-cancel-lost', 'publish-stop', 'publish-stop-retry', 'publish-stop-lost-retry', 'publish-source-exit', 'publish-source-retry', 'publish-source-late-exit', 'publish-source-verifier', 'resume-lease-cancel'].includes(mode)
  if (mode === 'publish-source-remove-complete') {
    const api = await import('../../scripts/lib/desktop-removal-job.mjs')
    assert.equal(typeof api.finishDesktopRemoval, 'function', 'Removal finalization is missing')
  }
  if (mode === 'publish-source-remove-mac-login') {
    const api = await import('../dist/installation-removal.js')
    assert.equal(typeof api.removeMacLoginStartupEntry, 'function', 'Mac same-job login cleanup is missing')
  }
  const sourceExitMode = ['publish-source-exit', 'publish-source-retry', 'publish-source-late-exit', 'resume-lease-source-exit', 'publish-source-remove', 'publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main', 'publish-source-remove-operation', 'publish-source-remove-cancel-retry', 'publish-source-remove-mac-login', 'publish-source-remove-complete', 'publish-source-remove-windows-uninstall', 'publish-source-remove-retry', 'resume-lease-source-remove'].includes(mode)
  const existingPhase = ({ 'resume-lease-stopping': 'stopping', 'resume-lease-removing': 'removing', 'resume-lease-completed': 'completed', 'resume-lease-source-exit': 'removing', 'resume-lease-source-remove': 'removing' })[mode] || 'preparing'
  const own = await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'installation') }))
  let finite, finiteExited, finiteOutput = ''
  if (mode.startsWith('publish-stop')) {
    const reserve = createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening')
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve))
    finite = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/lib/__tests__/fixtures/managed-core.mjs', import.meta.url))], {
      env: { ...process.env, TEST_CORE_ROOT: own.coreRoot, TEST_DATA_DIR: own.dataDir, TEST_PORT: String(port), TEST_MARKER: path.join(area, 'stopped'), TEST_READY: path.join(area, 'ready') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    finiteExited = once(finite, 'exit'); const owner = identity.inspectProcess(finite.pid)
    for (const stream of [finite.stdout, finite.stderr]) stream.on('data', bytes => { finiteOutput = (finiteOutput + bytes.toString()).slice(-4000) })
    t.after(async () => {
      const record = readInstanceRuntime(own.dataDir)
      for (const process of [record?.mm, owner]) if (process && identity.sameProcess(process, identity.inspectProcess(process.pid))) globalThis.process.kill(process.pid, 'SIGKILL')
      await finiteExited
    })
    const deadline = Date.now() + 10000
    while (!(await fs.lstat(path.join(area, 'ready')).catch(() => null)) || !readInstanceRuntime(own.dataDir)?.mm) {
      if (finite.exitCode !== null || finite.signalCode !== null || Date.now() > deadline) throw new Error('Finite fixture failed: ' + finiteOutput)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  if (mode === 'publish-stop-wrong-root') {
    const record = readInstanceRuntime(own.dataDir)
    await fs.writeFile(path.join(own.dataDir, 'instance-runtime.json'), JSON.stringify({ ...record, install_root: area }) + '\n')
  }
  const operationId = randomUUID(), cfg = { root: own.root, operationId, mode, resultFile: path.join(area, 'host-result.json'), stageFile: path.join(area, 'host-stage.json'), removalPinDelayMs: scenario.endsWith('-delayed') ? 3000 : 0 }
  if (mode === 'other-installation') cfg.inspectRoot = (await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'other') }))).root
  await fs.writeFile(path.join(own.dataDir, 'preserved-user-file'), 'user bytes')
  const config = path.join(area, 'control.json'); await fs.writeFile(config, JSON.stringify(cfg))
  const env = { ...process.env, CRABOT_REMOVAL_FRAME_CONFIG: config }
  if (['publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main'].includes(mode)) {
    env.HOME = path.join(own.dataDir, 'finite-user-home')
    await fs.mkdir(env.HOME, { mode: 0o700 })
    env.USERPROFILE = env.HOME; env.APPDATA = path.join(env.HOME, 'Roaming'); env.LOCALAPPDATA = path.join(env.HOME, 'Local')
    env.XDG_CONFIG_HOME = path.join(env.HOME, '.config')
  }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET']) delete env[key]
  const args = mode === 'publish-source-remove-windows-uninstall' ? ['--uninstall'] : ['--background', ...(mode === 'unexpected-source-args' ? ['--unexpected-maintenance-source'] : [])]
  const direct = mode === 'node-parent' ? await prepareDesktopRemovalGui({ installRoot: own.root, operationId }) : undefined
  t.after(async () => { if (direct) await fs.rm(direct.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) })
  const child = spawn(direct?.executable || own.executable, direct ? ['--fixture-removal-host'] : args, { env, cwd: direct?.directory ?? (sourceExitMode ? own.guiRoot : undefined), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }), exited = once(child, 'exit')
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes.toString()).slice(-8000) })
  const processIdentity = identity.inspectProcess(child.pid)
  t.after(() => { if (child.exitCode === null && child.signalCode === null && identity.sameProcess(processIdentity, identity.inspectProcess(child.pid))) child.kill('SIGKILL') })
  let result = await Promise.race([once(child, 'message').then(([result]) => result), exited.then(([code, signal]) => { throw new Error('Source exited: ' + code + ':' + signal + '\n' + output) })])
  const [code] = await exited; assert.equal(code, 0, JSON.stringify(result) + '\n' + output)
  if (sourceExitMode) {
    assert.equal(result.handoff, true, JSON.stringify(result))
    const host = result.host, directory = result.directory
    const exitState = () => probeKnownProcessExit([host]).state
    t.after(async () => {
      if (identity.sameProcess(host, identity.inspectProcess(host.pid))) globalThis.process.kill(host.pid, 'SIGKILL')
      const deadline = Date.now() + 5000
      while (exitState() === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      if (exitState() !== 'stopped') throw new Error('Known fixture host exit remains unverified; private copy retained')
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    })
    // Observe the complete bounded actor result, including repeated full GUI
    // verification, without changing any product deadline.
    const waitingSince = Date.now(), deadline = waitingSince + (mode.includes('source-remove') ? 130000 : 20000)
    while (!(await fs.lstat(cfg.resultFile).catch(() => null)) || exitState() !== 'stopped') {
      if (Date.now() > deadline) throw new Error('Independent host did not finish after actual source exit: ' + JSON.stringify({
        last_stage: await fs.readFile(cfg.stageFile, 'utf8').then(JSON.parse).catch(() => null), host_exit_state: exitState(), result: await fs.readFile(cfg.resultFile, 'utf8').then(JSON.parse).catch(() => null),
      }))
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    result = JSON.parse(await fs.readFile(cfg.resultFile, 'utf8'))
    if (mode.includes('source-remove')) console.log('CRABOT_REMOVAL_HOST_TIMING ' + JSON.stringify({ scenario, post_source_exit_ms: Date.now() - waitingSince, controlled_pin_delay_ms: cfg.removalPinDelayMs, pin_reads: result.removalPinReads, removal_elapsed_ms: result.removalElapsedMs }))
    if (scenario.endsWith('-delayed')) { assert.ok(result.removalPinReads >= 8, JSON.stringify(result)); assert.ok(result.removalElapsedMs > 20000, JSON.stringify(result)) }
  }
  if (mode === 'resume-source-remove-main') {
    assert.equal(result.accepted, true, JSON.stringify(result)); assert.equal(result.core_initially_missing, true)
    assert.equal((await import('../../scripts/lib/desktop-removal-record.cjs')).default.readDesktopRemoval(own.root).phase, 'completed')
  } else if (mode.startsWith('resume-')) {
    assert.equal(result.accepted, ['resume-valid', 'resume-core-missing', 'resume-lease-cancel', 'resume-lease-stopping', 'resume-lease-removing', 'resume-lease-completed', 'resume-lease-core-missing', 'resume-lease-source-exit', 'resume-lease-source-remove'].includes(mode), JSON.stringify(result))
    if (result.accepted) {
      assert.equal(result.resumed, true); assert.equal(result.record.operation_id, operationId); assert.equal(result.record.phase, existingPhase)
      if (mode === 'resume-lease-source-exit' || mode.includes('source-remove')) assert.equal(result.sourceExited, true)
      assert.equal(result.frame.source_gui.pid, child.pid); assert.deepEqual(result.record.source_selection, own.selection)
    } else if (mode === 'resume-lease-busy') assert.match(result.message, /another crabot CLI operation is in progress/)
    else assert.equal(result.code, 'CRABOT_DESKTOP_REMOVAL', JSON.stringify(result))
    const removal = (await import('../../scripts/lib/desktop-removal-record.cjs')).default.readDesktopRemoval(own.root)
    if (mode === 'resume-lease-cancel') { assert.equal(removal, null); assert.equal(result.lease_cancelled, true) }
    else {
      assert.equal(removal.operation_id, operationId)
      const phase = mode === 'resume-lease-core-missing' ? 'stopping' : existingPhase
      assert.equal(removal.phase, phase)
      if (['resume-lease-removing', 'resume-lease-completed', 'resume-lease-core-missing'].includes(mode)) assert.equal(result.lease_cancel_rejected, true)
    }
    if (mode.startsWith('resume-lease-') && result.accepted) assert.equal(result.phase_after_stop, existingPhase === 'preparing' ? 'stopping' : existingPhase)
  } else if (mode === 'publish-inherited-cwd') {
    assert.equal(result.accepted, false); assert.equal(result.code, 'CRABOT_DESKTOP_REMOVAL')
  } else if (mode.startsWith('publish-')) {
    assert.equal(result.accepted, true, JSON.stringify(result)); assert.equal(result.published, true)
    assert.equal(result.cancelled, cancelled, JSON.stringify(result)); assert.equal(result.retained, !cancelled)
    assert.equal(result.cancelRejected, ['publish-module', 'publish-damaged', 'publish-replaced-record', 'publish-live', 'publish-stop-wrong-root', 'publish-stop-lost'].includes(mode), JSON.stringify(result))
    assert.equal(result.sourceExited, ['publish-source-exit', 'publish-source-retry', 'publish-source-late-exit', 'publish-source-remove', 'publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main', 'publish-source-remove-operation', 'publish-source-remove-cancel-retry', 'publish-source-remove-mac-login', 'publish-source-remove-complete', 'publish-source-remove-windows-uninstall', 'publish-source-remove-retry'].includes(mode)); assert.equal(result.sourceExitRejected, ['publish-source-ignore', 'publish-source-disconnect', 'publish-source-retry', 'publish-source-late-exit'].includes(mode))
    assert.equal(result.stopRejected, ['publish-stop-wrong-root', 'publish-stop-lost', 'publish-stop-retry', 'publish-stop-lost-retry'].includes(mode))
    if (mode === 'publish-stop-lost') assert.equal(result.phase, 'stopping')
    assert.equal(result.cancellationReplyLost, mode === 'publish-cancel-lost'); assert.equal(result.lost, mode === 'publish-lost-reply'); assert.equal(result.proofRetained, true)
  } else if (mode === 'valid') {
    assert.equal(result.accepted, true, JSON.stringify(result)); assert.equal(result.frame.operation_id, operationId)
    assert.equal(result.frame.installation_id, own.record.installation_id); assert.equal(result.frame.source_gui.pid, child.pid)
    assert.notEqual(result.frame.host_gui.pid, child.pid); assert.deepEqual(result.frame.source_selection, own.selection)
  } else {
    assert.equal(result.accepted, false, JSON.stringify(result)); assert.equal(result.code, 'CRABOT_DESKTOP_REMOVAL', JSON.stringify(result))
    assert.equal(result.stage, mode === 'changed-copy' ? 'private-programs' : 'source-peer', JSON.stringify(result))
  }
  if (['publish-source-remove-complete', 'publish-source-remove-operation', 'publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main'].includes(mode)) assert.equal(result.completionVerified, true)
  if (['publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main'].includes(mode)) { assert.equal(result.actual_main, true); assert.equal(result.actual_progress_windows, 1); assert.equal(result.os_api_mocked, true); assert.equal(result.login_writes, process.platform === 'darwin' ? 1 : 0); assert.equal(result.registration_calls, process.platform === 'darwin' ? 1 : 0); assert.equal(result.message, '应用已卸载，数据已保留。') }
  if (mode === 'publish-cancel') assert.equal(result.private_copy_removed, true)
  if (mode === 'publish-source-remove-source') { assert.equal(result.actual_source, true); assert.deepEqual(result.dialog_codes, [], JSON.stringify(result)) }
  if (mode === 'publish-source-remove-windows-uninstall') assert.equal(result.windowsUninstallEntryRemoved, true)
  if (mode === 'publish-source-remove-mac-login') { assert.equal(result.macLoginCleaned, true); assert.equal(result.macLoginApiMocked, true) }
  if (mode.includes('source-remove')) { assert.equal(result.programsRemoved, true); assert.equal(result.controlledResourceObservation, true); assert.equal(result.removalRetried, mode === 'publish-source-remove-retry'); assert.equal((await import('../../scripts/lib/desktop-removal-record.cjs')).default.readDesktopRemoval(own.root).phase, ['publish-source-remove-complete', 'publish-source-remove-operation', 'publish-source-remove-main', 'publish-source-remove-source', 'resume-source-remove-main'].includes(mode) ? 'completed' : 'removing'); await assert.rejects(fs.lstat(own.executable), { code: 'ENOENT' }) }
  if ((!mode.startsWith('resume-') && !mode.startsWith('publish-')) || cancelled || mode === 'publish-inherited-cwd') await assert.rejects(fs.lstat(path.join(own.root, '.desktop-removal.json')), { code: 'ENOENT' })
  else assert.equal((await fs.lstat(path.join(own.root, '.desktop-removal.json'))).isFile(), true)
  assert.equal(await fs.readFile(path.join(own.dataDir, 'preserved-user-file'), 'utf8'), 'user bytes')
  if (finite && !['publish-stop', 'publish-stop-retry', 'publish-stop-lost-retry'].includes(mode)) {
    assert.equal(finite.exitCode, null); assert.equal(finite.signalCode, null); assert.equal(inspectInstance(own.dataDir).state, 'running')
    await assert.rejects(fs.lstat(path.join(area, 'stopped')), { code: 'ENOENT' }); return
  }
  if (finite) {
    assert.equal((await finiteExited)[0], 0, finiteOutput); assert.equal(await fs.readFile(path.join(area, 'stopped'), 'utf8'), 'graceful')
    assert.equal(finiteOutput.split('FIXTURE_SHUTDOWN ').length - 1, 1); assert.equal(readInstanceRuntime(own.dataDir), null)
    assert.equal(inspectInstance(own.dataDir).state, 'stopped'); assert.equal(result.stopApplied, true)
  }
  await fs.rm(area, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})
