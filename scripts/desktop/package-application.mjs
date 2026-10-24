// Build an unpacked development candidate. This deliberately cannot publish or
// claim release signing/notarization; final installers require the P6/P7 gates.
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sealDesktopPayload } from '../lib/desktop-payload.mjs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { runBounded } from '../lib/run-bounded.mjs'
import product from '../lib/product-runtime.cjs'
import scrapling from '../lib/scrapling-runtime.cjs'
import computerUse from '../lib/computer-use-runtime.cjs'
import { verifyCoreRelease } from '../lib/core-release.mjs'
import { verifyDesktopAsar } from '../lib/desktop-asar.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = new Map(process.argv.slice(2).map(value => { const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)] }))
if (args.get('--candidate') !== 'true' || !args.get('--core') || !args.get('--out')) throw new Error('Usage: package-application.mjs --candidate=true --core=<sealed-core> --out=<new-project-directory>')
const paired = args.get('--layout') === 'paired'
if (args.has('--layout') && !paired) throw new Error('Unsupported candidate layout')
const core = await fs.realpath(path.resolve(args.get('--core'))), projectDir = path.resolve(args.get('--out'))
if (!path.relative(root, projectDir).startsWith('.desktop-build' + path.sep)) throw new Error('Candidate project must be under .desktop-build')
try { await fs.lstat(projectDir); throw new Error('Candidate project already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
const release = await verifyCoreRelease(core)
function checkSource() {
  if (release.source_dirty || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== release.commit
    || execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) {
    throw new Error('Desktop and core must be assembled from the same clean source commit; stage a fresh candidate')
  }
}
checkSource()
let ubuntuNative
if (paired && process.platform === 'linux') {
  if (process.arch !== 'x64' || !args.get('--native-bootstrap')) throw new Error('Paired Ubuntu GUI requires the same-source Ubuntu24 native bootstrap')
  const { readUbuntuBootstrap } = await import('./package-ubuntu-installer.mjs')
  ubuntuNative = await readUbuntuBootstrap(await fs.realpath(path.resolve(args.get('--native-bootstrap'))), release.commit)
}
const runtime = product.loadProductRuntime(core, { required: true, full: true })
scrapling.loadRuntime(core, { full: true })
computerUse.loadRuntime(core, { full: true })
const appDir = path.join(projectDir, 'app')
const appIcon = path.join(root, 'crabot-desktop/assets/app.png')
await fs.mkdir(path.dirname(projectDir), { recursive: true })
await fs.mkdir(projectDir)
await fs.mkdir(appDir)
const selection = { schema_version: 1, version: release.version, gui_id: randomUUID(), core_id: release.inventory_sha256 }
const offline = path.join(projectDir, 'offline'), pairedCore = path.join(offline, 'core')
if (paired) {
  await fs.mkdir(offline)
  await fs.cp(core, pairedCore, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  await fs.writeFile(path.join(pairedCore, 'desktop-host.json'), JSON.stringify({ schema_version: 2, platform: process.platform, arch: process.arch }) + '\n')
}
await fs.cp(path.join(root, 'crabot-desktop/dist'), path.join(appDir, 'dist'), { recursive: true })
if (paired) await fs.writeFile(path.join(appDir, 'dist/desktop-release.json'), JSON.stringify(selection) + '\n')
await fs.mkdir(path.join(projectDir, 'crabot-client'))
for (const file of ['package.json', 'pnpm-lock.yaml']) await fs.copyFile(path.join(root, 'crabot-client', file), path.join(projectDir, 'crabot-client', file))
await fs.cp(path.join(root, 'crabot-client/dist'), path.join(projectDir, 'crabot-client/dist'), { recursive: true })
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'crabot-desktop/package.json'), 'utf8'))
delete packageJson.crabotDesktopDevelopment
packageJson.version = release.version
packageJson.productName = 'Crabot'
packageJson.description = 'Crabot desktop agent'
packageJson.author = 'Crabot Team'
packageJson.packageManager = 'pnpm@9.15.9'
packageJson.desktopName = 'crabot.desktop'
await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n')
await fs.copyFile(path.join(root, 'crabot-desktop/pnpm-lock.yaml'), path.join(appDir, 'pnpm-lock.yaml'))
const install = ['install', '--prod', '--frozen-lockfile', '--node-linker=hoisted', '--package-import-method=copy', '--prefer-offline']
const corepack = path.join(path.dirname(runtime.executables.node), process.platform === 'win32' ? 'node_modules/corepack/dist/corepack.js' : '../lib/node_modules/corepack/dist/corepack.js')
await runBounded(runtime.executables.node, [corepack, 'pnpm@9.15.9', ...install],
  { cwd: appDir, env: product.productEnvironment(runtime, path.join(root, '.desktop-build/build-cache')), timeout: 10 * 60_000 })
delete packageJson.devDependencies
await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n')
const require = createRequire(path.join(root, 'crabot-desktop/package.json'))
const { build, Platform, Arch } = require('electron-builder')
let packagedResources
const configuration = {
  appId: 'com.crabot.desktop', productName: 'Crabot', electronVersion: '44.9.0',
  directories: { app: appDir, output: path.join(projectDir, 'unpacked') },
  electronDist: path.join(path.dirname(require.resolve('electron/package.json')), 'dist'),
  files: ['dist/**/*', 'package.json', '!**/*.map'],
  asar: true, asarUnpack: ['dist/bootstrap/**/*.node'], npmRebuild: false, publish: null,
  electronFuses: { runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: process.platform !== 'linux',
    onlyLoadAppFromAsar: true, grantFileProtocolExtraPrivileges: false },
  // Candidate signatures are local only. Keep core bytes and the vendor Cua
  // identity unchanged; release signing must precede regenerated inventories.
  mac: { icon: appIcon, minimumSystemVersion: '14.0.0', category: 'public.app-category.productivity', identity: '-', hardenedRuntime: false,
    notarize: false, signIgnore: ['/Resources/core/'] },
  win: { executableName: 'Crabot', icon: appIcon },
  linux: { executableName: 'crabot-desktop', icon: appIcon, syncDesktopName: true, category: 'Utility' },
  afterPack: async context => {
    const resources = process.platform === 'darwin' ? path.join(context.appOutDir, 'Crabot.app/Contents/Resources') : path.join(context.appOutDir, 'resources')
    packagedResources = resources
    const packagedCore = paired ? pairedCore : path.join(resources, 'core')
    // Electron's resource matcher prunes root node_modules and dotfiles. The
    // standalone core is an opaque verified payload, not an Electron app tree.
    if (paired) {
      await fs.writeFile(path.join(resources, 'desktop-release.json'), JSON.stringify(selection) + '\n')
      await fs.copyFile(appIcon, path.join(resources, 'crabot.png'))
      if (ubuntuNative) {
        // These target resources are included in the complete GUI inventory and
        // signed archive before the updater may execute either fixed helper.
        await fs.writeFile(path.join(resources, 'crabot-sandbox-helper'), ubuntuNative.binaries['crabot-sandbox-helper'], { flag: 'wx', mode: 0o755 })
        await fs.copyFile(path.join(root, 'crabot-desktop/native/ubuntu/browser-probe.py'), path.join(resources, 'browser-probe.py'))
      }
    }
    else {
      await fs.cp(core, packagedCore, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
      await fs.writeFile(path.join(packagedCore, 'desktop-host.json'), JSON.stringify({ schema_version: 1, platform: process.platform, arch: process.arch }) + '\n')
    }
    await fs.writeFile(path.join(resources, 'candidate-only.json'), JSON.stringify({ ...release, candidate_only: true }) + '\n')
    product.loadProductRuntime(packagedCore, { required: true, full: true })
    scrapling.loadRuntime(packagedCore, { full: true })
    computerUse.loadRuntime(packagedCore, { full: true })
    await verifyCoreRelease(packagedCore, { version: release.version })
  },
}
await fs.writeFile(path.join(projectDir, 'candidate-build.json'), JSON.stringify({ ...release, candidate_only: true, signing: process.platform === 'darwin' ? 'ad_hoc' : 'unsigned' }, null, 2) + '\n')
await build({ projectDir, config: configuration, publish: 'never', targets: Platform.current().createTarget('dir', Arch[process.arch]) })
checkSource()
if (!packagedResources) throw new Error('Electron builder did not report its packaged resources')
// Signing/packing must not invalidate immutable core bytes or vendor identity.
product.loadProductRuntime(paired ? pairedCore : path.join(packagedResources, 'core'), { required: true, full: true })
scrapling.loadRuntime(paired ? pairedCore : path.join(packagedResources, 'core'), { full: true })
computerUse.loadRuntime(paired ? pairedCore : path.join(packagedResources, 'core'), { full: true })
await verifyCoreRelease(paired ? pairedCore : path.join(packagedResources, 'core'), { version: release.version })
const builderRequire = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib/package.json'))
const asar = builderRequire('@electron/asar')
verifyDesktopAsar(asar, path.join(packagedResources, 'app.asar'), process.platform, paired ? selection : undefined)

const executable = process.platform === 'darwin' ? path.join(packagedResources, '../MacOS/Crabot')
  : path.join(packagedResources, '..', process.platform === 'win32' ? 'Crabot.exe' : 'crabot-desktop')
const { getCurrentFuseWire, FuseV1Options } = builderRequire('@electron/fuses')
const fuses = await getCurrentFuseWire(executable)
for (const key of [FuseV1Options.RunAsNode, FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseV1Options.EnableNodeCliInspectArguments]) {
  if (fuses[key] !== 48) throw new Error('Packaged Electron executable fuse was not disabled: ' + key)
}
if (fuses[FuseV1Options.OnlyLoadAppFromAsar] !== 49) throw new Error('Packaged Electron must load only its ASAR')
if (paired) {
  const gui = path.resolve(packagedResources, process.platform === 'darwin' ? '../../..' : '..')
  await fs.cp(gui, path.join(offline, 'gui'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  await sealDesktopPayload(offline)
}
await fs.writeFile(path.join(projectDir, 'packaged-location.json'), JSON.stringify({ schema_version: paired ? 2 : 1,
  executable: path.relative(projectDir, executable).split(path.sep).join('/'),
  core: path.relative(projectDir, paired ? pairedCore : path.join(packagedResources, 'core')).split(path.sep).join('/'),
  ...(paired ? { payload: 'offline' } : {}) }, null, 2) + '\n')
console.log('Unpacked development candidate created; final signing, installer and update acceptance remain required.')
