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
  for (const name of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(core, name), JSON.stringify({ version: '1.2.3' }))
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
for (const mode of ['valid', 'node-parent', 'unexpected-source-args', 'changed-copy', 'other-installation']) test('actual protected initial removal frame: ' + mode, { skip: !supported, timeout: 60000 }, async t => {
  const area = await fs.mkdtemp(path.join(root, 'case-'))
  const own = await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(area, 'installation') }))
  const operationId = randomUUID(), cfg = { root: own.root, operationId, mode }
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
  const result = await Promise.race([once(child, 'message').then(([result]) => result), exited.then(([code, signal]) => { throw new Error('Source exited: ' + code + ':' + signal + '\n' + output) })])
  const [code] = await exited; assert.equal(code, 0, output)
  if (mode === 'valid') {
    assert.equal(result.accepted, true, JSON.stringify(result)); assert.equal(result.frame.operation_id, operationId)
    assert.equal(result.frame.installation_id, own.record.installation_id); assert.equal(result.frame.source_gui.pid, child.pid)
    assert.notEqual(result.frame.host_gui.pid, child.pid); assert.deepEqual(result.frame.source_selection, own.selection)
  } else {
    assert.equal(result.accepted, false, JSON.stringify(result)); assert.equal(result.code, 'CRABOT_DESKTOP_REMOVAL', JSON.stringify(result))
    assert.equal(result.stage, mode === 'changed-copy' ? 'private-programs' : 'source-peer', JSON.stringify(result))
  }
  await assert.rejects(fs.lstat(path.join(own.root, '.desktop-removal.json')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(own.dataDir, 'preserved-user-file'), 'utf8'), 'user bytes')
  await fs.rm(area, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})
