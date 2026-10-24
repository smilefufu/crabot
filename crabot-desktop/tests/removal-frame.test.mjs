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
  await fs.copyFile(new URL('fixtures/removal-frame-actor.cjs', import.meta.url), path.join(appDir, 'dist/main.cjs'))
  await fs.writeFile(path.join(appDir, 'dist/desktop-release.json'), JSON.stringify(selection) + '\n')
  await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'crabot-removal-frame-fixture', version: '1.2.3', main: 'dist/main.cjs', dependencies: { '@electron/asar': '3.4.1' } }))
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
for (const mode of ['valid', 'node-parent', 'unexpected-source-args', 'changed-copy', 'other-installation', 'publish-close', 'publish-cancel', 'publish-module', 'publish-damaged', 'publish-lost-reply', 'publish-replaced-record', 'publish-live', 'publish-cancel-lost', 'publish-stop', 'publish-stop-wrong-root', 'publish-stop-lost', 'publish-source-exit', 'publish-source-ignore', 'publish-source-disconnect']) test('actual protected initial removal frame: ' + mode, { skip: !supported, timeout: 60000 }, async t => {
  const area = await fs.mkdtemp(path.join(root, 'case-'))
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
  const operationId = randomUUID(), cfg = { root: own.root, operationId, mode, resultFile: path.join(area, 'host-result.json') }
  if (mode === 'other-installation') cfg.inspectRoot = (await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'other') }))).root
  await fs.writeFile(path.join(own.dataDir, 'preserved-user-file'), 'user bytes')
  const config = path.join(area, 'control.json'); await fs.writeFile(config, JSON.stringify(cfg))
  const env = { ...process.env, CRABOT_REMOVAL_FRAME_CONFIG: config }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET']) delete env[key]
  const args = ['--background', ...(mode === 'unexpected-source-args' ? ['--unexpected-maintenance-source'] : [])]
  const direct = mode === 'node-parent' ? await prepareDesktopRemovalGui({ installRoot: own.root, operationId }) : undefined
  t.after(async () => { if (direct) await fs.rm(direct.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) })
  const child = spawn(direct?.executable || own.executable, direct ? ['--fixture-removal-host'] : args, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }), exited = once(child, 'exit')
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes.toString()).slice(-8000) })
  const processIdentity = identity.inspectProcess(child.pid)
  t.after(() => { if (child.exitCode === null && child.signalCode === null && identity.sameProcess(processIdentity, identity.inspectProcess(child.pid))) child.kill('SIGKILL') })
  let result = await Promise.race([once(child, 'message').then(([result]) => result), exited.then(([code, signal]) => { throw new Error('Source exited: ' + code + ':' + signal + '\n' + output) })])
  const [code] = await exited; assert.equal(code, 0, output)
  if (mode === 'publish-source-exit') {
    assert.equal(result.handoff, true, JSON.stringify(result))
    const host = result.host, directory = result.directory
    t.after(async () => {
      if (identity.sameProcess(host, identity.inspectProcess(host.pid))) globalThis.process.kill(host.pid, 'SIGKILL')
      if (identity.isProcessExited(host.pid)) await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    })
    const deadline = Date.now() + 20000
    while (!(await fs.lstat(cfg.resultFile).catch(() => null)) || !identity.isProcessExited(host.pid)) {
      if (Date.now() > deadline) throw new Error('Independent host did not finish after actual source exit: ' + JSON.stringify({
        host_exited: identity.isProcessExited(host.pid), result: await fs.readFile(cfg.resultFile, 'utf8').then(JSON.parse).catch(() => null),
      }))
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    result = JSON.parse(await fs.readFile(cfg.resultFile, 'utf8'))
  }
  if (mode.startsWith('publish-')) {
    assert.equal(result.accepted, true, JSON.stringify(result)); assert.equal(result.published, true)
    assert.equal(result.cancelled, ['publish-cancel', 'publish-cancel-lost', 'publish-stop', 'publish-source-exit'].includes(mode), JSON.stringify(result)); assert.equal(result.retained, !['publish-cancel', 'publish-cancel-lost', 'publish-stop', 'publish-source-exit'].includes(mode))
    assert.equal(result.cancelRejected, ['publish-module', 'publish-damaged', 'publish-replaced-record', 'publish-live', 'publish-stop-wrong-root', 'publish-stop-lost'].includes(mode), JSON.stringify(result))
    assert.equal(result.sourceExited, mode === 'publish-source-exit'); assert.equal(result.sourceExitRejected, ['publish-source-ignore', 'publish-source-disconnect'].includes(mode))
    assert.equal(result.stopRejected, ['publish-stop-wrong-root', 'publish-stop-lost'].includes(mode))
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
  if (!mode.startsWith('publish-') || ['publish-cancel', 'publish-cancel-lost', 'publish-stop', 'publish-source-exit'].includes(mode)) await assert.rejects(fs.lstat(path.join(own.root, '.desktop-removal.json')), { code: 'ENOENT' })
  else assert.equal((await fs.lstat(path.join(own.root, '.desktop-removal.json'))).isFile(), true)
  assert.equal(await fs.readFile(path.join(own.dataDir, 'preserved-user-file'), 'utf8'), 'user bytes')
  if (finite && mode !== 'publish-stop') {
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
