// Test-only GUI producer. Preserve all production source modules and fuses, but
// package a finite component actor as main so OS peer checks see its real GUI.
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { sealDesktopPayload, verifyDesktopPayload } from '../../scripts/lib/desktop-payload.mjs'
import { verifyDesktopAsar } from '../../scripts/lib/desktop-asar.mjs'

export async function buildDesktopComponentSource({ repository, project, destination, entryFixture, additionalFixtures = [] }) {
  for (const file of [entryFixture, ...additionalFixtures]) assert.match(file, /^[a-z0-9-]+\.cjs$/)
  assert.ok(['darwin', 'win32', 'linux'].includes(process.platform))
  const original = await verifyDesktopPayload(path.join(project, 'offline'))
  const selection = { ...original.record.selection, gui_id: randomUUID() }, app = path.join(destination, 'app')
  await fs.mkdir(destination, { mode: 0o700 })
  await fs.cp(path.join(project, 'app'), app, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  await fs.cp(path.join(project, 'crabot-client'), path.join(destination, 'crabot-client'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  const metadata = JSON.parse(await fs.readFile(path.join(app, 'package.json'), 'utf8'))
  assert.equal(metadata.version, selection.version); assert.equal(metadata.main, 'dist/main.js')
  metadata.main = 'dist/' + entryFixture
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify(metadata) + '\n')
  for (const file of [entryFixture, ...additionalFixtures]) await fs.copyFile(
    path.join(repository, 'crabot-desktop/tests/fixtures', file), path.join(app, 'dist', file))
  await fs.writeFile(path.join(app, 'dist/desktop-release.json'), JSON.stringify(selection) + '\n')
  const require = createRequire(path.join(repository, 'crabot-desktop/package.json')), { build, Platform, Arch } = require('electron-builder')
  const builder = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib/package.json'))
  const payload = path.join(destination, 'offline')
  await fs.mkdir(payload)
  await fs.cp(original.coreRoot, path.join(payload, 'core'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  let resources
  await build({ projectDir: destination, publish: 'never', targets: Platform.current().createTarget('dir', Arch[process.arch]), config: {
    appId: 'com.crabot.desktop', productName: 'Crabot', electronVersion: '44.9.0',
    directories: { app, output: path.join(destination, 'unpacked') },
    electronDist: path.join(path.dirname(require.resolve('electron/package.json')), 'dist'),
    files: ['dist/**/*', 'package.json', '!**/*.map'], asar: true, asarUnpack: ['dist/bootstrap/**/*.node'], npmRebuild: false, publish: null,
    electronFuses: { runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: process.platform !== 'linux', onlyLoadAppFromAsar: true, grantFileProtocolExtraPrivileges: false },
    mac: { minimumSystemVersion: '14.0.0', identity: '-', hardenedRuntime: false, notarize: false }, win: { executableName: 'Crabot' }, linux: { executableName: 'crabot-desktop' },
    afterPack: async context => {
      resources = process.platform === 'darwin' ? path.join(context.appOutDir, 'Crabot.app/Contents/Resources') : path.join(context.appOutDir, 'resources')
      await fs.writeFile(path.join(resources, 'desktop-release.json'), JSON.stringify(selection) + '\n')
      const originalResources = path.join(original.guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
      const cleanup = 'crabot-copy-cleanup' + (process.platform === 'win32' ? '.exe' : '')
      for (const file of ['candidate-only.json', 'crabot.png', cleanup]) await fs.copyFile(path.join(originalResources, file), path.join(resources, file))
      if (process.platform === 'linux') for (const file of ['crabot-sandbox-helper', 'crabot-maintenance', 'browser-probe.py', 'crabot-maintenance-backend']) {
        await fs.cp(path.join(originalResources, file), path.join(resources, file), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
      }
    },
  } })
  assert.ok(resources)
  verifyDesktopAsar(builder('@electron/asar'), path.join(resources, 'app.asar'), process.platform, selection)
  const executable = process.platform === 'darwin' ? path.join(resources, '../MacOS/Crabot') : path.join(resources, process.platform === 'win32' ? '../Crabot.exe' : '../crabot-desktop')
  const { getCurrentFuseWire, FuseV1Options } = builder('@electron/fuses'), fuses = await getCurrentFuseWire(executable)
  for (const key of [FuseV1Options.RunAsNode, FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseV1Options.EnableNodeCliInspectArguments]) assert.equal(fuses[key], 48)
  assert.equal(fuses[FuseV1Options.OnlyLoadAppFromAsar], 49)
  assert.equal(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], process.platform === 'linux' ? 48 : 49)
  await fs.cp(path.resolve(resources, process.platform === 'darwin' ? '../../..' : '..'), path.join(payload, 'gui'),
    { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  await sealDesktopPayload(payload)
  return payload
}
