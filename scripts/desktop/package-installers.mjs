// Platform-native development installers from the already verified unpacked App.
// Candidate markers keep update channels disabled; this never signs or publishes.
import { promises as fs, createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { verifyCoreRelease } from '../lib/core-release.mjs'

for (const key of ['CSC_LINK', 'WIN_CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_KEY_PASSWORD']) {
  if (process.env[key]) throw new Error('Unsigned candidate generation must run without signing credentials')
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const options = new Map(process.argv.slice(2).map(value => { const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)] }))
if (options.get('--candidate') !== 'true' || !options.get('--project') || !options.get('--out')) throw new Error('Expected --candidate=true --project=<unpacked-project> --out=<new-candidate-directory>')
const project = await fs.realpath(path.resolve(options.get('--project')))
const buildRoot = await fs.realpath(path.join(repository, '.desktop-build'))
const requested = path.resolve(options.get('--out'))
const output = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested))
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
if (!inside(buildRoot, project) || !inside(buildRoot, output)) throw new Error('Installer project and output must be under .desktop-build')
if (project === output || inside(project, output) || inside(output, project)) throw new Error('Installer output must be separate from its source project')
const location = JSON.parse(await fs.readFile(path.join(project, 'packaged-location.json'), 'utf8'))
if (location.schema_version !== 1) throw new Error('Invalid packaged location')
function source(relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Invalid packaged path')
  const absolute = path.resolve(project, relative)
  if (!inside(project, absolute)) throw new Error('Packaged path leaves its project')
  return absolute
}
const executable = source(location.executable), core = source(location.core), resources = path.dirname(core)
const packaged = process.platform === 'darwin' ? path.resolve(executable, '../../..') : path.dirname(executable)
const candidate = JSON.parse(await fs.readFile(path.join(resources, 'candidate-only.json'), 'utf8'))
const release = await verifyCoreRelease(core)
if (candidate.candidate_only !== true || candidate.inventory_sha256 !== release.inventory_sha256) throw new Error('Expected the exact candidate App')
const host = JSON.parse(await fs.readFile(path.join(core, 'desktop-host.json'), 'utf8'))
if (host.platform !== process.platform || host.arch !== process.arch) throw new Error('Build installers on the App target platform')
const manifest = JSON.parse(await fs.readFile(path.join(core, 'core-files.json'), 'utf8'))
const bytes = Object.values(manifest.files).reduce((sum, file) => sum + BigInt(file.size ?? 0), 0n)
const space = await fs.statfs(path.dirname(output), { bigint: true })
if (space.bavail * space.bsize < bytes * 3n + 512n * 1024n * 1024n) throw new Error('Installer generation needs more temporary disk space')
await fs.mkdir(output) // Keep previous candidates and failed-build evidence.
const require = createRequire(path.join(repository, 'crabot-desktop/package.json'))
const { build, Platform, Arch } = require('electron-builder')
const icon = path.join(repository, 'crabot-desktop/assets/app.png')
async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
const app = { asar_sha256: await digest(path.join(resources, 'app.asar')), executable_sha256: await digest(executable) }
const artifacts = []
await build({ projectDir: project, prepackaged: packaged, publish: 'never',
  targets: Platform.current().createTarget(process.platform === 'darwin' ? ['dmg', 'zip'] : process.platform === 'win32' ? ['nsis'] : ['deb'], Arch[process.arch]),
  config: {
    appId: 'com.crabot.desktop', productName: 'Crabot', electronVersion: '44.9.0',
    directories: { app: path.join(project, 'app'), output }, publish: null,
    extraMetadata: { homepage: 'https://github.com/smilefufu/crabot' },
    artifactName: 'Crabot-${version}-${os}-${arch}-candidate.${ext}',
    mac: { icon, identity: null, minimumSystemVersion: '14.0.0', category: 'public.app-category.productivity' },
    dmg: { sign: false },
    win: { executableName: 'Crabot', icon, signAndEditExecutable: false },
    nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false, runAfterFinish: false,
      createDesktopShortcut: false, shortcutName: 'Crabot' },
    linux: { executableName: 'crabot-desktop', icon, category: 'Utility', desktop: { entry: { Name: 'Crabot' } },
      maintainer: 'Crabot Team' },
    afterAllArtifactBuild: async result => { for (const file of result.artifactPaths) artifacts.push(file); return [] },
  },
})
const expected = process.platform === 'darwin' ? ['.dmg', '.zip'] : process.platform === 'win32' ? ['.exe'] : ['.deb']
const files = []
for (const extension of expected) {
  const matches = artifacts.filter(file => file.endsWith(extension))
  if (matches.length !== 1 || !inside(output, matches[0])) throw new Error('Unconfirmed installer artifact: ' + extension)
  const file = matches[0]
  files.push({ file: path.basename(file), bytes: (await fs.stat(file)).size, sha256: await digest(file) })
}
if (await digest(path.join(resources, 'app.asar')) !== app.asar_sha256 || await digest(executable) !== app.executable_sha256) throw new Error('Installer generation changed the App')
if ((await verifyCoreRelease(core)).inventory_sha256 !== release.inventory_sha256) throw new Error('Installer generation changed the Core')
await fs.writeFile(path.join(output, 'installers.json'), JSON.stringify({ schema_version: 1, candidate_only: true,
  release_signed: false, platform: process.platform, arch: process.arch, version: release.version,
  inventory_sha256: release.inventory_sha256, app, files }, null, 2) + '\n', { flag: 'wx' })
console.log('CRABOT_INSTALLERS ' + JSON.stringify({ candidate_only: true, release_signed: false, files }))
