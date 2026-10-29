// Build a distinct offline installer host. The signed GUI payload is opaque;
// fresh installation never executes it. Retained-data repair uses only the
// verified installed target's fixed recovery handoff.
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { verifyDesktopPayload } from '../lib/desktop-payload.mjs'
import { verifyInstallerAsar } from '../lib/desktop-asar.mjs'
import { verifyCoreRelease } from '../lib/core-release.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = new Map(process.argv.slice(2).map(value => { const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)] }))
if (args.get('--candidate') !== 'true' || !args.get('--paired') || !args.get('--out')) throw new Error('Expected --candidate=true --paired=<paired-project> --out=<new-installer-project>')
const source = await fs.realpath(path.resolve(args.get('--paired'))), output = path.resolve(args.get('--out'))
const within = (parent, child) => { const relative = path.relative(parent, child); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
if (!within(path.join(root, '.desktop-build'), source) || !within(path.join(root, '.desktop-build'), output) || within(source, output) || within(output, source) || source === output) throw new Error('Candidate projects must be separate build-root directories')
const location = JSON.parse(await fs.readFile(path.join(source, 'packaged-location.json'), 'utf8'))
if (location.schema_version !== 2 || location.payload !== 'offline') throw new Error('Expected a paired candidate project')
const payload = await verifyDesktopPayload(path.join(source, 'offline')), release = await verifyCoreRelease(payload.coreRoot)
function sameSource() {
  if (release.source_dirty || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== release.commit
    || execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Installer and payload must use the same clean source commit')
}
sameSource()
await fs.mkdir(output)
const appDir = path.join(output, 'app')
await fs.cp(path.join(source, 'app'), appDir, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
await fs.cp(path.join(source, 'crabot-client'), path.join(output, 'crabot-client'), { recursive: true })
const packageFile = path.join(appDir, 'package.json'), pkg = JSON.parse(await fs.readFile(packageFile, 'utf8'))
await fs.writeFile(packageFile, JSON.stringify({ ...pkg, name: 'crabot-installer', main: 'dist/installer-main.js', productName: 'Crabot Installer' }, null, 2) + '\n')
// Only tracked helper code is copied. No local node_modules, tests, .env, data or
// source paths are consulted by the shipped installer after this build step.
const helpers = execFileSync('git', ['ls-files', '-z', '--', 'scripts/lib', 'scripts/upgrade-lib', 'scripts/desktop/legacy-releases.json', 'scripts/desktop/legacy-python-bootstrap.json'], { cwd: root, encoding: 'utf8' }).split('\0').filter(file => file && /\.(?:mjs|cjs|json)$/.test(file) && !file.split('/').some(part => ['node_modules', '__tests__', 'fixtures', 'tests'].includes(part)))
for (const file of helpers) {
  const target = path.join(appDir, 'dist/bootstrap', file)
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(root, file), target)
}
if (process.platform === 'linux') {
  const { packageUbuntuInstaller } = await import('./package-ubuntu-installer.mjs')
  await packageUbuntuInstaller({ appDir, output, payload, release, nativeDirectory: args.get('--native-bootstrap'), distribute: args.get('--distribute') === 'true' })
  sameSource()
  console.log('Native GTK offline candidate assembled; default GNOME/Polkit and real GUI/browser acceptance remain required.')
  process.exit(0)
}
const require = createRequire(path.join(root, 'crabot-desktop/package.json')), { build, Platform, Arch } = require('electron-builder')
let resources
await build({ projectDir: output, publish: 'never', targets: Platform.current().createTarget('dir', Arch[process.arch]), config: {
  appId: 'com.crabot.installer', productName: 'Crabot Installer', electronVersion: '44.9.0',
  directories: { app: appDir, output: path.join(output, 'unpacked') },
  electronDist: path.join(path.dirname(require.resolve('electron/package.json')), 'dist'),
  files: ['dist/**/*', 'package.json', '!**/*.map'], asar: true, asarUnpack: ['dist/bootstrap/**/*.node'], npmRebuild: false, publish: null,
  electronFuses: { runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: process.platform !== 'linux', onlyLoadAppFromAsar: true, grantFileProtocolExtraPrivileges: false },
  mac: { icon: path.join(root, 'crabot-desktop/assets/app.png'), identity: '-', minimumSystemVersion: '14.0.0', hardenedRuntime: false, notarize: false, signIgnore: ['/Resources/offline/'] },
  win: { executableName: 'CrabotInstaller', icon: path.join(root, 'crabot-desktop/assets/app.png') },
  linux: { executableName: 'crabot-installer', icon: path.join(root, 'crabot-desktop/assets/app.png'), category: 'Utility' },
  afterPack: async context => {
    resources = process.platform === 'darwin' ? path.join(context.appOutDir, 'Crabot Installer.app/Contents/Resources') : path.join(context.appOutDir, 'resources')
    await fs.cp(payload.directory, path.join(resources, 'offline'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
    await fs.writeFile(path.join(resources, 'candidate-only.json'), JSON.stringify({ candidate_only: true, release_signed: false, version: release.version }) + '\n')
  },
} })
sameSource()
if (!resources) throw new Error('Installer resources were not reported')
await verifyDesktopPayload(path.join(resources, 'offline'))
const builderRequire = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib/package.json'))
verifyInstallerAsar(builderRequire('@electron/asar'), path.join(resources, 'app.asar'))
const executable = process.platform === 'darwin' ? path.resolve(resources, '../MacOS/Crabot Installer') : path.resolve(resources, '..', process.platform === 'win32' ? 'CrabotInstaller.exe' : 'crabot-installer')
await fs.writeFile(path.join(output, 'installer-location.json'), JSON.stringify({ schema_version: 1, candidate_only: true, release_signed: false,
  executable: path.relative(output, executable).split(path.sep).join('/'), payload: path.relative(output, path.join(resources, 'offline')).split(path.sep).join('/') }, null, 2) + '\n')
console.log('Offline installer host built; OS distribution wrappers and final installation acceptance remain required.')

if (args.get('--distribute') === 'true') {
  const artifacts = [], packaged = process.platform === 'darwin' ? path.resolve(resources, '../../..') : path.dirname(executable)
  await build({ projectDir: output, prepackaged: process.platform === 'darwin' ? path.join(packaged, 'Crabot Installer.app') : packaged,
    publish: 'never', targets: Platform.current().createTarget(process.platform === 'darwin' ? ['dmg'] : ['nsis'], Arch[process.arch]), config: {
      appId: 'com.crabot.installer', productName: 'Crabot Installer', electronVersion: '44.9.0',
      directories: { app: appDir, output: path.join(output, 'distribution') }, publish: null,
      artifactName: 'Crabot-${version}-${os}-${arch}-offline-candidate.${ext}',
      mac: { identity: null, icon: path.join(root, 'crabot-desktop/assets/app.png'), minimumSystemVersion: '14.0.0' }, dmg: { sign: false, title: '安装 Crabot', backgroundColor: '#ffffff', contents: [{ x: 220, y: 160, type: 'file' }] },
      win: { executableName: 'CrabotInstaller', signAndEditExecutable: false, icon: path.join(root, 'crabot-desktop/assets/app.png') },
      nsis: { oneClick: false, perMachine: false, packElevateHelper: false, allowElevation: false, allowToChangeInstallationDirectory: true,
        script: path.join(root, 'scripts/desktop/windows-offline-installer.nsi'), installerLanguages: ['zh_CN'], deleteAppDataOnUninstall: false, runAfterFinish: false },
      afterAllArtifactBuild: async result => { artifacts.push(...result.artifactPaths); return [] },
    } })
  await verifyDesktopPayload(path.join(resources, 'offline'))
  await fs.writeFile(path.join(output, 'distribution/artifacts.json'), JSON.stringify({ candidate_only: true, release_signed: false,
    files: artifacts.map(file => path.basename(file)) }) + '\n')
}
