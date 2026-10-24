import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { verifyDesktopAsar, verifyInstallerAsar } from '../desktop-asar.mjs'
const desktopRequire = createRequire(new URL('../../../crabot-desktop/package.json', import.meta.url))
const builderRequire = createRequire(createRequire(desktopRequire.resolve('electron-builder')).resolve('app-builder-lib/package.json'))
const asar = builderRequire('@electron/asar')
async function fixture(t, missingTray = false, installer = false, pair) {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'Crabot ASAR 中文 ')), source = path.join(parent, 'source'), archive = path.join(parent, 'app.asar')
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const files = { 'dist/main.js': 'export{}', 'dist/bootstrap/scripts/lib/desktop-installation.cjs': 'module.exports={}',
    'dist/bootstrap/scripts/lib/core-release.mjs': 'export{}', 'dist/bootstrap/scripts/lib/physical-fs.cjs': 'module.exports={}',
    'dist/bootstrap/scripts/lib/process-identity.cjs': 'module.exports={}', 'dist/bootstrap/crabot-native/build/Release/crabot-native.node': 'native fixture', 'dist/preload.cjs': 'module.exports={}', 'dist/assets/tray.png': 'fixture tray bytes',
    'node_modules/crabot-client/dist/index.js': 'export{}', 'node_modules/zod/package.json': '{}', 'node_modules/electron-updater/package.json': '{}', 'node_modules/@electron/asar/package.json': '{}' }
  for (const file of ['dist/paired-update.js', 'dist/release-intake.js', 'dist/release-signatures.js', 'dist/release-download.js', 'dist/release-transport.js', 'dist/bootstrap/scripts/lib/desktop-management.cjs', 'dist/bootstrap/scripts/desktop/extract-paired-release.py']) files[file] = 'trusted release fixture'
  if (installer) for (const file of ['dist/installer-main.js', 'dist/installer-preload.cjs', 'dist/installation-progress-window.js', 'dist/installation-entries.js',
    'dist/bootstrap/scripts/lib/desktop-payload.mjs', 'dist/bootstrap/scripts/lib/core-release.mjs', 'dist/bootstrap/scripts/lib/physical-fs.cjs']) files[file] = 'installer fixture'
  if (pair) files['dist/desktop-release.json'] = pair.text
  if (missingTray) delete files['dist/assets/tray.png']
  for (const [file, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true }); await fs.writeFile(path.join(source, file), bytes)
  }
  if (pair?.link) {
    const file = path.join(source, 'dist/desktop-release.json')
    await fs.rename(file, path.join(source, 'dist/pin.json')); await fs.symlink('pin.json', file, 'file')
  }
  if (pair?.unpack) await asar.createPackageWithOptions(source, archive, { unpack: '**/desktop-release.json' })
  else await asar.createPackage(source, archive)
  return archive
}
function windowsFilesystem(archive) {
  // Execute the installed ASAR filesystem unchanged, using Windows path APIs.
  // The actual archive/header is produced by ASAR; no Electron or business Core runs.
  const file = builderRequire.resolve('@electron/asar/lib/filesystem.js'), require = createRequire(file), module = { exports: {} }
  vm.runInNewContext(readFileSync(file, 'utf8'), { module, exports: module.exports, Buffer, process,
    require: name => name === 'path' ? path.win32 : require(name) }, { filename: file })
  const filesystem = new module.exports.Filesystem('C:\\fixture\\app.asar'), header = asar.getRawHeader(archive)
  filesystem.setHeader(structuredClone(header.header), header.headerSize)
  return { statFile: (_, file) => filesystem.getFile(file, false),
    extractFile: (_, file) => asar.extractFile(archive, file.split(/[\\/]/).join(path.sep), false) }
}
test('actual ASAR candidate entries are verified with native paths', async t => {
  const archive = await fixture(t); verifyDesktopAsar(asar, archive)
})
test('Windows ASAR lookup reproduces the nested forward-slash failure and verifies the normalized entries', async t => {
  const archive = await fixture(t), windows = windowsFilesystem(archive)
  assert.throws(() => windows.statFile(archive, 'dist/assets/tray.png'), /not found/)
  verifyDesktopAsar(windows, archive, 'win32')
})
test('missing tray bytes still fail candidate/installer verification on both native and Windows readers', async t => {
  const archive = await fixture(t, true)
  assert.throws(() => verifyDesktopAsar(asar, archive), /tray\.png.*not found/)
  assert.throws(() => verifyDesktopAsar(windowsFilesystem(archive), archive, 'win32'), /tray\.png.*not found/)
})

test('installer ASAR independently verifies its trusted backend instead of executing the unverified payload Core', async t => {
  const complete = await fixture(t, false, true), ordinary = await fixture(t)
  verifyInstallerAsar(asar, complete); verifyInstallerAsar(windowsFilesystem(complete), complete, 'win32')
  assert.throws(() => verifyInstallerAsar(asar, ordinary), /installer-main.*not found/)
})


const pair = { schema_version: 1, version: '1.2.3', gui_id: '11111111-1111-4111-8111-111111111111', core_id: 'a'.repeat(64) }
test('the GUI pair declaration is a packed exact member of the actual ASAR', async t => {
  const archive = await fixture(t, false, false, { text: JSON.stringify(pair) + '\n' })
  verifyDesktopAsar(asar, archive, process.platform, pair)
  verifyDesktopAsar(windowsFilesystem(archive), archive, 'win32', pair)
})
for (const changed of ['missing', 'different-pair', 'unpacked', 'link']) test('ASAR verification rejects an unprotected or wrong GUI declaration: ' + changed, async t => {
  const option = changed === 'missing' ? undefined : { text: JSON.stringify(changed === 'different-pair' ? { ...pair, core_id: 'b'.repeat(64) } : pair) + '\n', unpack: changed === 'unpacked', link: changed === 'link' }
  const archive = await fixture(t, false, false, option)
  if (changed === 'unpacked') assert.equal(asar.statFile(archive, path.normalize('dist/desktop-release.json')).unpacked, true)
  if (changed === 'link') assert.equal(typeof asar.statFile(archive, path.normalize('dist/desktop-release.json'), false).link, 'string')
  assert.throws(() => verifyDesktopAsar(asar, archive, process.platform, pair))
})


test('an unbounded ASAR header is rejected before invoking the parser', async t => {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'crabot-asar-bound-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const archive = path.join(parent, 'app.asar'), bytes = Buffer.alloc(8)
  bytes.writeUInt32LE(4); bytes.writeUInt32LE(0xffffffff, 4); await fs.writeFile(archive, bytes)
  let parsed = false
  assert.throws(() => verifyDesktopAsar({ statFile: () => { parsed = true; throw new Error('parser should not run') } }, archive, process.platform, pair), { code: 'CRABOT_CORE_INTEGRITY' })
  assert.equal(parsed, false)
})


for (const member of ['dist/paired-update.js', 'dist/release-intake.js', 'dist/release-signatures.js', 'dist/release-download.js', 'dist/release-transport.js', 'dist/bootstrap/scripts/lib/desktop-management.cjs', 'dist/bootstrap/scripts/desktop/extract-paired-release.py']) {
  test('packaged GUI requires its own trusted release component: ' + member, async t => {
    const archive = await fixture(t)
    const missing = { statFile: (file, name) => { if (name === path.normalize(member)) throw new Error('missing trusted release resource'); return asar.statFile(file, name) } }
    assert.throws(() => verifyDesktopAsar(missing, archive), /missing trusted release resource/)
  })
}
