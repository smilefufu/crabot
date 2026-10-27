// CI-only wrapper: copy the already-built independent installer app and replace
// its entry with a dialog-input driver. The opaque target payload is unchanged.
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { verifyInstallerAsar } from '../../scripts/lib/desktop-asar.mjs'
export async function buildLegacyInstallerDriver({ repository, installer, destination, payload }) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.ok(['darwin', 'win32'].includes(process.platform))
  const app = path.join(destination, 'app'); await fs.mkdir(destination)
  await fs.cp(path.join(installer, 'app'), app, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  await fs.cp(path.join(installer, 'crabot-client'), path.join(destination, 'crabot-client'), { recursive: true, mode: constants.COPYFILE_FICLONE })
  const metadata = JSON.parse(await fs.readFile(path.join(app, 'package.json'), 'utf8'))
  assert.equal(metadata.main, 'dist/installer-main.js'); metadata.main = 'dist/legacy-installer-driver.cjs'
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify(metadata) + '\n')
  await fs.copyFile(path.join(repository, 'crabot-desktop/tests/fixtures/legacy-installer-driver.cjs'), path.join(app, metadata.main))
  const require = createRequire(path.join(repository, 'crabot-desktop/package.json')), { build, Platform, Arch } = require('electron-builder')
  const builder = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib/package.json'))
  let resources
  await build({ projectDir: destination, publish: 'never', targets: Platform.current().createTarget('dir', Arch[process.arch]), config: {
    appId: 'com.crabot.installer', productName: 'Crabot Installer', electronVersion: '44.9.0',
    directories: { app, output: path.join(destination, 'unpacked') }, electronDist: path.join(path.dirname(require.resolve('electron/package.json')), 'dist'),
    files: ['dist/**/*', 'package.json', '!**/*.map'], asar: true, asarUnpack: ['dist/bootstrap/**/*.node'], npmRebuild: false, publish: null,
    electronFuses: { runAsNode: false, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true, grantFileProtocolExtraPrivileges: false },
    mac: { identity: '-', minimumSystemVersion: '14.0.0', hardenedRuntime: false, notarize: false, signIgnore: ['/Resources/offline/'] }, win: { executableName: 'CrabotInstaller' },
    afterPack: async context => {
      resources = process.platform === 'darwin' ? path.join(context.appOutDir, 'Crabot Installer.app/Contents/Resources') : path.join(context.appOutDir, 'resources')
      await fs.cp(payload, path.join(resources, 'offline'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
    },
  } })
  assert.ok(resources); verifyInstallerAsar(builder('@electron/asar'), path.join(resources, 'app.asar'))
  return process.platform === 'darwin' ? path.resolve(resources, '../MacOS/Crabot Installer') : path.resolve(resources, '../CrabotInstaller.exe')
}
